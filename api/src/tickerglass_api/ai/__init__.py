"""Ask AI about the chart: a proxy to a local Ollama (docs/design/local-ai.md)."""

from ..settings import Settings
from .base import AiBackend, AiBadRequest, AiError, AiUnavailable, ModelInfo
from .demo import DemoBackend
from .ollama import OllamaBackend

__all__ = [
    "AiBackend",
    "AiBadRequest",
    "AiError",
    "AiUnavailable",
    "ModelInfo",
    "make_backend",
]


def make_backend(settings: Settings) -> AiBackend | None:
    """The configured backend, or None when the feature is off."""
    match settings.ai_backend:
        case "demo":
            return DemoBackend()
        case "ollama":
            assert settings.ollama_url  # checked by the settings validator
            return OllamaBackend(
                settings.ollama_url,
                timeout_s=settings.ai_timeout_s,
                num_ctx=settings.ai_num_ctx,
                keep_alive=settings.ai_keep_alive,
                allow=settings.ai_models,
            )
    return None
