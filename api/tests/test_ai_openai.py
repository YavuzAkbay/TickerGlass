"""OpenAI-compatible cloud connections (tickerglass_api.ai.openai_compat, routes/ai.py)."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from openai_fake import FakeOpenAI, serve
from test_userdata import NullProvider

from tickerglass_api.ai.base import AiError
from tickerglass_api.ai.config import is_local_url
from tickerglass_api.ai.openai_compat import CloudModel, OpenAICompatBackend, to_openai
from tickerglass_api.app import create_app
from tickerglass_api.settings import Settings

KEY = "sk-test-1234"


@pytest.fixture
def fake() -> Iterator[FakeOpenAI]:
    with serve() as f:
        yield f


def make(tmp_path: Path) -> TestClient:
    settings = Settings(_env_file=None, database_url=f"sqlite:///{tmp_path}/ai.db")  # type: ignore[call-arg]
    return TestClient(create_app(provider=NullProvider(), settings_override=settings))  # type: ignore[arg-type]


def backend(fake: FakeOpenAI, key: str = KEY) -> OpenAICompatBackend:
    return OpenAICompatBackend(
        "oa", "OpenAI", fake.url, key, (CloudModel("gpt-test", vision=True),), timeout_s=5
    )


def test_to_openai_translates_tools_and_images() -> None:
    out = to_openai(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q", "images": ["iVBORxyz"]},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"function": {"name": "find_levels", "arguments": {}}},
                    {"function": {"name": "get_fundamentals", "arguments": {"a": 1}}},
                ],
            },
            {"role": "tool", "tool_name": "get_fundamentals", "content": "F"},
            {"role": "tool", "tool_name": "find_levels", "content": "L"},
        ]
    )
    assert out[1]["content"][1] == {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,iVBORxyz"},
    }
    calls = out[2]["tool_calls"]
    assert [c["id"] for c in calls] == ["call_1", "call_2"]
    assert json.loads(calls[1]["function"]["arguments"]) == {"a": 1}
    assert out[2]["content"] is None
    # Results answer the matching call by name, not by position.
    assert out[3] == {"role": "tool", "tool_call_id": "call_2", "content": "F"}
    assert out[4] == {"role": "tool", "tool_call_id": "call_1", "content": "L"}


def test_stream_events(fake: FakeOpenAI) -> None:
    evs = list(backend(fake).open_chat("gpt-test", [{"role": "user", "content": "q"}]))
    assert evs[0] == {"t": "thinking", "text": "hmm"}
    assert "".join(e["text"] for e in evs if e["t"] == "delta") == "Up trend."
    done = evs[-1]
    assert done["t"] == "done" and done["promptTokens"] == 100 and done["evalTokens"] == 2
    sent = fake.requests[-1]
    assert sent["path"] == "/v1/chat/completions"
    assert sent["headers"]["Authorization"] == f"Bearer {KEY}"
    assert sent["body"]["stream"] is True and sent["body"]["model"] == "gpt-test"


def test_stream_tool_call_fragments(fake: FakeOpenAI) -> None:
    fake.events = [
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "x",
                                "function": {"name": "draw", "arguments": '{"type": '},
                            }
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "function": {"arguments": '"fib-retracement"}'}}
                        ]
                    }
                }
            ]
        },
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 1, "function": {"name": "find_swings", "arguments": ""}}
                        ]
                    },
                    "finish_reason": "tool_calls",
                }
            ]
        },
        "[DONE]",
    ]
    evs = list(backend(fake).open_chat("gpt-test", [], tools=[{"type": "function"}]))
    assert evs[0] == {
        "t": "tool_calls",
        "calls": [
            {"name": "draw", "arguments": {"type": "fib-retracement"}},
            {"name": "find_swings", "arguments": {}},
        ],
    }
    assert evs[1]["reason"] == "stop"


def test_mistral_thinking_chunks(fake: FakeOpenAI) -> None:
    fake.events = [
        {
            "choices": [
                {
                    "delta": {
                        "content": [
                            {"type": "thinking", "thinking": [{"type": "text", "text": "a"}]},
                            {"type": "text", "text": "b"},
                        ]
                    }
                }
            ]
        },
        "[DONE]",
    ]
    evs = list(backend(fake).open_chat("m", []))
    assert evs[:2] == [{"t": "thinking", "text": "a"}, {"t": "delta", "text": "b"}]


def test_errors(fake: FakeOpenAI) -> None:
    with pytest.raises(AiError, match="rejected the API key"):
        backend(fake, key="wrong").available_models()
    fake.status = 429
    with pytest.raises(AiError, match="rate limit") as exc:
        backend(fake).open_chat("gpt-test", [])
    assert exc.value.status == 429


def test_list_models_namespaced(fake: FakeOpenAI) -> None:
    (m,) = backend(fake).list_models()
    assert m.name == "oa/gpt-test" and m.vision and m.connection == "oa"
    assert backend(fake).available_models() == ["glm-test", "gpt-test"]


def test_is_local_url() -> None:
    assert is_local_url("http://localhost:1234/v1")
    assert is_local_url("http://192.168.1.5:8000/v1")
    assert not is_local_url("https://api.openai.com/v1")


def _conn_body(fake: FakeOpenAI, **kw: Any) -> dict[str, Any]:
    return {
        "name": "OpenAI",
        "preset": "openai",
        "baseUrl": fake.url,
        "apiKey": KEY,
        "models": [{"name": "gpt-test", "vision": False, "tools": True}],
        **kw,
    }


def test_connection_routes(tmp_path: Path, fake: FakeOpenAI) -> None:
    with make(tmp_path) as c:
        # Testing lists the provider's models.
        r = c.post("/api/ai/connections/test", json={"baseUrl": fake.url, "apiKey": KEY}).json()
        assert r["ok"] and r["models"] == ["glm-test", "gpt-test"]
        view = c.put("/api/ai/connections/oa", json=_conn_body(fake)).json()
        (conn,) = view["connections"]
        # The key is never sent back.
        assert KEY not in json.dumps(view) and conn["keyHint"] == "••••1234"
        st = c.get("/api/ai/status").json()
        (m,) = st["models"]
        assert m["name"] == "oa/gpt-test" and m["tier"] == "standard"  # 127.0.0.1: not cloud
        # Updating without a key keeps the stored one; testing by id uses it.
        c.put("/api/ai/connections/oa", json=_conn_body(fake, apiKey=None))
        assert c.post("/api/ai/connections/test", json={"baseUrl": fake.url, "id": "oa"}).json()[
            "ok"
        ]
        # Chat goes to the provider with its own model name.
        r = c.post(
            "/api/ai/chat",
            json={"model": "oa/gpt-test", "messages": [{"role": "user", "content": "q"}]},
        )
        assert r.status_code == 200 and '"Up "' in r.text
        sent = fake.requests[-1]["body"]
        assert sent["model"] == "gpt-test" and sent["messages"][0]["role"] == "system"
        # Removing the last connection turns Ask AI off.
        assert c.delete("/api/ai/connections/oa").json()["connections"] == []
        assert c.get("/api/ai/status").json() == {"enabled": False}


def test_cloud_connection_needs_acknowledgement(tmp_path: Path) -> None:
    with make(tmp_path) as c:
        body = {"name": "OpenAI", "baseUrl": "https://api.openai.com/v1", "apiKey": KEY}
        r = c.put("/api/ai/connections/oa", json=body)
        assert r.status_code == 422 and "confirm" in r.json()["detail"]
        assert (
            c.put("/api/ai/connections/oa", json={**body, "acknowledged": True}).status_code == 200
        )
        assert c.put("/api/ai/connections/BAD id", json=body).status_code in (404, 422)


def test_eof_without_finish_is_a_dropped_connection(fake: FakeOpenAI) -> None:
    fake.events = [{"choices": [{"delta": {"content": "Up "}}]}]  # no finish_reason, no [DONE]
    got: list[Any] = []
    with pytest.raises(AiError, match="closed the stream early"):
        for ev in backend(fake).open_chat("gpt-test", []):
            got.append(ev)
    assert [e["t"] for e in got] == ["delta"]  # no `done` after a truncated answer


def test_eof_after_finish_without_done_marker_is_fine(fake: FakeOpenAI) -> None:
    fake.events = [{"choices": [{"delta": {"content": "Hi"}, "finish_reason": "stop"}]}]
    evs = list(backend(fake).open_chat("gpt-test", []))
    assert evs[-1]["t"] == "done" and evs[-1]["reason"] == "stop"


def test_to_openai_drops_unanswered_calls_and_orphan_results() -> None:
    call = lambda name: {"function": {"name": name, "arguments": {}}}  # noqa: E731
    out = to_openai(
        [
            {"role": "user", "content": "q"},
            # Two calls, only one answered: the other is dropped.
            {"role": "assistant", "content": "", "tool_calls": [call("a"), call("b")]},
            {"role": "tool", "tool_name": "b", "content": "B"},
            # Calls nobody answered and no text: the whole message goes.
            {"role": "assistant", "content": "", "tool_calls": [call("c")]},
            # Unanswered calls but some text: the text stays.
            {"role": "assistant", "content": "thinking", "tool_calls": [call("d")]},
            {"role": "user", "content": "again"},
            # A result nobody asked for.
            {"role": "tool", "tool_name": "zzz", "content": "Z"},
        ]
    )
    assert out == [
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_2",
                    "type": "function",
                    "function": {"name": "b", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_2", "content": "B"},
        {"role": "assistant", "content": "thinking"},
        {"role": "user", "content": "again"},
    ]


def test_connection_id_rejects_trailing_newline(tmp_path: Path, fake: FakeOpenAI) -> None:
    with make(tmp_path) as c:
        assert c.put("/api/ai/connections/oa%0A", json=_conn_body(fake)).status_code == 422
        assert c.put("/api/ai/connections/oa", json=_conn_body(fake)).status_code == 200
