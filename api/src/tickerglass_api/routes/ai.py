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
from ..ai.prompt import assemble
from ..deps import SettingsDep, UserDep

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


def _backend(request: Request) -> AiBackend | None:
    backend: AiBackend | None = request.app.state.ai
    return backend


def _default_model(models: list[ModelInfo], wanted: str | None) -> str | None:
    names = [m.name for m in models]
    if wanted:
        for candidate in (wanted, f"{wanted}:latest"):
            if candidate in names:
                return candidate
    return names[0] if names else None


@router.get("/status")
def status(request: Request, who: UserDep, settings: SettingsDep) -> dict[str, Any]:
    backend = _backend(request)
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
        "defaultModel": _default_model(models, settings.ai_default_model),
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
