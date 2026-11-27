"""Offline stand-in for Ollama (`AI_PROVIDER=demo`): canned, streamed replies that echo what
was received, so the UI can be tried and tested without a model."""

import json
import threading
from collections.abc import Iterator
from typing import Any

from .base import Event, ModelInfo

MODELS = [
    ModelInfo(name="demo-text", vision=False, tools=True, parameter_size="0B"),
    ModelInfo(name="demo-vision", vision=True, tools=True, parameter_size="0B"),
]


class _DemoChat:
    def __init__(
        self, text: str, delay_s: float, calls: list[dict[str, Any]] | None = None
    ) -> None:
        self._text = text
        self._delay_s = delay_s
        self._calls = calls or []
        self._stop = threading.Event()

    def __iter__(self) -> Iterator[Event]:
        if self._calls:
            yield {"t": "tool_calls", "calls": self._calls}
            yield {
                "t": "done",
                "reason": "stop",
                "promptTokens": None,
                "evalTokens": 0,
                "durationMs": None,
            }
            return
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
        question = question.rsplit("END CHART CONTEXT", 1)[-1].strip().removeprefix("Question:")
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

    def open_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        num_ctx: int | None = None,
    ) -> _DemoChat:
        if tools:
            scripted = _tool_script(messages, {t.get("function", {}).get("name") for t in tools})
            if scripted is not None:
                text, calls = scripted
                return _DemoChat(text, self._delay_s, calls)
        return _DemoChat(_reply(messages), self._delay_s)


def _tool_script(
    messages: list[dict[str, Any]], names: set[Any]
) -> tuple[str, list[dict[str, Any]]] | None:
    """Divergence questions: find_divergences, then draw_divergence for what was found, then
    a summary. None = no script (a plain reply)."""
    if not {"find_divergences", "draw_divergence"} <= names:
        return None
    convo = [m for m in messages if m["role"] != "system"]
    last = convo[-1] if convo else None
    if last is None:
        return None
    if last["role"] == "user":
        if "divergence" not in last["content"].lower():
            return None
        return "", [{"name": "find_divergences", "arguments": {"oscillator": "rsi"}}]
    if last["role"] == "tool" and last.get("tool_name") == "find_divergences":
        try:
            found = json.loads(last["content"]).get("divergences") or []
        except (ValueError, AttributeError):
            found = []
        ids = [d["id"] for d in found[:2] if isinstance(d, dict) and "id" in d]
        if ids:
            return "", [{"name": "draw_divergence", "arguments": {"id": i}} for i in ids]
        return "**Demo reply**: find_divergences found no divergences in this range.", []
    if last["role"] == "tool":
        drawn = sum(
            1 for m in convo if m["role"] == "tool" and m.get("tool_name") == "draw_divergence"
        )
        return (
            f"**Demo reply**: found divergences with find_divergences and drew {drawn} of them "
            "on the price and RSI panes. A real model would explain them here.",
            [],
        )
    return None
