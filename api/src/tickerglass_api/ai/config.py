"""Ask AI set up in the app (docs/design/local-ai.md §2.1).

An admin can connect Ollama from Settings → AI instead of `.env`: the URL, which installed models
users may pick, and the default, kept in `app_meta` under `ai_config` (server config, never
exported). `OLLAMA_URL` or `AI_PROVIDER` in the environment wins and locks the in-app settings.
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from ..models import AppMeta
from ..settings import Settings
from .base import AiBackend, AiError, ModelInfo
from .demo import DemoBackend
from .ollama import OllamaBackend

log = logging.getLogger(__name__)

AI_CONFIG_KEY = "ai_config"
#: Where Ollama usually answers, tried in this order by "Detect": the API host itself, the
#: Docker host (Docker Desktop, OrbStack; Linux with the compose `extra_hosts`), the compose
#: `ollama` profile service.
CANDIDATE_URLS = (
    "http://localhost:11434",
    "http://127.0.0.1:11434",
    "http://host.docker.internal:11434",
    "http://ollama:11434",
)
#: Seconds a probe waits per address.
PROBE_TIMEOUT_S = 4.0
MAX_MODELS = 200
#: Context windows offered in Settings → AI (tokens).
NUM_CTX_MIN = 2048
NUM_CTX_MAX = 131072

Source = Literal["env", "app", "off"]


@dataclass(frozen=True)
class AiConfig:
    url: str
    models: tuple[str, ...] = field(default_factory=tuple)
    default_model: str | None = None
    #: Context window sent to Ollama; None = `AI_NUM_CTX`.
    num_ctx: int | None = None

    def as_json(self) -> dict[str, Any]:
        return {
            "url": self.url,
            "models": list(self.models),
            "defaultModel": self.default_model,
            "numCtx": self.num_ctx,
        }


def normalize_url(raw: str) -> str:
    """An http(s) base URL without query or fragment and trailing slash; ValueError otherwise.
    `localhost:11434` gets `http://`."""
    value = raw.strip()
    if value and "://" not in value:
        value = f"http://{value}"
    try:
        parts = urlsplit(value)
        _ = parts.port
    except ValueError:
        raise ValueError("not a valid URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("must be an http(s) URL with a host, e.g. http://localhost:11434")
    if parts.query or parts.fragment:
        raise ValueError("must be a plain base URL (no ? or #)")
    return urlunsplit(parts._replace(path=parts.path.rstrip("/"))).rstrip("/")


def redact_url(url: str | None) -> str | None:
    """`url` with a password in it replaced by `***`."""
    if not url:
        return url
    parts = urlsplit(url)
    if parts.password is None:
        return url
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit(parts._replace(netloc=f"{parts.username}:***@{host}"))


def env_locked(settings: Settings) -> bool:
    """The environment decides (`OLLAMA_URL` or `AI_PROVIDER` set)."""
    return settings.ai_backend is not None


def load_config(engine: Engine) -> AiConfig | None:
    with Session(engine) as session:
        row = session.get(AppMeta, AI_CONFIG_KEY)
        value = None if row is None else row.value
    if value is None:
        return None
    try:
        url = normalize_url(str(value["url"]))
        models = tuple(str(m) for m in value.get("models") or [])[:MAX_MODELS]
        default = value.get("defaultModel")
        ctx = value.get("numCtx")
        num_ctx = int(ctx) if isinstance(ctx, int) and NUM_CTX_MIN <= ctx <= NUM_CTX_MAX else None
        return AiConfig(url, models, str(default) if default else None, num_ctx)
    except (KeyError, TypeError, ValueError, AttributeError):
        log.warning("ignoring the stored AI settings, they are malformed")
        return None


def save_config(engine: Engine, config: AiConfig | None) -> None:
    with Session(engine) as session, session.begin():
        row = session.get(AppMeta, AI_CONFIG_KEY)
        if config is None:
            if row is not None:
                session.delete(row)
            return
        now = datetime.now(UTC)
        if row is None:
            session.add(AppMeta(key=AI_CONFIG_KEY, value=config.as_json(), updated_at=now))
        else:
            row.value = config.as_json()
            row.updated_at = now


def ollama_backend(
    settings: Settings, url: str, allow: list[str] | None = None, num_ctx: int | None = None
) -> OllamaBackend:
    return OllamaBackend(
        url,
        timeout_s=settings.ai_timeout_s,
        num_ctx=num_ctx or settings.ai_num_ctx,
        keep_alive=settings.ai_keep_alive,
        allow=allow,
    )


@dataclass
class AiRuntime:
    """What the routes use: the backend (None = off), where it came from, the default model."""

    backend: AiBackend | None
    source: Source
    default_model: str | None
    config: AiConfig | None = None
    #: Context window in force.
    num_ctx: int = 8192


def resolve(settings: Settings, stored: AiConfig | None) -> AiRuntime:
    """Environment first, then the in-app settings, else off."""
    match settings.ai_backend:
        case "demo":
            return AiRuntime(
                DemoBackend(), "env", settings.ai_default_model, num_ctx=settings.ai_num_ctx
            )
        case "ollama":
            assert settings.ollama_url
            backend = ollama_backend(settings, settings.ollama_url, settings.ai_models)
            return AiRuntime(backend, "env", settings.ai_default_model, num_ctx=settings.ai_num_ctx)
    if stored is not None:
        num_ctx = stored.num_ctx or settings.ai_num_ctx
        backend = ollama_backend(settings, stored.url, list(stored.models), num_ctx)
        return AiRuntime(backend, "app", stored.default_model, stored, num_ctx)
    return AiRuntime(None, "off", None, num_ctx=settings.ai_num_ctx)


@dataclass(frozen=True)
class ProbeResult:
    url: str
    models: list[ModelInfo] | None = None
    error: str | None = None


def probe(settings: Settings, url: str) -> ProbeResult:
    """Every chat model at `url` (no allow-list), or why it failed."""
    backend = OllamaBackend(
        url,
        timeout_s=settings.ai_timeout_s,
        num_ctx=settings.ai_num_ctx,
        meta_timeout_s=PROBE_TIMEOUT_S,
    )
    try:
        return ProbeResult(url, models=backend.list_models())
    except AiError as exc:
        return ProbeResult(url, error=str(exc))


def detect(settings: Settings) -> tuple[ProbeResult | None, list[ProbeResult]]:
    """Probe the usual addresses at once; the first in `CANDIDATE_URLS` order that answers."""
    with ThreadPoolExecutor(max_workers=len(CANDIDATE_URLS)) as pool:
        results = list(pool.map(lambda u: probe(settings, u), CANDIDATE_URLS))
    found = next((r for r in results if r.models is not None), None)
    return found, results
