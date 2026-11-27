"""Ask AI about the chart (docs/design/local-ai.md): model list and a streamed chat proxied
to Ollama. The browser sends the chart brief as message text (and optionally a chart image);
the server adds the system prompt, enforces limits and streams the answer back as NDJSON.
"""

import base64
import binascii
import json
import logging
from collections.abc import AsyncIterator
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.concurrency import iterate_in_threadpool, run_in_threadpool

from ..ai import AiBackend, AiError, ModelInfo
from ..ai.config import (
    MAX_MODELS,
    AiConfig,
    AiRuntime,
    detect,
    env_locked,
    load_config,
    normalize_url,
    probe,
    redact_url,
    resolve,
    save_config,
)
from ..ai.prompt import assemble
from ..deps import AdminDep, SettingsDep, UserDep

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ai", tags=["ai"])

MAX_MESSAGES = 40
MAX_IMAGES_PER_MESSAGE = 2
_IMAGE_MAGIC = (b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=2_000_000)
    #: Base64 PNG/JPEG (no `data:` prefix); only for vision models.
    images: list[str] = Field(default_factory=list, max_length=MAX_IMAGES_PER_MESSAGE)


class ChatRequest(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)


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
        models = backend.list_models()
        error = None
    except AiError as exc:
        models, error = [], str(exc)
    return {
        "enabled": True,
        "provider": backend.id,
        "reachable": error is None,
        "error": error,
        "models": [m.as_json() for m in models],
        "defaultModel": _default_model(models, runtime.default_model),
        "numCtx": settings.ai_num_ctx,
        "maxImageBytes": int(settings.ai_max_image_mb * 1024 * 1024),
    }


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


@router.post("/chat")
async def chat(
    body: ChatRequest, request: Request, who: UserDep, settings: SettingsDep
) -> StreamingResponse:
    backend = _backend(request)
    if backend is None:
        raise HTTPException(404, "AI is not configured")
    if body.messages[-1].role != "user":
        raise HTTPException(422, "the last message must be from the user")
    if sum(len(m.content) for m in body.messages) > settings.ai_max_chars:
        raise HTTPException(413, "conversation too long")
    images = _check_images(body, int(settings.ai_max_image_mb * 1024 * 1024))

    try:
        models = await run_in_threadpool(backend.list_models)
    except AiError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    info = next((m for m in models if m.name == body.model), None)
    if info is None:
        raise HTTPException(400, "unknown model")
    if images and not info.vision:
        raise HTTPException(400, "this model cannot read images")

    active: set[str] = request.app.state.ai_active
    if who.id in active:
        raise HTTPException(429, "an answer is already being generated")
    active.add(who.id)
    messages = assemble([m.model_dump() for m in body.messages])
    try:
        stream = await run_in_threadpool(backend.open_chat, info.name, messages)
    except AiError as exc:
        active.discard(who.id)
        raise HTTPException(exc.status, str(exc)) from None
    except BaseException:
        active.discard(who.id)
        raise

    async def events() -> AsyncIterator[bytes]:
        try:
            async for event in iterate_in_threadpool(iter(stream)):
                yield json.dumps(event).encode() + b"\n"
        except AiError as exc:
            yield json.dumps({"t": "error", "message": str(exc)}).encode() + b"\n"
        finally:
            # Client gone or stream over: cut the upstream so the model stops generating.
            stream.abort()
            active.discard(who.id)

    return StreamingResponse(
        events(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
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
        }
    cfg = runtime.config
    return {
        "source": runtime.source,
        "locked": False,
        "provider": "ollama" if cfg else None,
        "url": cfg.url if cfg else None,
        "models": list(cfg.models) if cfg else [],
        "defaultModel": cfg.default_model if cfg else None,
    }


@router.get("/config")
def get_config(request: Request, who: AdminDep, settings: SettingsDep) -> dict[str, Any]:
    return _config_view(request, settings)


class ConfigBody(BaseModel):
    #: None or "" turns Ask AI off.
    url: str | None = Field(default=None, max_length=2000)
    #: Models users may pick; empty = every installed chat model.
    models: list[str] = Field(default_factory=list, max_length=MAX_MODELS)
    defaultModel: str | None = Field(default=None, max_length=200)


@router.put("/config")
def put_config(
    body: ConfigBody, request: Request, who: AdminDep, settings: SettingsDep
) -> dict[str, Any]:
    if env_locked(settings):
        raise HTTPException(409, "Ask AI is set by the server environment (OLLAMA_URL)")
    config: AiConfig | None = None
    if body.url and body.url.strip():
        try:
            url = normalize_url(body.url)
        except ValueError as exc:
            raise HTTPException(422, f"Ollama URL {exc}") from None
        models = tuple(dict.fromkeys(m.strip() for m in body.models if m.strip()))
        default = (body.defaultModel or "").strip() or None
        config = AiConfig(url, models, default)
    save_config(request.app.state.engine, config)
    request.app.state.ai_runtime = resolve(settings, config)
    log.info("Ask AI %s in the app", "connected" if config else "turned off")
    return _config_view(request, settings)


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
    return {"ok": True, "url": result.url, "models": [m.as_json() for m in result.models]}
