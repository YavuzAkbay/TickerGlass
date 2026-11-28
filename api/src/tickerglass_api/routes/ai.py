"""Ask AI about the chart (docs/design/local-ai.md): model list and a streamed chat proxied
to Ollama. The browser sends the chart brief as message text (and optionally a chart image);
the server adds the system prompt, enforces limits and streams the answer back as NDJSON.
"""

import base64
import binascii
import json
import logging
import re
import threading
import time
from collections import defaultdict, deque
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from ..ai import AiBackend, AiError, ModelInfo
from ..ai.base import ChatStream
from ..ai.config import (
    MAX_CONNECTIONS,
    MAX_MODELS,
    NUM_CTX_MAX,
    NUM_CTX_MIN,
    PRESETS,
    AiConfig,
    AiRuntime,
    CloudConnection,
    cloud_backend,
    detect,
    env_locked,
    is_local_url,
    load_config,
    normalize_url,
    probe,
    redact_url,
    resolve,
    same_origin,
    save_config,
)
from ..ai.multi import MultiBackend
from ..ai.openai_compat import CloudModel
from ..ai.prompt import assemble
from ..ai.tiers import TIER_TOOLS, Tier, tool_names, with_tiers
from ..deps import AdminDep, SettingsDep, UserDep

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ai", tags=["ai"])

#: Messages per request (tool rounds add an assistant and a tool message each).
MAX_MESSAGES = 80
MAX_TOOLS = 40
MAX_TOOLS_JSON = 128 * 1024
MAX_IMAGES_PER_MESSAGE = 2
_IMAGE_MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")


class ToolCall(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "tool"]
    content: str = Field(max_length=2_000_000)
    #: Base64 PNG/JPEG (no `data:` prefix); only for vision models.
    images: list[str] = Field(default_factory=list, max_length=MAX_IMAGES_PER_MESSAGE)
    #: Assistant: the chart tools it asked for.
    tool_calls: list[ToolCall] | None = Field(default=None, max_length=MAX_TOOLS)
    #: Tool: which tool this result belongs to.
    tool_name: str | None = Field(default=None, max_length=100)


class ChatRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    #: Ollama function schemas of the chart tools the browser can run.
    tools: list[dict[str, Any]] = Field(default_factory=list, max_length=MAX_TOOLS)
    #: The user's context window for this request (tokens); None = the server's.
    numCtx: int | None = Field(default=None, ge=NUM_CTX_MIN, le=NUM_CTX_MAX)


_cloud_calls: dict[Any, deque[float]] = defaultdict(deque)
_cloud_lock = threading.Lock()


def _cloud_allowed(user_id: Any, per_min: int) -> bool:
    """Sliding one-minute window of cloud requests per user (each tool round counts)."""
    if per_min <= 0:
        return True
    now = time.monotonic()
    with _cloud_lock:
        q = _cloud_calls[user_id]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= per_min:
            return False
        q.append(now)
        return True


def _runtime(request: Request) -> AiRuntime:
    """The AI set-up in force, resolved from the environment and the database on first use."""
    state = request.app.state
    runtime: AiRuntime | None = state.ai_runtime
    if runtime is None:
        settings = state.settings
        stored = None if env_locked(settings) else load_config(state.engine)
        runtime = state.ai_runtime = resolve(settings, stored)
    return runtime


def _backend(request: Request) -> AiBackend | None:
    return _runtime(request).backend


def _default_model(models: list[ModelInfo], wanted: str | None) -> str | None:
    names = [m.name for m in models]
    if wanted:
        for candidate in (wanted, f"{wanted}:latest"):
            if candidate in names:
                return candidate
    return names[0] if names else None


@router.get("/status")
def status(request: Request, who: UserDep, settings: SettingsDep) -> dict[str, Any]:
    runtime = _runtime(request)
    backend = runtime.backend
    if backend is None:
        return {"enabled": False}
    try:
        models = with_tiers(backend.list_models(), runtime.tiers)
        # Ollama down but cloud models listed: still usable, say why some are missing.
        error = backend.last_error if isinstance(backend, MultiBackend) else None
    except AiError as exc:
        models, error = [], str(exc)
    return {
        "enabled": True,
        "provider": backend.id,
        "reachable": bool(models) or error is None,
        "error": error,
        "models": [m.as_json() for m in models],
        "defaultModel": _default_model(models, runtime.default_model),
        "numCtx": runtime.num_ctx,
        "maxImageBytes": int(settings.ai_max_image_mb * 1024 * 1024),
    }


def _ollama_message(m: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": m.role, "content": m.content}
    if m.images:
        out["images"] = m.images
    if m.tool_calls:
        out["tool_calls"] = [
            {"function": {"name": c.name, "arguments": c.arguments}} for c in m.tool_calls
        ]
    if m.tool_name:
        out["tool_name"] = m.tool_name
    return out


def _check_images(body: ChatRequest, max_bytes: int) -> int:
    count = 0
    for msg in body.messages:
        for i, raw in enumerate(msg.images):
            if len(raw) > max_bytes * 4 // 3 + 8:
                raise HTTPException(413, "image too large")
            try:
                data = base64.b64decode(raw, validate=True)
            except (binascii.Error, ValueError):
                raise HTTPException(422, "image is not valid base64") from None
            if len(data) > max_bytes:
                raise HTTPException(413, "image too large")
            if not data.startswith(_IMAGE_MAGIC):
                raise HTTPException(422, "image must be PNG or JPEG")
            msg.images[i] = base64.b64encode(data).decode("ascii")  # canonical form
            count += 1
    return count


class _Answer:
    """The user's one running answer: holds their slot in `active` and the upstream stream.
    `finish` (idempotent, any thread) frees the slot and cuts the upstream; a stream that
    opens after `finish` (request cancelled while the model was loading) is cut at once."""

    def __init__(self, active: set[str], user_id: str) -> None:
        self._active = active
        self._user_id = user_id
        self._stream: ChatStream | None = None
        self._done = False
        self._lock = threading.Lock()
        active.add(user_id)

    def attach(self, stream: ChatStream) -> None:
        with self._lock:
            self._stream = stream
            done = self._done
        if done:
            stream.abort()

    def finish(self) -> None:
        with self._lock:
            if self._done:
                return
            self._done = True
            stream = self._stream
            self._active.discard(self._user_id)
        if stream is not None:
            stream.abort()


@router.post("/chat")
async def chat(
    body: ChatRequest, request: Request, who: UserDep, settings: SettingsDep
) -> StreamingResponse:
    backend = _backend(request)
    if backend is None:
        raise HTTPException(404, "AI is not configured")
    if body.messages[-1].role not in ("user", "tool"):
        raise HTTPException(422, "the last message must be from the user or a tool")
    if body.tools and len(json.dumps(body.tools)) > MAX_TOOLS_JSON:
        raise HTTPException(413, "tool definitions too large")
    if sum(len(m.content) for m in body.messages) > settings.ai_max_chars:
        raise HTTPException(413, "conversation too long")
    images = _check_images(body, int(settings.ai_max_image_mb * 1024 * 1024))

    try:
        models = with_tiers(await run_in_threadpool(backend.list_models), _runtime(request).tiers)
    except AiError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    info = next((m for m in models if m.name == body.model), None)
    if info is None:
        raise HTTPException(400, "unknown model")
    if images and not info.vision:
        raise HTTPException(400, "this model cannot read images")
    if body.tools and not info.tools:
        raise HTTPException(400, "this model cannot use chart tools")
    tier: Tier = info.tier if info.tier in TIER_TOOLS else "standard"
    extra = sorted(set(tool_names(body.tools)) - TIER_TOOLS[tier])
    if extra:
        raise HTTPException(400, f"not available to a {tier} model: {', '.join(extra)}")

    if info.cloud and not _cloud_allowed(who.id, settings.ai_cloud_rate_per_min):
        raise HTTPException(429, "too many cloud AI requests; wait a minute")
    active: set[str] = request.app.state.ai_active
    if who.id in active:
        raise HTTPException(429, "an answer is already being generated")
    answer = _Answer(active, who.id)
    try:
        messages = assemble(
            [_ollama_message(m) for m in body.messages], tools=bool(body.tools), tier=tier
        )

        def open_stream() -> ChatStream:
            stream = backend.open_chat(info.name, messages, body.tools or None, body.numCtx)
            answer.attach(stream)
            return stream

        stream = await run_in_threadpool(open_stream)
    except AiError as exc:
        answer.finish()
        raise HTTPException(exc.status, str(exc)) from None
    except BaseException:  # incl. the client going away (CancelledError)
        answer.finish()
        raise

    async def events() -> AsyncIterator[bytes]:
        try:
            async for event in iterate_in_threadpool(iter(stream)):
                yield json.dumps(event).encode() + b"\n"
        except AiError as exc:
            yield json.dumps({"t": "error", "message": str(exc)}).encode() + b"\n"
        finally:
            answer.finish()

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        # The generator's `finally` never runs if the client leaves before it starts.
        background=BackgroundTask(answer.finish),
    )


# ------------------------------------------------------------ admin set-up (Settings → AI)


def _config_view(request: Request, settings: Any) -> dict[str, Any]:
    runtime = _runtime(request)
    if runtime.source == "env":
        return {
            "source": "env",
            "locked": True,
            "provider": settings.ai_backend,
            "url": redact_url(settings.ollama_url),
            "models": list(settings.ai_models),
            "defaultModel": settings.ai_default_model,
            "numCtx": settings.ai_num_ctx,
            "tiers": {},
        }
    cfg = runtime.config
    return {
        "source": runtime.source,
        "locked": False,
        "provider": "ollama" if cfg and cfg.url else None,
        "url": cfg.url if cfg else None,
        "models": list(cfg.models) if cfg else [],
        "defaultModel": cfg.default_model if cfg else None,
        "numCtx": runtime.num_ctx,
        "tiers": runtime.tiers,
        "connections": [c.view() for c in cfg.connections] if cfg else [],
        "presets": PRESETS,
    }


def _store(request: Request, settings: Any, config: AiConfig | None) -> None:
    if config is not None and not config.url and not config.connections:
        config = None
    save_config(request.app.state.engine, config)
    request.app.state.ai_runtime = resolve(settings, config)


def _stored(request: Request) -> AiConfig | None:
    return _runtime(request).config


def _locked(settings: Any) -> None:
    if env_locked(settings):
        raise HTTPException(409, "Ask AI is set by the server environment (OLLAMA_URL)")


@router.get("/config")
def get_config(request: Request, who: AdminDep, settings: SettingsDep) -> dict[str, Any]:
    return _config_view(request, settings)


class ConfigBody(BaseModel):
    #: None or "" turns Ask AI off.
    url: str | None = Field(default=None, max_length=2000)
    #: Models users may pick; empty = every installed chat model.
    models: list[str] = Field(default_factory=list, max_length=MAX_MODELS)
    defaultModel: str | None = Field(default=None, max_length=200)
    #: Context window in tokens; None = `AI_NUM_CTX`.
    numCtx: int | None = Field(default=None, ge=NUM_CTX_MIN, le=NUM_CTX_MAX)
    #: Tier per model name; models left out get the automatic one.
    tiers: dict[str, Tier] = Field(default_factory=dict, max_length=MAX_MODELS)


@router.put("/config")
def put_config(
    body: ConfigBody, request: Request, who: AdminDep, settings: SettingsDep
) -> dict[str, Any]:
    _locked(settings)
    current = _stored(request)
    conns = current.connections if current else ()
    url: str | None = None
    if body.url and body.url.strip():
        try:
            url = normalize_url(body.url)
        except ValueError as exc:
            raise HTTPException(422, f"Ollama URL {exc}") from None
    models = tuple(dict.fromkeys(m.strip() for m in body.models if m.strip())) if url else ()
    default = (body.defaultModel or "").strip() or None
    config = AiConfig(url, models, default, body.numCtx, dict(body.tiers), conns)
    _store(request, settings, config)
    log.info("Ask AI Ollama %s in the app", "connected" if url else "turned off")
    return _config_view(request, settings)


# ------------------------------------------------------------ cloud connections


class ConnectionModelBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    vision: bool = False
    tools: bool = True
    context: int | None = Field(default=None, ge=NUM_CTX_MIN, le=10_000_000)


class ConnectionBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    preset: str = Field(default="custom", max_length=40)
    baseUrl: str = Field(min_length=1, max_length=2000)
    #: None keeps the stored key; "" removes it.
    apiKey: str | None = Field(default=None, max_length=4000)
    models: list[ConnectionModelBody] = Field(default_factory=list, max_length=MAX_MODELS)
    context: int = Field(default=128_000, ge=NUM_CTX_MIN, le=10_000_000)
    maxTokens: int | None = Field(default=None, ge=1, le=1_000_000)
    #: The admin accepted that questions and chart data go to this provider (cloud URLs).
    acknowledged: bool = False


_CONN_ID = r"[a-z0-9][a-z0-9-]{0,31}"
_KEY_NEEDS_REENTRY = (
    "the stored API key is only sent to the server it was saved for: enter the key again "
    "to use it with a different address"
)


@router.put("/connections/{conn_id}")
def put_connection(
    conn_id: str, body: ConnectionBody, request: Request, who: AdminDep, settings: SettingsDep
) -> dict[str, Any]:
    _locked(settings)
    if not re.fullmatch(_CONN_ID, conn_id):
        raise HTTPException(422, "connection id: lower-case letters, digits and dashes")
    try:
        base_url = normalize_url(body.baseUrl)
    except ValueError as exc:
        raise HTTPException(422, f"Base URL {exc}") from None
    if not is_local_url(base_url) and not body.acknowledged:
        raise HTTPException(422, "confirm that questions and chart data are sent to this provider")
    current = _stored(request)
    conns = list(current.connections) if current else []
    old = next((c for c in conns if c.id == conn_id), None)
    if old is None and len(conns) >= MAX_CONNECTIONS:
        raise HTTPException(409, f"at most {MAX_CONNECTIONS} connections")
    if (
        body.apiKey is None
        and old is not None
        and old.api_key
        and not same_origin(old.base_url, base_url)
    ):
        raise HTTPException(422, _KEY_NEEDS_REENTRY)
    key = (old.api_key if old else None) if body.apiKey is None else (body.apiKey.strip() or None)
    conn = CloudConnection(
        id=conn_id,
        name=body.name.strip(),
        preset=body.preset if body.preset in PRESETS else "custom",
        base_url=base_url,
        api_key=key,
        models=tuple(
            CloudModel(m.name.strip(), m.vision, m.tools, m.context)
            for m in {m.name.strip(): m for m in body.models}.values()
        ),
        context=body.context,
        max_tokens=body.maxTokens,
    )
    conns = [conn if c.id == conn_id else c for c in conns] if old else [*conns, conn]
    base = current or AiConfig(None)
    _store(
        request,
        settings,
        AiConfig(base.url, base.models, base.default_model, base.num_ctx, base.tiers, tuple(conns)),
    )
    log.info("Ask AI connection %s %s", conn_id, "updated" if old else "added")
    return _config_view(request, settings)


@router.delete("/connections/{conn_id}")
def delete_connection(
    conn_id: str, request: Request, who: AdminDep, settings: SettingsDep
) -> dict[str, Any]:
    _locked(settings)
    current = _stored(request)
    if current is None or not any(c.id == conn_id for c in current.connections):
        raise HTTPException(404, "no such connection")
    conns = tuple(c for c in current.connections if c.id != conn_id)
    _store(
        request,
        settings,
        AiConfig(
            current.url,
            current.models,
            current.default_model,
            current.num_ctx,
            current.tiers,
            conns,
        ),
    )
    log.info("Ask AI connection %s removed", conn_id)
    return _config_view(request, settings)


class ConnectionTestBody(BaseModel):
    baseUrl: str = Field(min_length=1, max_length=2000)
    #: None: use the stored key of connection `id`.
    apiKey: str | None = Field(default=None, max_length=4000)
    id: str | None = Field(default=None, max_length=32)


@router.post("/connections/test")
def test_cloud(
    body: ConnectionTestBody, request: Request, who: AdminDep, settings: SettingsDep
) -> dict[str, Any]:
    """Reach an OpenAI-compatible server and list its models (`GET /models`)."""
    try:
        base_url = normalize_url(body.baseUrl)
    except ValueError as exc:
        raise HTTPException(422, f"Base URL {exc}") from None
    key = body.apiKey
    if key is None and body.id:
        current = _stored(request)
        old = next((c for c in current.connections if c.id == body.id), None) if current else None
        key = old.api_key if old else None
        if key and old and not same_origin(old.base_url, base_url):
            raise HTTPException(422, _KEY_NEEDS_REENTRY)
    probe_conn = CloudConnection("test", "This server", "custom", base_url, key or None)
    try:
        names = cloud_backend(settings, probe_conn).available_models()
    except AiError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "models": names, "cloud": not is_local_url(base_url)}


class TestBody(BaseModel):
    #: None: try the usual addresses (localhost, host.docker.internal, ollama).
    url: str | None = Field(default=None, max_length=2000)


@router.post("/test")
def test_connection(body: TestBody, who: AdminDep, settings: SettingsDep) -> dict[str, Any]:
    """Reach an Ollama and list every chat model there (no allow-list)."""
    if body.url and body.url.strip():
        try:
            url = normalize_url(body.url)
        except ValueError as exc:
            raise HTTPException(422, f"Ollama URL {exc}") from None
        result = probe(settings, url)
        tried = [result]
    else:
        found, tried = detect(settings)
        result = found or tried[0]
    if result.models is None:
        return {
            "ok": False,
            "url": result.url,
            "error": result.error,
            "tried": [{"url": r.url, "error": r.error} for r in tried],
        }
    models = with_tiers(result.models, None)
    return {"ok": True, "url": result.url, "models": [m.as_json() for m in models]}
