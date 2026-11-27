"""Ask AI about the chart: settings, the Ollama client and the `/api/ai` routes."""

import base64
import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from ollama_fake import FakeOllama, serve
from pydantic import ValidationError
from test_userdata import NullProvider

from tickerglass_api.ai import AiBadRequest, AiUnavailable, ModelInfo, make_backend
from tickerglass_api.ai.ollama import OllamaBackend
from tickerglass_api.ai.prompt import SYSTEM_PROMPT, system_prompt
from tickerglass_api.ai.tiers import auto_tier, parse_billions, with_tiers
from tickerglass_api.app import create_app
from tickerglass_api.metrics import upstream
from tickerglass_api.settings import Settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
PNG_B64 = base64.b64encode(PNG).decode()


def make(tmp_path: Path, **kw: Any) -> TestClient:
    settings = Settings(_env_file=None, database_url=f"sqlite:///{tmp_path}/ai.db", **kw)  # type: ignore[call-arg]
    app = create_app(provider=NullProvider(), settings_override=settings)
    return TestClient(app)


def events(resp: Any) -> list[dict[str, Any]]:
    return [json.loads(line) for line in resp.text.splitlines() if line.strip()]


def ask(text: str = "What happened?", **kw: Any) -> dict[str, Any]:
    return {
        "model": kw.pop("model", "demo-text"),
        "messages": [{"role": "user", "content": text, **kw}],
    }


@pytest.fixture
def ollama() -> Iterator[FakeOllama]:
    with serve() as fake:
        yield fake


# --- settings ---------------------------------------------------------------------------


def test_settings_off_by_default() -> None:
    assert Settings(_env_file=None).ai_backend is None  # type: ignore[call-arg]


def test_settings_url_enables_ollama() -> None:
    s = Settings(_env_file=None, ollama_url="http://localhost:11434/", ai_models="a, b:7b,")  # type: ignore[call-arg]
    assert s.ai_backend == "ollama"
    assert s.ollama_url == "http://localhost:11434"
    assert s.ai_models == ["a", "b:7b"]


@pytest.mark.parametrize("url", ["ftp://x", "localhost:11434", "http://h/?q=1"])
def test_settings_rejects_bad_url(url: str) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ollama_url=url)  # type: ignore[call-arg]


def test_settings_blank_values_are_unset() -> None:
    s = Settings(  # type: ignore[call-arg]
        _env_file=None,
        ollama_url="",
        ai_provider="  ",
        ai_default_model="",
        ai_keep_alive="",
        ai_models="",
    )
    assert s.ai_backend is None
    assert s.ollama_url is None and s.ai_default_model is None and s.ai_keep_alive is None
    assert s.ai_models == []


def test_settings_blank_from_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("OLLAMA_URL", "AI_PROVIDER", "AI_MODELS", "AI_DEFAULT_MODEL", "AI_KEEP_ALIVE"):
        monkeypatch.setenv(name, "")
    assert Settings(_env_file=None).ai_backend is None  # type: ignore[call-arg]


def test_settings_ollama_needs_url() -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ai_provider="ollama")  # type: ignore[call-arg]


def test_settings_demo_without_url() -> None:
    assert Settings(_env_file=None, ai_provider="demo").ai_backend == "demo"  # type: ignore[call-arg]


# --- disabled / demo routes -------------------------------------------------------------


def test_disabled(tmp_path: Path) -> None:
    with make(tmp_path, ollama_url=None, ai_provider=None) as c:
        assert c.get("/api/ai/status").json() == {"enabled": False}
        assert c.post("/api/ai/chat", json=ask()).status_code == 404


def test_demo_status_and_chat(tmp_path: Path) -> None:
    with make(tmp_path, ai_provider="demo", ai_default_model="demo-vision") as c:
        st = c.get("/api/ai/status").json()
        assert st["enabled"] and st["reachable"] and st["provider"] == "demo"
        assert [m["name"] for m in st["models"]] == ["demo-text", "demo-vision"]
        assert st["defaultModel"] == "demo-vision"
        resp = c.post("/api/ai/chat", json=ask("Is this a breakout?"))
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        evs = events(resp)
        assert evs[-1]["t"] == "done"
        text = "".join(e["text"] for e in evs if e["t"] == "delta")
        assert "Is this a breakout?" in text


def test_demo_vision_image(tmp_path: Path) -> None:
    with make(tmp_path, ai_provider="demo") as c:
        resp = c.post("/api/ai/chat", json=ask(model="demo-vision", images=[PNG_B64]))
        assert resp.status_code == 200
        assert "Images attached: 1" in "".join(e.get("text", "") for e in events(resp))


@pytest.mark.parametrize(
    ("body", "status"),
    [
        (ask(model="nope"), 400),
        (ask(images=[PNG_B64]), 400),  # text-only model
        (ask(model="demo-vision", images=["not base64!"]), 422),
        (ask(model="demo-vision", images=[base64.b64encode(b"GIF89a....").decode()]), 422),
        ({"model": "demo-text", "messages": []}, 422),
        (
            {
                "model": "demo-text",
                "messages": [
                    {"role": "user", "content": "q"},
                    {"role": "assistant", "content": "a"},
                ],
            },
            422,
        ),
        ({"model": "demo-text", "messages": [{"role": "system", "content": "x"}]}, 422),
    ],
)
def test_chat_validation(tmp_path: Path, body: dict[str, Any], status: int) -> None:
    with make(tmp_path, ai_provider="demo") as c:
        assert c.post("/api/ai/chat", json=body).status_code == status


def test_chat_size_caps(tmp_path: Path) -> None:
    with make(tmp_path, ai_provider="demo", ai_max_chars=1000, ai_max_image_mb=0.0001) as c:
        assert c.post("/api/ai/chat", json=ask("x" * 1001)).status_code == 413
        big = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 200).decode()
        assert (
            c.post("/api/ai/chat", json=ask(model="demo-vision", images=[big])).status_code == 413
        )


def test_one_answer_at_a_time(tmp_path: Path) -> None:
    class Busy(set[str]):
        def __contains__(self, item: object) -> bool:
            return True

    with make(tmp_path, ai_provider="demo") as c:
        c.app.state.ai_active = Busy()  # type: ignore[attr-defined]
        assert c.post("/api/ai/chat", json=ask()).status_code == 429


def test_slot_released_after_answer(tmp_path: Path) -> None:
    with make(tmp_path, ai_provider="demo") as c:
        for _ in range(2):
            assert c.post("/api/ai/chat", json=ask()).status_code == 200
        assert not c.app.state.ai_active  # type: ignore[attr-defined]


# --- Ollama -----------------------------------------------------------------------------


def test_ollama_models(ollama: FakeOllama) -> None:
    models = OllamaBackend(ollama.url, timeout_s=5, num_ctx=8192).list_models()
    by_name = {m.name: m for m in models}
    assert sorted(by_name) == ["gemma3:4b", "llava:latest", "qwen2.5:7b"]  # embedding dropped
    assert by_name["gemma3:4b"].vision
    assert by_name["llava:latest"].vision  # old Ollama: from families
    assert not by_name["qwen2.5:7b"].vision
    assert by_name["qwen2.5:7b"].parameter_size == "7.6B"


def test_ollama_allowlist_and_cache(ollama: FakeOllama) -> None:
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=8192, allow=["llava", "qwen2.5:7b"])
    assert [m.name for m in backend.list_models()] == ["llava:latest", "qwen2.5:7b"]
    calls = len(ollama.requests)
    backend.list_models()
    assert len(ollama.requests) == calls  # cached


def test_ollama_prefix_and_basic_auth(ollama: FakeOllama) -> None:
    host = ollama.url.removeprefix("http://")
    OllamaBackend(f"http://u%40x:p%3Aw@{host}/ollama", timeout_s=5, num_ctx=1024).list_models()
    req = ollama.requests[0]
    assert req["path"] == "/ollama/api/tags"
    assert req["headers"]["Authorization"] == "Basic " + base64.b64encode(b"u@x:p:w").decode()


def test_ollama_chat_stream(ollama: FakeOllama) -> None:
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=4096, keep_alive="10m")
    evs = list(backend.open_chat("qwen2.5:7b", [{"role": "user", "content": "hi"}]))
    assert evs == [
        {"t": "delta", "text": "Up "},
        {"t": "delta", "text": "trend."},
        {"t": "done", "reason": "stop", "promptTokens": 120, "evalTokens": 2, "durationMs": 1500},
    ]
    body = ollama.requests[-1]["body"]
    assert body["stream"] is True
    assert body["options"] == {"num_ctx": 4096}
    assert body["keep_alive"] == "10m"


def test_ollama_thinking_and_error_line(ollama: FakeOllama) -> None:
    ollama.chat_lines = [
        {"message": {"role": "assistant", "content": "", "thinking": "hmm"}, "done": False},
        {"error": "out of memory"},
    ]
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=4096)
    it = iter(backend.open_chat("qwen2.5:7b", []))
    assert next(it) == {"t": "thinking", "text": "hmm"}
    with pytest.raises(Exception, match="out of memory"):
        next(it)


def test_ollama_stream_cut_short(ollama: FakeOllama) -> None:
    ollama.chat_lines = ollama.chat_lines[:1]
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=4096)
    with pytest.raises(AiUnavailable):
        list(backend.open_chat("qwen2.5:7b", []))


def test_ollama_unknown_model(ollama: FakeOllama) -> None:
    ollama.chat_status = 404
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=4096)
    with pytest.raises(AiBadRequest, match="not found"):
        backend.open_chat("x", [])


def test_ollama_unreachable() -> None:
    before = upstream.snapshot().get(("ollama", "unavailable"), 0)
    backend = OllamaBackend("http://127.0.0.1:9", timeout_s=1, num_ctx=4096)
    with pytest.raises(AiUnavailable, match="not reachable"):
        backend.list_models()
    assert upstream.snapshot()[("ollama", "unavailable")] == before + 1


def test_ollama_abort_stops_stream(ollama: FakeOllama) -> None:
    ollama.chat_lines = [{"message": {"role": "assistant", "content": "x"}, "done": False}] * 200
    ollama.line_delay_s = 0.02
    stream = OllamaBackend(ollama.url, timeout_s=5, num_ctx=4096).open_chat("qwen2.5:7b", [])
    got: list[Any] = []
    t = threading.Thread(target=lambda: got.extend(stream))
    t.start()
    time.sleep(0.15)
    stream.abort()
    t.join(2)
    assert not t.is_alive()
    assert 0 < len(got) < 200
    assert ollama.disconnected.wait(2)


def test_route_with_ollama(tmp_path: Path, ollama: FakeOllama) -> None:
    with make(tmp_path, ollama_url=ollama.url) as c:
        st = c.get("/api/ai/status").json()
        assert st["provider"] == "ollama" and st["reachable"]
        assert st["defaultModel"] == "gemma3:4b"
        resp = c.post("/api/ai/chat", json=ask(model="qwen2.5:7b"))
        assert [e["t"] for e in events(resp)] == ["delta", "delta", "done"]
        sent = ollama.requests[-1]["body"]["messages"]
        assert sent[0] == {"role": "system", "content": SYSTEM_PROMPT}
        assert sent[1] == {"role": "user", "content": "What happened?"}
        # image goes through to a vision model, canonical base64
        resp = c.post("/api/ai/chat", json=ask(model="gemma3:4b", images=[PNG_B64]))
        assert resp.status_code == 200
        assert ollama.requests[-1]["body"]["messages"][1]["images"] == [PNG_B64]


def test_route_stream_error_event(tmp_path: Path, ollama: FakeOllama) -> None:
    ollama.chat_lines = [{"error": "model crashed"}]
    with make(tmp_path, ollama_url=ollama.url) as c:
        evs = events(c.post("/api/ai/chat", json=ask(model="qwen2.5:7b")))
        assert evs == [{"t": "error", "message": "Ollama: model crashed"}]
        assert not c.app.state.ai_active  # type: ignore[attr-defined]


def test_route_ollama_down(tmp_path: Path) -> None:
    with make(tmp_path, ollama_url="http://127.0.0.1:9") as c:
        st = c.get("/api/ai/status").json()
        assert st["enabled"] and not st["reachable"] and st["models"] == []
        assert "not reachable" in st["error"]
        assert c.post("/api/ai/chat", json=ask(model="qwen2.5:7b")).status_code == 503


def test_make_backend_demo() -> None:
    backend = make_backend(Settings(_env_file=None, ai_provider="demo"))  # type: ignore[call-arg]
    assert backend is not None and backend.id == "demo"


# --- in-app set-up (Settings → AI) -------------------------------------------------------


def test_config_off_by_default(tmp_path: Path) -> None:
    with make(tmp_path) as c:
        assert c.get("/api/ai/config").json() == {
            "source": "off",
            "locked": False,
            "provider": None,
            "url": None,
            "models": [],
            "defaultModel": None,
            "numCtx": 16384,
            "tiers": {},
        }


def test_config_connect_persist_and_turn_off(tmp_path: Path, ollama: FakeOllama) -> None:
    with make(tmp_path) as c:
        r = c.put(
            "/api/ai/config",
            json={
                "url": ollama.url + "/",
                "models": ["qwen2.5:7b", "gemma3:4b"],
                "defaultModel": "qwen2.5:7b",
            },
        )
        assert r.status_code == 200
        assert r.json()["source"] == "app" and r.json()["url"] == ollama.url
        st = c.get("/api/ai/status").json()
        assert st["enabled"] and st["provider"] == "ollama"
        assert [m["name"] for m in st["models"]] == ["gemma3:4b", "qwen2.5:7b"]  # allow-list
        assert st["defaultModel"] == "qwen2.5:7b"
        assert c.post("/api/ai/chat", json=ask(model="qwen2.5:7b")).status_code == 200
    # A restart reads it back from the database.
    with make(tmp_path) as c:
        assert c.get("/api/ai/status").json()["enabled"]
        assert c.put("/api/ai/config", json={"url": None}).json()["source"] == "off"
        assert c.get("/api/ai/status").json() == {"enabled": False}
    with make(tmp_path) as c:
        assert c.get("/api/ai/status").json() == {"enabled": False}


def test_config_rejects_bad_url(tmp_path: Path) -> None:
    with make(tmp_path) as c:
        r = c.put("/api/ai/config", json={"url": "ftp://x"})
        assert r.status_code == 422
        assert "http(s)" in r.json()["detail"]


def test_config_locked_by_environment(tmp_path: Path) -> None:
    with make(tmp_path, ollama_url="http://u:secret@10.0.0.5:11434") as c:
        view = c.get("/api/ai/config").json()
        assert view["locked"] and view["source"] == "env"
        assert view["url"] == "http://u:***@10.0.0.5:11434"
        assert c.put("/api/ai/config", json={"url": "http://x:1"}).status_code == 409


def test_config_admin_only(multi: Any) -> None:
    alice = multi.users["alice"]
    assert alice.get("/api/ai/config").status_code == 403
    assert alice.put("/api/ai/config", json={"url": None}).status_code == 403
    assert alice.post("/api/ai/test", json={}).status_code == 403
    assert alice.get("/api/ai/status").status_code == 200


def test_test_connection(tmp_path: Path, ollama: FakeOllama) -> None:
    with make(tmp_path) as c:
        r = c.post("/api/ai/test", json={"url": ollama.url.removeprefix("http://")}).json()
        assert r["ok"] and r["url"] == ollama.url
        assert [m["name"] for m in r["models"]] == ["gemma3:4b", "llava:latest", "qwen2.5:7b"]
        r = c.post("/api/ai/test", json={"url": "http://127.0.0.1:9"}).json()
        assert not r["ok"] and "not reachable" in r["error"]


def test_detect(tmp_path: Path, ollama: FakeOllama, monkeypatch: pytest.MonkeyPatch) -> None:
    from tickerglass_api.ai import config

    monkeypatch.setattr(config, "CANDIDATE_URLS", ("http://127.0.0.1:9", ollama.url))
    with make(tmp_path) as c:
        r = c.post("/api/ai/test", json={}).json()
        assert r["ok"] and r["url"] == ollama.url
    monkeypatch.setattr(config, "CANDIDATE_URLS", ("http://127.0.0.1:9",))
    with make(tmp_path) as c:
        r = c.post("/api/ai/test", json={}).json()
        assert not r["ok"] and r["tried"][0]["url"] == "http://127.0.0.1:9"


def test_new_model_shows_at_once(ollama: FakeOllama, monkeypatch: pytest.MonkeyPatch) -> None:
    from tickerglass_api.ai import ollama as ollama_mod

    monkeypatch.setattr(ollama_mod, "MODELS_TTL_S", 0)
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=8192)
    assert len(backend.list_models()) == 3
    shows = sum(r["path"] == "/api/show" for r in ollama.requests)
    ollama.models.append({"name": "phi4:latest", "size": 1, "details": {}})
    ollama.capabilities["phi4:latest"] = ["completion"]
    assert "phi4:latest" in [m.name for m in backend.list_models()]
    # Only the new model was described again.
    assert sum(r["path"] == "/api/show" for r in ollama.requests) == shows + 1


# --- chart tools (Ollama tool calling) ----------------------------------------------------

TOOL = {
    "type": "function",
    "function": {
        "name": "find_divergences",
        "description": "Find divergences",
        "parameters": {"type": "object", "properties": {"oscillator": {"type": "string"}}},
    },
}


def test_tools_capability(ollama: FakeOllama) -> None:
    by_name = {
        m.name: m for m in OllamaBackend(ollama.url, timeout_s=5, num_ctx=1024).list_models()
    }
    assert by_name["qwen2.5:7b"].tools and not by_name["gemma3:4b"].tools


def test_tool_calls_event(ollama: FakeOllama) -> None:
    ollama.chat_lines = [
        {
            "message": {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"function": {"name": "find_divergences", "arguments": {"oscillator": "rsi"}}},
                    {"function": {"name": "draw_divergence", "arguments": '{"id": "d1"}'}},
                    {"function": {"arguments": {}}},  # nameless: dropped
                ],
            },
            "done": False,
        },
        {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop"},
    ]
    backend = OllamaBackend(ollama.url, timeout_s=5, num_ctx=1024)
    evs = list(backend.open_chat("qwen2.5:7b", [], tools=[TOOL]))
    assert evs[0] == {
        "t": "tool_calls",
        "calls": [
            {"name": "find_divergences", "arguments": {"oscillator": "rsi"}},
            {"name": "draw_divergence", "arguments": {"id": "d1"}},
        ],
    }
    assert evs[1]["t"] == "done"
    assert ollama.requests[-1]["body"]["tools"] == [TOOL]


def test_route_tools(tmp_path: Path, ollama: FakeOllama) -> None:
    with make(tmp_path, ollama_url=ollama.url) as c:
        body = {
            "model": "qwen2.5:7b",
            "tools": [TOOL],
            "messages": [
                {"role": "user", "content": "find divergences"},
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {"name": "find_divergences", "arguments": {"oscillator": "rsi"}}
                    ],
                },
                {"role": "tool", "tool_name": "find_divergences", "content": '{"divergences": []}'},
            ],
        }
        assert c.post("/api/ai/chat", json=body).status_code == 200
        sent = ollama.requests[-1]["body"]
        assert sent["tools"] == [TOOL]
        assert "## Working on the chart" in sent["messages"][0]["content"]
        assert sent["messages"][2]["tool_calls"] == [
            {"function": {"name": "find_divergences", "arguments": {"oscillator": "rsi"}}}
        ]
        assert sent["messages"][3] == {
            "role": "tool",
            "content": '{"divergences": []}',
            "tool_name": "find_divergences",
        }
        # No tools: plain prompt, no tools key.
        c.post("/api/ai/chat", json=ask(model="qwen2.5:7b"))
        sent = ollama.requests[-1]["body"]
        assert (
            "tools" not in sent and "## Working on the chart" not in sent["messages"][0]["content"]
        )
        # A model without the capability refuses tools.
        r = c.post("/api/ai/chat", json={**body, "model": "gemma3:4b"})
        assert r.status_code == 400 and "chart tools" in r.json()["detail"]


def test_demo_tool_script(tmp_path: Path) -> None:
    tools = [
        {"type": "function", "function": {"name": n}}
        for n in ("find_divergences", "draw_divergence")
    ]
    with make(tmp_path, ai_provider="demo") as c:
        q = {"role": "user", "content": "Find RSI divergences"}
        evs = events(
            c.post("/api/ai/chat", json={"model": "demo-text", "tools": tools, "messages": [q]})
        )
        assert evs[0] == {
            "t": "tool_calls",
            "calls": [{"name": "find_divergences", "arguments": {"oscillator": "rsi"}}],
        }
        found = {"divergences": [{"id": "d1"}, {"id": "d2"}, {"id": "d3"}]}
        msgs = [
            q,
            {"role": "assistant", "content": "", "tool_calls": evs[0]["calls"]},
            {"role": "tool", "tool_name": "find_divergences", "content": json.dumps(found)},
        ]
        evs = events(
            c.post("/api/ai/chat", json={"model": "demo-text", "tools": tools, "messages": msgs})
        )
        assert [x["arguments"]["id"] for x in evs[0]["calls"]] == ["d1", "d2"]
        msgs += [
            {"role": "assistant", "content": "", "tool_calls": evs[0]["calls"]},
            {"role": "tool", "tool_name": "draw_divergence", "content": "{}"},
            {"role": "tool", "tool_name": "draw_divergence", "content": "{}"},
        ]
        evs = events(
            c.post("/api/ai/chat", json={"model": "demo-text", "tools": tools, "messages": msgs})
        )
        text = "".join(e.get("text", "") for e in evs)
        assert "drew 2" in text and evs[-1]["t"] == "done"


def test_per_request_context_window(tmp_path: Path, ollama: FakeOllama) -> None:
    with make(tmp_path, ollama_url=ollama.url) as c:
        c.post("/api/ai/chat", json=ask(model="qwen2.5:7b"))
        assert ollama.requests[-1]["body"]["options"] == {"num_ctx": 16384}
        c.post("/api/ai/chat", json={**ask(model="qwen2.5:7b"), "numCtx": 65536})
        assert ollama.requests[-1]["body"]["options"] == {"num_ctx": 65536}
        assert (
            c.post("/api/ai/chat", json={**ask(model="qwen2.5:7b"), "numCtx": 100}).status_code
            == 422
        )


def test_slow_first_token_is_not_unreachable(ollama: FakeOllama) -> None:
    ollama.header_delay_s = 1.5
    backend = OllamaBackend(ollama.url, timeout_s=0.5, num_ctx=1024)
    with pytest.raises(AiUnavailable, match="did not start answering within"):
        list(backend.open_chat("qwen2.5:7b", []))


# --- capability tiers ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("size", "billions"),
    [("26.1B", 26.1), ("671B", 671.0), ("8x7B", 56.0), ("567M", 0.567), ("0B", None), (None, None)],
)
def test_parse_billions(size: str | None, billions: float | None) -> None:
    got = parse_billions(size)
    assert got == pytest.approx(billions) if billions is not None else got is None


def test_auto_tier() -> None:
    assert auto_tier("7.6B") == "basic"
    assert auto_tier("26.1B") == "standard"
    assert auto_tier(None) == "standard"
    assert auto_tier("355B") == "full"
    assert auto_tier("7B", cloud=True) == "full"


def test_with_tiers_override() -> None:
    models = [ModelInfo("a", False, True, "7B"), ModelInfo("b", False, True, "70B")]
    got = {m.name: m.tier for m in with_tiers(models, {"a": "full", "b": "bogus"})}
    assert got == {"a": "full", "b": "full"}


def test_tier_prompts() -> None:
    assert "## Working on the chart" in system_prompt(True, "basic")
    relaxed = system_prompt(True, "standard")
    assert "General knowledge" in relaxed and "not financial advice" in relaxed
    assert "set_chart" not in relaxed and "set_chart" in system_prompt(True, "full")


def _tool(name: str) -> dict[str, Any]:
    return {**TOOL, "function": {**TOOL["function"], "name": name}}  # type: ignore[dict-item]


def test_route_enforces_tier_tools(tmp_path: Path, ollama: FakeOllama) -> None:
    with make(tmp_path, ollama_url=ollama.url) as c:
        st = c.get("/api/ai/status").json()
        assert {m["name"]: m["tier"] for m in st["models"]}["qwen2.5:7b"] == "basic"
        q = {"role": "user", "content": "fib"}
        r = c.post(
            "/api/ai/chat", json={"model": "qwen2.5:7b", "tools": [_tool("draw")], "messages": [q]}
        )
        assert r.status_code == 400 and "draw" in r.json()["detail"]


def test_route_standard_tier(tmp_path: Path) -> None:
    with make(tmp_path, ai_provider="demo") as c:  # demo: unknown size -> standard
        q = {"role": "user", "content": "fib"}
        ok = c.post(
            "/api/ai/chat", json={"model": "demo-text", "tools": [_tool("draw")], "messages": [q]}
        )
        assert ok.status_code == 200
        r = c.post(
            "/api/ai/chat",
            json={"model": "demo-text", "tools": [_tool("set_chart")], "messages": [q]},
        )
        assert r.status_code == 400 and "set_chart" in r.json()["detail"]
