"""Cloud and other OpenAI-compatible chat backends (docs/design/local-ai.md §9).

One adapter for every server speaking the OpenAI Chat Completions API: OpenAI itself,
OpenRouter, Z.ai (GLM), DeepSeek, OpenCode Zen, Groq, Mistral, LM Studio, vLLM... The routes
and the browser speak Ollama-shaped messages; this module translates them to the OpenAI shape
and the streamed Server-Sent Events back to the normalized events of `base.py`.

The models users may pick are the ones an admin chose for the connection (with their
capabilities), so the model list never needs the network. Stdlib sockets, as for Ollama: an
abort shuts the socket down so the provider stops generating (and billing).
"""

import contextlib
import http.client
import json
import logging
import socket
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from ..metrics import upstream
from .base import AiBadRequest, AiError, AiUnavailable, Event, ModelInfo

log = logging.getLogger(__name__)

PROVIDER_ID = "openai"
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_LINE_BYTES = 1024 * 1024
META_TIMEOUT_S = 15.0

Connect = Callable[[float], http.client.HTTPConnection]


class AiRateLimited(AiError):
    status = 429


@dataclass(frozen=True)
class CloudModel:
    """A model an admin enabled on a connection, with what it can do."""

    name: str
    vision: bool = False
    tools: bool = True
    #: Context window in tokens (sizes the chart brief); None = the connection's.
    context: int | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "vision": self.vision,
            "tools": self.tools,
            "context": self.context,
        }


def _error_text(raw: bytes) -> str:
    try:
        obj = json.loads(raw)
    except ValueError:
        obj = None
    err = obj.get("error") if isinstance(obj, dict) else None
    msg = err.get("message") if isinstance(err, dict) else err
    text = msg if isinstance(msg, str) and msg else raw.decode("utf-8", "replace")
    return text.strip()[:300] or "no details"


def _status_error(name: str, status: int, raw: bytes) -> AiError:
    text = _error_text(raw)
    if status in (401, 403):
        return AiError(f"{name} rejected the API key ({status}): {text}")
    if status == 404:
        return AiBadRequest(f"{name}: {text}")
    if status == 429:
        return AiRateLimited(f"{name} rate limit or quota reached: {text}")
    if status in (500, 502, 503, 504, 529):
        return AiUnavailable(f"{name} is unavailable ({status}): {text}")
    return AiError(f"{name} error {status}: {text}")


def _image_url(b64: str) -> str:
    mime = "image/png" if b64.startswith("iVBOR") else "image/jpeg"
    return f"data:{mime};base64,{b64}"


def to_openai(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Ollama-shaped messages (images as base64, tool calls without ids, tool results by name)
    in the OpenAI shape. Tool calls get ids `call_<n>`; each tool result answers the oldest
    unanswered call of the same name (the browser runs calls and sends results in order)."""
    out: list[dict[str, Any]] = []
    pending: list[tuple[str, str]] = []  # (id, name) not answered yet
    n = 0
    for msg in messages:
        role = msg["role"]
        content = msg.get("content") or ""
        if role == "tool":
            name = str(msg.get("tool_name") or "")
            idx = next((i for i, (_, nm) in enumerate(pending) if nm == name), 0 if pending else -1)
            if idx < 0:
                # A result without a call (should not happen): keep it as plain context.
                out.append({"role": "user", "content": f"[{name} result] {content}"})
                continue
            call_id, _ = pending.pop(idx)
            out.append({"role": "tool", "tool_call_id": call_id, "content": content})
            continue
        if role == "assistant" and msg.get("tool_calls"):
            calls = []
            for call in msg["tool_calls"]:
                fn = call.get("function") or {}
                n += 1
                call_id = f"call_{n}"
                pending.append((call_id, str(fn.get("name") or "")))
                calls.append(
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": fn.get("name") or "",
                            "arguments": json.dumps(fn.get("arguments") or {}),
                        },
                    }
                )
            out.append({"role": "assistant", "content": content or None, "tool_calls": calls})
            continue
        if msg.get("images"):
            parts: list[dict[str, Any]] = [{"type": "text", "text": content}]
            parts += [
                {"type": "image_url", "image_url": {"url": _image_url(img)}}
                for img in msg["images"]
            ]
            out.append({"role": role, "content": parts})
            continue
        out.append({"role": role, "content": content})
    return out


class _Calls:
    """Tool calls streamed in pieces (`index`, then name and argument fragments)."""

    def __init__(self) -> None:
        self._by_index: dict[int, dict[str, str]] = {}

    def add(self, raw: Any) -> None:
        for piece in raw if isinstance(raw, list) else []:
            if not isinstance(piece, dict):
                continue
            idx = piece.get("index")
            key = idx if isinstance(idx, int) else len(self._by_index)
            slot = self._by_index.setdefault(key, {"name": "", "arguments": ""})
            fn = piece.get("function") or {}
            if isinstance(fn, dict):
                if isinstance(fn.get("name"), str):
                    slot["name"] += fn["name"]
                args = fn.get("arguments")
                if isinstance(args, str):
                    slot["arguments"] += args
                elif isinstance(args, dict):
                    slot["arguments"] = json.dumps(args)

    def result(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for _, slot in sorted(self._by_index.items()):
            if not slot["name"]:
                continue
            try:
                args = json.loads(slot["arguments"]) if slot["arguments"].strip() else {}
            except ValueError:
                args = {}
            out.append({"name": slot["name"], "arguments": args if isinstance(args, dict) else {}})
        return out


def _content_events(content: Any) -> Iterator[Event]:
    """`delta.content`: a string, or (Mistral) a list of `{type: text|thinking}` chunks."""
    if isinstance(content, str):
        if content:
            yield {"t": "delta", "text": content}
        return
    for chunk in content if isinstance(content, list) else []:
        if not isinstance(chunk, dict):
            continue
        if chunk.get("type") == "thinking":
            inner = chunk.get("thinking")
            parts = inner if isinstance(inner, list) else [inner]
            for p in parts:
                text = p.get("text") if isinstance(p, dict) else p
                if isinstance(text, str) and text:
                    yield {"t": "thinking", "text": text}
        elif isinstance(chunk.get("text"), str) and chunk["text"]:
            yield {"t": "delta", "text": chunk["text"]}


class _Chat:
    """One streamed completion (Server-Sent Events); iterate once."""

    def __init__(
        self, name: str, conn: http.client.HTTPConnection, resp: http.client.HTTPResponse
    ) -> None:
        self._name = name
        self._conn = conn
        self._resp = resp
        self._sock = conn.sock
        self._aborted = False
        self._closed = False
        self._lock = threading.Lock()
        self._started = time.monotonic()

    def __iter__(self) -> Iterator[Event]:
        calls = _Calls()
        reason = "stop"
        usage: dict[str, Any] = {}
        try:
            while True:
                line = self._resp.readline(MAX_LINE_BYTES)
                if not line:
                    break  # some servers end without [DONE]
                text = line.decode("utf-8", "replace").strip()
                if not text.startswith("data:"):
                    continue  # comments (": keep-alive"), event names, blank lines
                data = text[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except ValueError:
                    raise AiError(f"{self._name} sent an unreadable stream") from None
                if not isinstance(obj, dict):
                    continue
                if obj.get("error"):
                    err = obj["error"]
                    msg = err.get("message") if isinstance(err, dict) else err
                    raise AiError(f"{self._name}: {str(msg)[:300]}")
                if isinstance(obj.get("usage"), dict):
                    usage = obj["usage"]
                for choice in obj.get("choices") or []:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta") or {}
                    if isinstance(delta, dict):
                        thinking = delta.get("reasoning_content") or delta.get("reasoning")
                        if isinstance(thinking, str) and thinking:
                            yield {"t": "thinking", "text": thinking}
                        yield from _content_events(delta.get("content"))
                        calls.add(delta.get("tool_calls"))
                    if choice.get("finish_reason"):
                        reason = str(choice["finish_reason"])
            upstream.record(PROVIDER_ID, "ok")
            found = calls.result()
            if found:
                yield {"t": "tool_calls", "calls": found}
            yield {
                "t": "done",
                "reason": "length" if reason == "length" else "stop",
                "promptTokens": usage.get("prompt_tokens"),
                "evalTokens": usage.get("completion_tokens"),
                "durationMs": int((time.monotonic() - self._started) * 1000),
            }
        except AiError:
            if not self._aborted:
                upstream.record(PROVIDER_ID, "error")
                raise
        except (OSError, http.client.HTTPException) as exc:
            if self._aborted:
                return
            upstream.record(PROVIDER_ID, "unavailable")
            if isinstance(exc, TimeoutError | socket.timeout):
                raise AiUnavailable(f"{self._name} stopped responding") from None
            raise AiUnavailable(f"Lost the connection to {self._name}") from None
        finally:
            self.close()

    def abort(self) -> None:
        with self._lock:
            if self._aborted or self._closed:
                return
            self._aborted = True
        if self._sock is not None:
            with contextlib.suppress(OSError):
                self._sock.shutdown(socket.SHUT_RDWR)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        with contextlib.suppress(OSError):
            self._conn.close()


class OpenAICompatBackend:
    """One connection: a base URL (`.../v1`), an API key and the enabled models.

    `list_models` names models `<connection id>/<model>` so several connections (and Ollama)
    can share one model picker; `open_chat` takes the provider's own model name."""

    id = PROVIDER_ID

    def __init__(
        self,
        conn_id: str,
        name: str,
        base_url: str,
        api_key: str | None,
        models: tuple[CloudModel, ...] = (),
        *,
        timeout_s: float,
        context: int = 128_000,
        max_tokens: int | None = None,
        cloud: bool = True,
        connect: Connect | None = None,
    ) -> None:
        parts = urlsplit(base_url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("base URL must be an http(s) URL with a host")
        self.conn_id = conn_id
        self.name = name
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._prefix = parts.path.rstrip("/")
        self._headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if api_key:
            self._headers["Authorization"] = f"Bearer {api_key}"
        self._models = models
        self._timeout_s = timeout_s
        self._context = context
        self._max_tokens = max_tokens
        self._cloud = cloud
        self._connect = connect or self._default_connect

    def _default_connect(self, timeout: float) -> http.client.HTTPConnection:
        if self._https:
            return http.client.HTTPSConnection(self._host, self._port, timeout=timeout)
        return http.client.HTTPConnection(self._host, self._port, timeout=timeout)

    def _open(
        self, method: str, path: str, body: Any, timeout: float
    ) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        conn = self._connect(timeout)
        connected = False
        try:
            conn.connect()
            connected = True
            data = json.dumps(body).encode() if body is not None else None
            headers = dict(self._headers)
            if body is not None and body.get("stream"):
                headers["Accept"] = "text/event-stream"
            conn.request(method, self._prefix + path, body=data, headers=headers)
            return conn, conn.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            upstream.record(PROVIDER_ID, "unavailable")
            if connected and isinstance(exc, TimeoutError | socket.timeout):
                raise AiUnavailable(
                    f"{self.name} did not start answering within {timeout:.0f} s"
                ) from None
            raise AiUnavailable(f"{self.name} is not reachable") from None

    def _read_error(
        self, conn: http.client.HTTPConnection, resp: http.client.HTTPResponse
    ) -> AiError:
        try:
            raw = resp.read(64 * 1024)
        except (OSError, http.client.HTTPException):
            raw = b""
        conn.close()
        err = _status_error(self.name, resp.status, raw)
        upstream.record(PROVIDER_ID, "unavailable" if err.status == 503 else "error")
        return err

    def available_models(self) -> list[str]:
        """Every model id the provider lists (`GET /models`), for the admin to choose from."""
        conn, resp = self._open("GET", "/models", None, META_TIMEOUT_S)
        if resp.status != 200:
            raise self._read_error(conn, resp)
        try:
            raw = resp.read(MAX_JSON_BYTES + 1)
        except (OSError, http.client.HTTPException):
            raise AiUnavailable(f"Lost the connection to {self.name}") from None
        finally:
            conn.close()
        if len(raw) > MAX_JSON_BYTES:
            raise AiError(f"{self.name} model list too large")
        try:
            obj = json.loads(raw)
        except ValueError:
            raise AiError(f"{self.name} sent an unreadable model list") from None
        items = obj.get("data") if isinstance(obj, dict) else obj
        names = sorted(
            {
                str(m.get("id"))
                for m in (items if isinstance(items, list) else [])
                if isinstance(m, dict) and m.get("id")
            },
            key=str.lower,
        )
        upstream.record(PROVIDER_ID, "ok")
        return names

    def list_models(self) -> list[ModelInfo]:
        return [
            ModelInfo(
                name=f"{self.conn_id}/{m.name}",
                vision=m.vision,
                tools=m.tools,
                cloud=self._cloud,
                connection=self.conn_id,
                context_tokens=m.context or self._context,
            )
            for m in self._models
        ]

    def open_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        num_ctx: int | None = None,
    ) -> _Chat:
        """`model` is the provider's name (without the connection prefix); `num_ctx` is
        ignored: the provider owns the context window."""
        body: dict[str, Any] = {
            "model": model,
            "messages": to_openai(messages),
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            body["tools"] = tools
        if self._max_tokens:
            body["max_tokens"] = self._max_tokens
        conn, resp = self._open("POST", "/chat/completions", body, self._timeout_s)
        if resp.status != 200:
            raise self._read_error(conn, resp)
        return _Chat(self.name, conn, resp)
