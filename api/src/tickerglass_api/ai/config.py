"""Ask AI set up in the app (docs/design/local-ai.md §2.1).

An admin can connect Ollama from Settings → AI instead of `.env`: the URL, which installed models
users may pick, and the default, kept in `app_meta` under `ai_config` (server config, never
exported). `OLLAMA_URL` or `AI_PROVIDER` in the environment wins and locks the in-app settings.
"""

import ipaddress
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
from .multi import MultiBackend
from .ollama import OllamaBackend
from .openai_compat import CloudModel, OpenAICompatBackend
from .tiers import is_tier

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

#: OpenAI-compatible presets offered in Settings → AI (base URLs from the providers' docs,
#: 2026-11; the admin can edit them). `local`: runs on the admin's own machine.
PRESETS: dict[str, dict[str, Any]] = {
    "openai": {"name": "OpenAI", "baseUrl": "https://api.openai.com/v1"},
    "openrouter": {"name": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1"},
    "zai": {"name": "Z.ai (GLM)", "baseUrl": "https://api.z.ai/api/paas/v4"},
    "zai-coding": {"name": "Z.ai Coding Plan", "baseUrl": "https://api.z.ai/api/coding/paas/v4"},
    "deepseek": {"name": "DeepSeek", "baseUrl": "https://api.deepseek.com"},
    "opencode": {"name": "OpenCode Zen", "baseUrl": "https://opencode.ai/zen/v1"},
    "groq": {"name": "Groq", "baseUrl": "https://api.groq.com/openai/v1"},
    "mistral": {"name": "Mistral", "baseUrl": "https://api.mistral.ai/v1"},
    "lmstudio": {"name": "LM Studio", "baseUrl": "http://localhost:1234/v1", "local": True},
    "custom": {"name": "Custom (OpenAI-compatible)", "baseUrl": ""},
}
MAX_CONNECTIONS = 10
#: Context window assumed for cloud models without one set (tokens).
CLOUD_CONTEXT_DEFAULT = 128_000
#: Names that mean this machine or its Docker host. Only these exact names and the shapes in
#: `is_local_url` count as local; a dotted public-looking name never does.
_LOCAL_HOSTS = ("localhost", "host.docker.internal")


def is_local_url(url: str) -> bool:
    """A URL on this machine or the private network: chat data stays in-house.

    Local: `localhost`, `host.docker.internal`, a literal loopback/private IP, a single-label
    name (a Docker/compose service such as `ollama`, a LAN box such as `nas`) and an mDNS
    `*.local` name (e.g. `mac-mini.local`, the usual way to reach Ollama on another home
    machine; mDNS resolves on the link only). Anything else, such as `ollama.example.com` or
    `x.lan`, is treated as cloud and needs the acknowledgement."""
    host = (urlsplit(url).hostname or "").lower().rstrip(".")
    if not host:
        return False
    if host in _LOCAL_HOSTS:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host or (host.endswith(".local") and host.count(".") == 1)
    return ip.is_private or ip.is_loopback


def same_origin(a: str, b: str) -> bool:
    """Both URLs reach the same scheme, host and port: a credential for one may go to the other."""
    pa, pb = urlsplit(a), urlsplit(b)
    default = {"http": 80, "https": 443}
    try:
        return (
            pa.scheme == pb.scheme
            and (pa.hostname or "").lower().rstrip(".") == (pb.hostname or "").lower().rstrip(".")
            and (pa.port or default.get(pa.scheme)) == (pb.port or default.get(pb.scheme))
        )
    except ValueError:
        return False


@dataclass(frozen=True)
class CloudConnection:
    """An OpenAI-compatible endpoint an admin connected, with the models users may pick."""

    id: str
    name: str
    preset: str
    base_url: str
    api_key: str | None
    models: tuple[CloudModel, ...] = ()
    context: int = CLOUD_CONTEXT_DEFAULT
    max_tokens: int | None = None

    @property
    def cloud(self) -> bool:
        return not is_local_url(self.base_url)

    def as_json(self) -> dict[str, Any]:
        """Stored form (with the key); never sent to the browser."""
        return {
            "id": self.id,
            "name": self.name,
            "preset": self.preset,
            "baseUrl": self.base_url,
            "apiKey": self.api_key,
            "models": [m.as_json() for m in self.models],
            "context": self.context,
            "maxTokens": self.max_tokens,
        }

    def view(self) -> dict[str, Any]:
        """What admins see: the key only as its last four characters."""
        out = self.as_json()
        key = out.pop("apiKey")
        out["hasKey"] = bool(key)
        out["keyHint"] = f"••••{key[-4:]}" if key and len(key) >= 8 else ("••••" if key else None)
        out["cloud"] = self.cloud
        return out


def connection_from(value: Any) -> CloudConnection:
    """A stored connection; ValueError/KeyError/TypeError when malformed."""
    models = tuple(
        CloudModel(
            name=str(m["name"]),
            vision=bool(m.get("vision")),
            tools=bool(m.get("tools", True)),
            context=int(m["context"]) if isinstance(m.get("context"), int) else None,
        )
        for m in value.get("models") or []
    )[:MAX_MODELS]
    ctx = value.get("context")
    max_tokens = value.get("maxTokens")
    return CloudConnection(
        id=str(value["id"]),
        name=str(value.get("name") or value["id"]),
        preset=str(value.get("preset") or "custom"),
        base_url=normalize_url(str(value["baseUrl"])),
        api_key=str(value["apiKey"]) if value.get("apiKey") else None,
        models=models,
        context=int(ctx) if isinstance(ctx, int) and ctx > 0 else CLOUD_CONTEXT_DEFAULT,
        max_tokens=int(max_tokens) if isinstance(max_tokens, int) and max_tokens > 0 else None,
    )


@dataclass(frozen=True)
class AiConfig:
    #: Ollama base URL; None = no Ollama (cloud connections only).
    url: str | None
    models: tuple[str, ...] = field(default_factory=tuple)
    default_model: str | None = None
    #: Context window sent to Ollama; None = `AI_NUM_CTX`.
    num_ctx: int | None = None
    #: Capability tier an admin set per model name; others get the automatic one.
    tiers: dict[str, str] = field(default_factory=dict)
    connections: tuple[CloudConnection, ...] = ()

    def as_json(self) -> dict[str, Any]:
        return {
            "connections": [c.as_json() for c in self.connections],
            "url": self.url,
            "models": list(self.models),
            "defaultModel": self.default_model,
            "numCtx": self.num_ctx,
            "tiers": dict(self.tiers),
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
        url = normalize_url(str(value["url"])) if value.get("url") else None
        models = tuple(str(m) for m in value.get("models") or [])[:MAX_MODELS]
        default = value.get("defaultModel")
        ctx = value.get("numCtx")
        num_ctx = int(ctx) if isinstance(ctx, int) and NUM_CTX_MIN <= ctx <= NUM_CTX_MAX else None
        raw_tiers = value.get("tiers")
        tiers = {
            str(k): str(v)
            for k, v in (raw_tiers.items() if isinstance(raw_tiers, dict) else [])
            if is_tier(v)
        }
        conns = tuple(connection_from(c) for c in value.get("connections") or [])[:MAX_CONNECTIONS]
        if url is None and not conns:
            return None
        return AiConfig(url, models, str(default) if default else None, num_ctx, tiers, conns)
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


def cloud_backend(settings: Settings, c: CloudConnection) -> OpenAICompatBackend:
    return OpenAICompatBackend(
        c.id,
        c.name,
        c.base_url,
        c.api_key,
        c.models,
        timeout_s=settings.ai_timeout_s,
        context=c.context,
        max_tokens=c.max_tokens,
        cloud=c.cloud,
    )


@dataclass
class AiRuntime:
    """What the routes use: the backend (None = off), where it came from, the default model."""

    backend: AiBackend | None
    source: Source
    default_model: str | None
    config: AiConfig | None = None
    #: Context window in force.
    num_ctx: int = 16384

    @property
    def tiers(self) -> dict[str, str]:
        """Admin-set tiers per model (none when the environment decides)."""
        return dict(self.config.tiers) if self.config else {}


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
        ollama = (
            ollama_backend(settings, stored.url, list(stored.models), num_ctx)
            if stored.url
            else None
        )
        clouds = [cloud_backend(settings, c) for c in stored.connections]
        chosen: AiBackend | None = MultiBackend(ollama, clouds) if clouds else ollama
        if chosen is not None:
            return AiRuntime(chosen, "app", stored.default_model, stored, num_ctx)
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
