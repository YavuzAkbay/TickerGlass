"""Shared types of the AI backends (docs/design/local-ai.md).

A backend lists the chat models users may pick and opens one streamed chat. Both calls block
(stdlib sockets); the route runs them in the threadpool. A stream yields normalized events:

- `{"t": "delta", "text": str}`: a piece of the answer.
- `{"t": "thinking", "text": str}`: a piece of a reasoning model's thinking.
- `{"t": "tool_calls", "calls": [{"name": str, "arguments": dict}]}`: the model wants the
  browser to run chart tools (sent once, before `done`).
- `{"t": "done", "reason": str, "promptTokens": int|None, "evalTokens": int|None,
  "durationMs": int|None}`: the last event.

Failures raise `AiError` (before the stream starts, or from the iterator mid-stream).
"""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any, Protocol

Event = dict[str, Any]


class AiError(Exception):
    """The backend failed; `status` is the HTTP status the route answers with."""

    status = 502


class AiUnavailable(AiError):
    """The backend cannot be reached or stopped responding."""

    status = 503


class AiBadRequest(AiError):
    """The backend refused the request (e.g. an unknown model)."""

    status = 400


@dataclass(frozen=True)
class ModelInfo:
    name: str
    vision: bool
    #: Ollama tool calling ("tools" capability): the model may act on the chart.
    tools: bool = False
    #: As reported by the backend (`7.6B`), for display only.
    parameter_size: str | None = None
    size_bytes: int | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "vision": self.vision,
            "tools": self.tools,
            "parameterSize": self.parameter_size,
            "sizeBytes": self.size_bytes,
        }


class ChatStream(Protocol):
    def __iter__(self) -> Iterator[Event]: ...

    def abort(self) -> None:
        """Stop generating; safe to call from another thread and more than once."""
        ...


class AiBackend(Protocol):
    id: str

    def list_models(self) -> list[ModelInfo]: ...

    def open_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ChatStream:
        """Start a chat. `messages` are Ollama-shaped (`role`, `content`, optional `images`
        as base64 strings, `tool_calls`, `tool_name`), system prompt included; `tools` are
        Ollama function schemas."""
        ...
