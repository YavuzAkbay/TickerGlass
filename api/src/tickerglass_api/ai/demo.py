"""Offline stand-in for Ollama (`AI_PROVIDER=demo`): canned, streamed replies that echo what
was received, so the UI can be tried and tested without a model."""

import threading
from collections.abc import Iterator
from typing import Any

from .base import Event, ModelInfo

MODELS = [
    ModelInfo(name="demo-text", vision=False, parameter_size="0B"),
    ModelInfo(name="demo-vision", vision=True, parameter_size="0B"),
]


class _DemoChat:
    def __init__(self, text: str, delay_s: float) -> None:
        self._text = text
        self._delay_s = delay_s
        self._stop = threading.Event()

    def __iter__(self) -> Iterator[Event]:
        words = self._text.split(" ")
        for i, word in enumerate(words):
            if self._stop.wait(self._delay_s):
                return
            yield {"t": "delta", "text": word if i == 0 else f" {word}"}
        yield {
            "t": "done",
            "reason": "stop",
            "promptTokens": None,
            "evalTokens": len(words),
            "durationMs": None,
        }

    def abort(self) -> None:
        self._stop.set()


def _reply(messages: list[dict[str, Any]]) -> str:
    convo = [m for m in messages if m["role"] != "system"]
    question = convo[-1]["content"] if convo else ""
    if "CHART CONTEXT" in question:
        question = question.rsplit("END CHART CONTEXT", 1)[-1]
    question = " ".join(question.split())[:200] or "(empty)"
    context = next((m["content"] for m in reversed(convo) if "CHART CONTEXT" in m["content"]), "")
    header = next(
        (ln.strip() for ln in context.splitlines() if ln.strip().startswith("Symbol:")), None
    )
    images = sum(len(m.get("images") or []) for m in convo)
    lines = [
        "**Demo reply** (AI_PROVIDER=demo, no model ran).",
        f"You asked: _{question}_",
        f"Context: {len(context)} characters" + (f", {header}" if header else "") + ".",
        f"Images attached: {images}. Messages in the conversation: {len(convo)}.",
        "Set OLLAMA_URL to get real answers from a local model.",
    ]
    return "\n\n".join(lines)


class DemoBackend:
    id = "demo"

    def __init__(self, delay_s: float = 0.03) -> None:
        self._delay_s = delay_s

    def list_models(self) -> list[ModelInfo]:
        return list(MODELS)

    def open_chat(self, model: str, messages: list[dict[str, Any]]) -> _DemoChat:
        return _DemoChat(_reply(messages), self._delay_s)
