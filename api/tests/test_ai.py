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

from tickerglass_api.ai import AiBadRequest, AiUnavailable, make_backend
from tickerglass_api.ai.ollama import OllamaBackend
from tickerglass_api.ai.prompt import SYSTEM_PROMPT
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
