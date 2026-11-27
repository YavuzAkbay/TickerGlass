"""Ollama client (docs/design/local-ai.md §2): model list and streamed `/api/chat`.

Plain `http.client` so a stream can be cut from another thread (`abort` shuts the socket down,
which also makes Ollama stop generating). `OLLAMA_URL` is operator-set and trusted, so private
and loopback hosts are allowed; redirects are never followed (`http.client` does not follow
them, a 3xx is an error). Userinfo in the URL becomes a Basic `Authorization` header and a
path prefix is kept (Ollama behind a reverse proxy).
"""

import base64
import contextlib
import http.client
import json
import logging
import socket
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any
from urllib.parse import unquote, urlsplit

from ..metrics import upstream
from .base import AiBadRequest, AiError, AiUnavailable, Event, ModelInfo

log = logging.getLogger(__name__)

PROVIDER_ID = "ollama"
#: Largest non-streamed response body (`/api/tags`, `/api/show`) read.
MAX_JSON_BYTES = 8 * 1024 * 1024
#: Longest single NDJSON line of a chat stream.
MAX_LINE_BYTES = 1024 * 1024
#: Seconds for the small metadata calls (`/api/tags`, `/api/show`).
META_TIMEOUT_S = 10.0
#: Seconds a model list is reused (only to merge bursts: a freshly pulled model shows at once).
MODELS_TTL_S = 2.0
#: Families that mark a vision model on Ollama versions without `capabilities`.
_VISION_FAMILIES = {"clip", "mllama"}

Connect = Callable[[float], http.client.HTTPConnection]


def _normalize(name: str) -> str:
    """`llama3` and `llama3:latest` are the same model."""
    return name if ":" in name else f"{name}:latest"


def _error_text(raw: bytes) -> str:
    try:
        msg = json.loads(raw).get("error")
    except (ValueError, AttributeError):
        msg = None
    text = msg if isinstance(msg, str) and msg else raw.decode("utf-8", "replace")
    return text.strip()[:300] or "no details"


def _status_error(status: int, raw: bytes) -> AiError:
    text = _error_text(raw)
    if status == 404:
        return AiBadRequest(text)  # unknown model
    if status in (502, 503, 504):
        return AiUnavailable(f"Ollama is unavailable ({status}): {text}")
    return AiError(f"Ollama error {status}: {text}")


def _tool_calls(raw: Any) -> list[dict[str, Any]]:
    """Ollama `message.tool_calls` as `{name, arguments}` (arguments may be a JSON string)."""
    out: list[dict[str, Any]] = []
    for call in raw if isinstance(raw, list) else []:
        fn = call.get("function") if isinstance(call, dict) else None
        if not isinstance(fn, dict) or not isinstance(fn.get("name"), str):
            continue
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = {}
        out.append({"name": fn["name"], "arguments": args if isinstance(args, dict) else {}})
    return out


class _Chat:
    """One streamed chat response; iterate once."""

    def __init__(self, conn: http.client.HTTPConnection, resp: http.client.HTTPResponse) -> None:
        self._conn = conn
        self._resp = resp
        self._sock = conn.sock
        self._aborted = False
        self._closed = False
        self._lock = threading.Lock()

    def __iter__(self) -> Iterator[Event]:
        calls: list[dict[str, Any]] = []
        try:
            while True:
                line = self._resp.readline(MAX_LINE_BYTES)
                if not line:
                    raise AiUnavailable("Ollama closed the stream early")
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    raise AiError("Ollama sent an unreadable stream") from None
                if not isinstance(obj, dict):
                    continue
                if obj.get("error"):
                    raise AiError(f"Ollama: {str(obj['error'])[:300]}")
                msg = obj.get("message") or {}
                if isinstance(msg, dict):
                    if msg.get("thinking"):
                        yield {"t": "thinking", "text": str(msg["thinking"])}
                    if msg.get("content"):
                        yield {"t": "delta", "text": str(msg["content"])}
                    calls.extend(_tool_calls(msg.get("tool_calls")))
                if obj.get("done"):
                    upstream.record(PROVIDER_ID, "ok")
                    if calls:
                        yield {"t": "tool_calls", "calls": calls}
                    total = obj.get("total_duration")
                    yield {
                        "t": "done",
                        "reason": str(obj.get("done_reason") or "stop"),
                        "promptTokens": obj.get("prompt_eval_count"),
                        "evalTokens": obj.get("eval_count"),
                        "durationMs": int(total / 1e6) if isinstance(total, int | float) else None,
                    }
                    return
        except AiError as exc:
            if not self._aborted:
                upstream.record(PROVIDER_ID, "unavailable" if exc.status == 503 else "error")
                raise
        except (OSError, http.client.HTTPException) as exc:
            if self._aborted:
                return
            upstream.record(PROVIDER_ID, "unavailable")
            if isinstance(exc, TimeoutError | socket.timeout):
                raise AiUnavailable("Ollama stopped responding") from None
            raise AiUnavailable("Lost the connection to Ollama") from None
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


class OllamaBackend:
    id = PROVIDER_ID

    def __init__(
        self,
        url: str,
        *,
        timeout_s: float,
        num_ctx: int,
        keep_alive: str | None = None,
        allow: list[str] | None = None,
        connect: Connect | None = None,
        meta_timeout_s: float = META_TIMEOUT_S,
    ) -> None:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("OLLAMA_URL must be an http(s) URL with a host")
        self._https = parts.scheme == "https"
        self._host = parts.hostname
        self._port = parts.port
        self._prefix = parts.path.rstrip("/")
        self._headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if parts.username is not None:
            token = f"{unquote(parts.username)}:{unquote(parts.password or '')}"
            self._headers["Authorization"] = "Basic " + base64.b64encode(token.encode()).decode()
        self._timeout_s = timeout_s
        self._num_ctx = num_ctx
        self._keep_alive = keep_alive
        self._allow = {_normalize(n) for n in allow or []}
        self._connect = connect or self._default_connect
        self._meta_timeout_s = meta_timeout_s
        self._models: tuple[float, list[ModelInfo]] | None = None
        #: `/api/show` answers per (name, digest): a model's capabilities never change.
        self._described: dict[tuple[str, str], ModelInfo | None] = {}
        self._models_lock = threading.Lock()

    def _default_connect(self, timeout: float) -> http.client.HTTPConnection:
        if self._https:
            return http.client.HTTPSConnection(self._host, self._port, timeout=timeout)
        return http.client.HTTPConnection(self._host, self._port, timeout=timeout)

    def _open(
        self, method: str, path: str, body: Any, timeout: float
    ) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        conn = self._connect(timeout)
        try:
            conn.connect()
            data = json.dumps(body).encode() if body is not None else None
            conn.request(method, self._prefix + path, body=data, headers=self._headers)
            return conn, conn.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            upstream.record(PROVIDER_ID, "unavailable")
            if isinstance(exc, TimeoutError | socket.timeout) and conn.sock is not None:
                raise AiUnavailable("Ollama did not answer in time") from None
            raise AiUnavailable("Ollama is not reachable") from None

    def _json(self, method: str, path: str, body: Any = None) -> Any:
        conn, resp = self._open(method, path, body, self._meta_timeout_s)
        try:
            raw = resp.read(MAX_JSON_BYTES + 1)
        except (OSError, http.client.HTTPException):
            upstream.record(PROVIDER_ID, "unavailable")
            raise AiUnavailable("Lost the connection to Ollama") from None
        finally:
            conn.close()
        if resp.status != 200:
            err = _status_error(resp.status, raw)
            upstream.record(PROVIDER_ID, "unavailable" if err.status == 503 else "error")
            raise err
        if len(raw) > MAX_JSON_BYTES:
            raise AiError("Ollama response too large")
        try:
            data = json.loads(raw)
        except ValueError:
            upstream.record(PROVIDER_ID, "error")
            raise AiError("Ollama sent an unreadable response") from None
        upstream.record(PROVIDER_ID, "ok")
        return data

    def _describe(self, tag: dict[str, Any]) -> ModelInfo | None:
        name = str(tag.get("name") or tag.get("model") or "")
        if not name:
            return None
        raw_details = tag.get("details")
        details: dict[str, Any] = raw_details if isinstance(raw_details, dict) else {}
        vision = bool(_VISION_FAMILIES & set(details.get("families") or []))
        tools = False
        try:
            show = self._json("POST", "/api/show", {"model": name})
        except AiError:
            show = None
        caps = show.get("capabilities") if isinstance(show, dict) else None
        if isinstance(caps, list):
            if "completion" not in caps:
                return None  # embedding-only model
            vision = "vision" in caps
            tools = "tools" in caps
        size = tag.get("size")
        return ModelInfo(
            name=name,
            vision=vision,
            tools=tools,
            parameter_size=details.get("parameter_size") or None,
            size_bytes=size if isinstance(size, int) else None,
        )

    def list_models(self) -> list[ModelInfo]:
        with self._models_lock:
            if self._models and time.monotonic() - self._models[0] < MODELS_TTL_S:
                return self._models[1]
            data = self._json("GET", "/api/tags")
            tags = data.get("models") if isinstance(data, dict) else None
            models: list[ModelInfo] = []
            for tag in tags if isinstance(tags, list) else []:
                if not isinstance(tag, dict):
                    continue
                name = str(tag.get("name") or tag.get("model") or "")
                if self._allow and _normalize(name) not in self._allow:
                    continue
                key = (name, str(tag.get("digest") or tag.get("modified_at") or ""))
                if key not in self._described:
                    self._described[key] = self._describe(tag)
                info = self._described[key]
                if info is not None:
                    models.append(info)
            models.sort(key=lambda m: m.name.lower())
            self._models = (time.monotonic(), models)
            return models

    def open_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        num_ctx: int | None = None,
    ) -> _Chat:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": True,
            "options": {"num_ctx": num_ctx or self._num_ctx},
        }
        if tools:
            body["tools"] = tools
        if self._keep_alive:
            body["keep_alive"] = self._keep_alive
        conn, resp = self._open("POST", "/api/chat", body, self._timeout_s)
        if resp.status != 200:
            try:
                raw = resp.read(64 * 1024)
            except (OSError, http.client.HTTPException):
                raw = b""
            conn.close()
            err = _status_error(resp.status, raw)
            upstream.record(PROVIDER_ID, "unavailable" if err.status == 503 else "error")
            raise err
        return _Chat(conn, resp)
