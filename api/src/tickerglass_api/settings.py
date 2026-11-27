import ipaddress
import re
from datetime import date
from functools import lru_cache
from pathlib import PurePath
from typing import Annotated, Any, Literal, Self
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

#: Shortest accepted `ALERTS_INTERNAL_TOKEN` (`openssl rand -hex 32` is 64).
INTERNAL_TOKEN_MIN_LEN = 32
#: Shortest accepted `BACKUP_PASSPHRASE` (kept equal to `backups.crypto.MIN_PASSPHRASE`).
BACKUP_PASSPHRASE_MIN = 12
#: Shortest accepted `METRICS_TOKEN`.
METRICS_TOKEN_MIN_LEN = 16
NTFY_PRIORITIES = {"min": 1, "low": 2, "default": 3, "high": 4, "max": 5, "urgent": 5}


_HEADER_NAME = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]+")


def _split_list(value: Any) -> Any:
    """Comma list from the environment (or a list from code), blanks dropped."""
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, list):
        return [part.strip() if isinstance(part, str) else part for part in value]
    return value


class Settings(BaseSettings):
    # `hide_input_in_errors`: a startup ValidationError must not echo the offending value (or, for
    # a model-level check, every input) -- the settings hold secrets. Secrets also have
    # `repr=False`, so `repr(Settings())` and tracebacks never show them.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)

    database_url: str = "sqlite:///./data/tickerglass.db"
    #: Market data source: an id from `providers.registry.PROVIDERS` ("yahoo" yfinance,
    #: "twelvedata" Twelve Data API, "demo" generated offline data); `create_app` rejects
    #: unknown ids.
    market_provider: str = "yahoo"
    #: Whether the app may switch the market data provider at runtime (`POST
    #: /api/providers/active`); false locks it to `MARKET_PROVIDER` and ignores a stored choice.
    provider_switching: bool = True
    #: Seconds after a provider switch during which a switch to another provider is refused
    #: (429 `switch_cooldown`): each switch wipes the cache and costs upstream credits.
    provider_switch_cooldown_s: float = 10
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    cors_origins: list[str] = ["http://localhost:5173"]
    live_poll_after_s: float = 20
    live_poll_interval_s: float = 15
    live_poll_closed_interval_s: float = 120

    # Upstream guard (providers/guard.py): request budget and cooldowns, per process.
    upstream_rate_per_min: float = 60
    upstream_burst: int = 20
    #: Credits per UTC day the upstream allows (resets 00:00 UTC); None or 0: no daily cap.
    #: At the limit calls fail with 429 and cached data is served; background calls stop
    #: earlier, keeping a share of the day for the user's own requests.
    upstream_daily_limit: int | None = None
    upstream_cooldown_initial_s: float = 30
    #: Also caps an upstream `retry_after`; 0 disables the rate-limit cooldown.
    upstream_cooldown_max_s: float = 900
    upstream_unavailable_cooldown_s: float = 10
    #: Provider-level retries after network failures.
    upstream_retries: int = 2
    #: Provider-level retries after a rate-limit refusal (the guard's cooldown takes over).
    upstream_rate_limit_retries: int = 0

    # In-memory market data caches (services/cache.py), seconds unless noted.
    #: Quote TTL while the market is open (`marketState` REGULAR) and when it is unknown.
    quote_ttl_s: float = 15
    #: Quote TTL while the market is closed (CLOSED): prices cannot change.
    quote_closed_ttl_s: float = 600
    #: Pre/post-market quotes, and the quote TTL during those sessions.
    extended_ttl_s: float = 60
    events_ttl_s: float = 6 * 3600
    fundamentals_ttl_s: float = 6 * 3600
    news_ttl_s: float = 300
    #: Symbol search results.
    search_ttl_s: float = 86400
    #: Stored symbol metadata (`services/symbols.py`); also how long a stored session is
    #: trusted to be today's (`services/sessions.py`).
    symbol_info_ttl_s: float = 86400
    #: News items fetched per symbol; smaller requests are sliced from that one fetch.
    news_fetch_limit: int = 50
    #: Oldest value served stale (in the background-refresh window or after an upstream error).
    cache_stale_max_s: float = 7 * 86400
    #: Entries per cache (least recently used dropped first).
    cache_max_entries: int = 4096
    #: How long an unknown symbol is remembered as unknown.
    cache_negative_ttl_s: float = 3600
    #: Same for symbols missing from a quote answer (shorter: a glitch may drop rows).
    quote_negative_ttl_s: float = 300
    #: After a failed v7 quote request, how long quotes use the daily-bar fallback instead
    #: (small batches only; larger ones are served stale or fail).
    quote_v7_retry_s: float = 300

    # Bar tail refresh (services/bars.py, services/sessions.py), seconds.
    #: Intraday tail TTL while the market is open.
    bars_tail_ttl_intraday_s: float = 30
    #: Daily/weekly/monthly tail TTL while the market is open.
    bars_tail_ttl_daily_s: float = 300
    #: Delay after the session close before the one final refresh of the day.
    bars_settle_after_close_s: float = 1200
    #: Cap of the doubling TTL for series that stop receiving bars while open.
    bars_quiet_backoff_max_s: float = 1800
    #: One-off exchange closures the NYSE calendar cannot derive from rules (days of mourning,
    #: disasters; `services/holidays.py`): ISO dates, comma separated in `MARKET_EXTRA_HOLIDAYS`.
    market_extra_holidays: Annotated[list[date], NoDecode] = []

    # Bar storage bounds (BarService.prune). Series read within the last day are kept.
    #: Bar rows across all series; above it the least recently used series are deleted,
    #: intraday first, down to 90% (about 80 bytes per row on disk).
    bars_max_rows: int = 10_000_000
    #: Intraday series not read for this many days are deleted.
    bars_intraday_retention_days: float = 30
    #: Daily, weekly and monthly series not read for this many days are deleted.
    bars_daily_retention_days: float = 365

    # Periodic cache upkeep (services/maintenance.py): prune bars, purge stale symbol
    # metadata, compact the SQLite file.
    cache_maintenance_enabled: bool = True
    cache_maintenance_interval_s: float = 21600

    # Alerts (docs/alerts.md §4.1). Secrets live only here, never in the browser.
    alerts_webhook_url: str | None = None
    alerts_webhook_secret: str | None = Field(default=None, repr=False)
    #: Allow per-alert webhook URLs to target loopback/private/link-local addresses (SSRF guard).
    alerts_webhook_allow_private: bool = False
    telegram_bot_token: str | None = Field(default=None, repr=False)
    telegram_chat_id: str | None = None
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = Field(default=None, repr=False)
    smtp_from: str | None = None
    #: One address or a comma list.
    smtp_to: str | None = None
    smtp_tls: Literal["starttls", "ssl", "none"] = "starttls"
    #: ntfy topic URL, e.g. `https://ntfy.sh/alerts` (docs/design/notify-channels.md).
    ntfy_url: str | None = None
    ntfy_token: str | None = Field(default=None, repr=False)
    #: 1-5 or min/low/default/high/max/urgent (stored as the number).
    ntfy_priority: int = 3
    ntfy_tags: str = "chart_with_upwards_trend"
    #: Gotify server base URL; needs `GOTIFY_TOKEN` (application token).
    gotify_url: str | None = None
    gotify_token: str | None = Field(default=None, repr=False)
    gotify_priority: int = Field(default=5, ge=0, le=10)
    #: Apprise API endpoint (`http://apprise:8000/notify` or `.../notify/<key>`).
    apprise_url: str | None = None
    #: Comma/space list of Apprise target URLs (stateless mode); secret, never returned.
    apprise_urls: str | None = Field(default=None, repr=False)
    apprise_tag: str | None = None
    alerts_log_max: int = 5000
    #: When set, service-only routes require the `X-Alerts-Token` header.
    alerts_internal_token: str | None = Field(default=None, repr=False)

    # Server-side screener (docs/design/server-screener.md).
    #: None: on for the yahoo and demo providers, off for twelvedata (daily credits); True/False
    #: forces it.
    screener_enabled: bool | None = None
    #: Local time of the daily snapshot run, "HH:MM" in `screener_tz`.
    screener_run_at: str = "17:15"
    screener_tz: str = "America/New_York"
    #: Upstream requests per minute the job may use (further capped by the guard's rate).
    screener_rate_per_min: float = 24
    #: Same for the weekly per-stock `info` pass (one request per stock).
    screener_info_rate_per_min: float = 10
    #: Most symbols tracked (bars are stored for each): bundled + list + watchlist symbols in
    #: rank order, the rest dropped. Daily bars of ~800 symbols are ~5M of `bars_max_rows`.
    screener_max_symbols: int = 800
    #: Also track every symbol on a watchlist.
    screener_include_watchlists: bool = True
    #: A snapshot older than this many days before the latest session is left out of scans.
    screener_stale_days: int = 7

    # Scheduled backups (docs/design/scheduled-backups.md). SQLite only. A backup runs daily
    # when a target is configured (a local folder and/or an S3-compatible bucket).
    backup_enabled: bool = True
    #: Absolute folder of the local target (created 0700).
    backup_dir: str | None = None
    #: Local time of the daily run, "HH:MM" in `backup_tz` (validated at startup).
    backup_at: str = "03:30"
    #: IANA zone of `backup_at`; unset: `SCREENER_TZ` when that is set explicitly, else UTC.
    backup_tz: str | None = None
    #: Keep the market-data cache in the backup (default: cleared on the copy, refetched later).
    backup_include_cache: bool = False
    #: Encrypts every backup (AES-256-GCM, scrypt key). Lose it and the backups are unreadable.
    #: Secret, never returned or logged (`SecretStr`: read it with `.get_secret_value()`).
    backup_passphrase: SecretStr | None = Field(default=None, repr=False)
    #: S3-compatible target; endpoint, bucket and both keys must be set together.
    backup_s3_endpoint: str | None = None
    backup_s3_bucket: str | None = None
    backup_s3_prefix: str = "tickerglass/"
    backup_s3_region: str = "us-east-1"
    backup_s3_access_key_id: str | None = Field(default=None, repr=False)
    #: Secret, never returned or logged (`SecretStr`).
    backup_s3_secret_access_key: SecretStr | None = Field(default=None, repr=False)
    backup_s3_path_style: bool = True
    #: Retention (GFS): newest N days / ISO weeks / months, the latest backup of each.
    backup_keep_daily: int = Field(default=7, ge=1, le=3650)
    backup_keep_weekly: int = Field(default=4, ge=0, le=520)
    backup_keep_monthly: int = Field(default=6, ge=0, le=240)
    #: Largest file accepted by the restore upload.
    backup_upload_max_mb: int = Field(default=2048, ge=1, le=1_048_576)
    #: Largest backup restored: its size once decompressed and what is fetched from a target
    #: (the work folder needs that much free space while staging).
    backup_restore_max_mb: int = Field(default=8192, ge=1, le=1_048_576)

    # Prometheus metrics (docs/design/metrics.md). Off by default; one uvicorn worker only.
    #: Serve `GET /metrics` (404 when false).
    metrics_enabled: bool = False
    #: When set, `/metrics` needs `Authorization: Bearer <token>`. Secret (`SecretStr`).
    metrics_token: SecretStr | None = Field(default=None, repr=False)
    #: Allow `/metrics` without a token even though sign-in is configured.
    metrics_public: bool = False

    # Ask AI about the chart (docs/design/local-ai.md). Off unless `OLLAMA_URL` is set or
    # `AI_PROVIDER=demo`. The browser never talks to Ollama; the API proxies it.
    #: Ollama base URL (`http://localhost:11434`; from Docker `http://host.docker.internal:11434`).
    #: Operator-set and trusted, so loopback/private addresses are fine; redirects are refused.
    ollama_url: str | None = None
    #: `ollama` (needs `OLLAMA_URL`), `demo` (canned offline replies, for trying the UI and
    #: tests); unset: `ollama` when `OLLAMA_URL` is set, else off.
    ai_provider: Literal["ollama", "demo"] | None = None
    #: Comma list of model names users may pick (`qwen2.5:7b,gemma3:12b`); empty = every
    #: installed chat model.
    ai_models: Annotated[list[str], NoDecode] = []
    #: Preselected model; falls back to the first available one.
    ai_default_model: str | None = None
    #: Context window sent as `options.num_ctx` (Ollama's own default is small and silently
    #: truncates the chart data).
    ai_num_ctx: int = Field(default=16384, ge=1024, le=1_048_576)
    #: Seconds to wait for Ollama to answer (covers loading a model) and between streamed chunks.
    ai_timeout_s: float = Field(default=600, gt=0, le=3600)
    #: How long Ollama keeps the model loaded after a request (`5m`, `1h`, `-1`); unset = Ollama's.
    ai_keep_alive: str | None = None
    #: Largest image attached to one message, decoded.
    ai_max_image_mb: float = Field(default=4, gt=0, le=64)
    #: Most text characters in one chat request (all messages).
    ai_max_chars: int = Field(default=400_000, ge=1000, le=10_000_000)

    # Auth (auth.py, docs/self-hosting.md). Unset: the app is open (localhost-first,
    # protect with a reverse proxy). Set: a single password guards the API and /ws.
    auth_password: str | None = Field(default=None, repr=False)
    #: Session-token signing secret; defaults to a random secret persisted next to a
    #: SQLite database (set this for Postgres so sessions survive restarts).
    auth_secret: str | None = Field(default=None, repr=False)
    #: Single sign-on and trusted-header auth (docs/design/oidc-sso.md). Auth is on when any
    #: method is configured: `AUTH_PASSWORD`, `OIDC_ISSUER` + `OIDC_CLIENT_ID`, or
    #: `AUTH_TRUSTED_HEADER`.
    #: External base URL (`https://tg.example.com`): builds the OIDC redirect URI, never
    #: derived from `Host`; an https scheme makes cookies `Secure`.
    public_url: str | None = None
    #: CIDR/IP list of plain forwarders (the bundled nginx): used to find the real client IP
    #: and to trust `X-Forwarded-Proto`.
    trusted_proxies: Annotated[list[str], NoDecode] = []
    auth_session_days: int = Field(default=30, ge=1, le=3650)
    #: Comma lists. OIDC / header sign-in needs one of these (or an admin list), or
    #: `AUTH_ALLOW_ANY_USER`; admins are implicitly allowed.
    auth_allowed_users: Annotated[list[str], NoDecode] = []
    auth_allowed_groups: Annotated[list[str], NoDecode] = []
    #: Multi-user (docs/design/multi-user.md). Comma lists with the allow-list matching rules; an
    #: identity on either list is an admin (promotion only, never a demotion).
    auth_admin_users: Annotated[list[str], NoDecode] = []
    auth_admin_groups: Annotated[list[str], NoDecode] = []
    #: Let every account the identity provider / proxy accepts sign in (no allow-list needed).
    auth_allow_any_user: bool = False
    #: Create an account on the first OIDC / header sign-in; false denies unknown identities.
    auth_auto_provision: bool = True
    #: Where the browser goes after sign-out (header mode / proxy logout).
    auth_logout_url: str | None = None
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = Field(default=None, repr=False)
    oidc_token_auth: Literal["client_secret_basic", "client_secret_post"] = "client_secret_basic"
    oidc_scopes: str = "openid profile email groups"
    oidc_groups_claim: str = "groups"
    oidc_provider_name: str = "SSO"
    #: Allow `http://` issuer and endpoints (an IdP on the LAN).
    oidc_allow_http: bool = False
    auth_trusted_header: str | None = None
    #: Opt-in extras, empty = not read. Every header you set here MUST be set (overwritten)
    #: by the proxy on every request, or a client can spoof it past the allow-lists.
    auth_trusted_email_header: str | None = None
    auth_trusted_name_header: str | None = None
    auth_trusted_groups_header: str | None = None
    #: CIDR/IP list of the authenticating proxy; a request is trusted only when it came
    #: through one of these (other hops must be in `TRUSTED_PROXIES`).
    auth_header_proxies: Annotated[list[str], NoDecode] = []

    @field_validator("ntfy_url", "gotify_url", "apprise_url", mode="before")
    @classmethod
    def _channel_url(cls, value: Any, info: ValidationInfo) -> Any:
        if not isinstance(value, str):
            return value
        value = value.strip()
        if not value:
            return None
        name = (info.field_name or "").upper()
        try:
            parts = urlsplit(value)
            _ = parts.port  # raises ValueError on a bad port
        except ValueError:
            raise ValueError(f"{name} is not a valid URL") from None
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"{name} must be an http(s) URL with a host")
        if name == "NTFY_URL" and parts.query:
            raise ValueError("NTFY_URL must not contain a query string; use NTFY_TOKEN for auth")
        return value

    @field_validator("ntfy_priority", mode="before")
    @classmethod
    def _ntfy_priority(cls, value: Any) -> Any:
        if isinstance(value, str):
            name = value.strip().lower()
            if not name:
                return 3
            if name in NTFY_PRIORITIES:
                return NTFY_PRIORITIES[name]
            if not name.lstrip("+").isdigit():
                raise ValueError("NTFY_PRIORITY must be 1-5 or min/low/default/high/max/urgent")
            value = int(name)
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 5:
            raise ValueError("NTFY_PRIORITY must be 1-5 or min/low/default/high/max/urgent")
        return value

    @field_validator("gotify_priority", mode="before")
    @classmethod
    def _gotify_priority(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return 5
        return value

    @field_validator(
        "public_url",
        "auth_logout_url",
        "oidc_issuer",
        "oidc_client_id",
        "oidc_client_secret",
        "auth_trusted_header",
        "auth_trusted_email_header",
        "auth_trusted_name_header",
        "auth_trusted_groups_header",
        "alerts_internal_token",
        mode="before",
    )
    @classmethod
    def _blank_is_none(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("trusted_proxies", "auth_header_proxies", mode="before")
    @classmethod
    def _networks(cls, value: Any, info: ValidationInfo) -> Any:
        items = _split_list(value)
        if not isinstance(items, list):
            return items
        for item in items:
            try:
                ipaddress.ip_network(item, strict=False)
            except ValueError:
                raise ValueError(
                    f"{(info.field_name or '').upper()}: {item!r} is not an IP or CIDR"
                ) from None
        return items

    @field_validator(
        "auth_allowed_users",
        "auth_allowed_groups",
        "auth_admin_users",
        "auth_admin_groups",
        mode="before",
    )
    @classmethod
    def _names(cls, value: Any) -> Any:
        return _split_list(value)

    @field_validator("auth_trusted_header", mode="after")
    @classmethod
    def _header_name(cls, value: str | None) -> str | None:
        if value is not None and not _HEADER_NAME.fullmatch(value):
            raise ValueError("AUTH_TRUSTED_HEADER is not a valid header name")
        return value

    @field_validator(
        "auth_trusted_email_header",
        "auth_trusted_name_header",
        "auth_trusted_groups_header",
        mode="after",
    )
    @classmethod
    def _extra_header_name(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is not None and not _HEADER_NAME.fullmatch(value):
            raise ValueError(f"{(info.field_name or '').upper()} is not a valid header name")
        return value

    @field_validator("ai_models", mode="before")
    @classmethod
    def _split_ai_models(cls, value: Any) -> Any:
        return _split_list(value)

    @field_validator(
        "ollama_url", "ai_provider", "ai_default_model", "ai_keep_alive", mode="before"
    )
    @classmethod
    def _blank_is_unset(cls, value: Any) -> Any:
        # docker-compose passes `${OLLAMA_URL:-}` etc. as empty strings when unset.
        if isinstance(value, str) and not value.strip():
            return None
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _ai_consistent(self) -> Self:
        if self.ai_provider == "ollama" and not self.ollama_url:
            raise ValueError("AI_PROVIDER=ollama needs OLLAMA_URL")
        return self

    @property
    def ai_backend(self) -> Literal["ollama", "demo"] | None:
        """Which AI backend runs: the explicit `AI_PROVIDER`, else ollama when a URL is set."""
        if self.ai_provider is not None:
            return self.ai_provider
        return "ollama" if self.ollama_url else None

    @field_validator("public_url", "auth_logout_url", "ollama_url", mode="after")
    @classmethod
    def _http_url(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None:
            return None
        name = (info.field_name or "").upper()
        try:
            parts = urlsplit(value)
            _ = parts.port
        except ValueError:
            raise ValueError(f"{name} is not a valid URL") from None
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"{name} must be an http(s) URL with a host")
        if name == "PUBLIC_URL":
            if parts.query or parts.fragment or parts.username or parts.password:
                raise ValueError("PUBLIC_URL must be a plain base URL")
            return value.rstrip("/")
        if name == "OLLAMA_URL":
            if parts.query or parts.fragment:
                raise ValueError("OLLAMA_URL must be a plain base URL")
            return value.rstrip("/")
        return value

    @field_validator("alerts_internal_token", mode="after")
    @classmethod
    def _strong_internal_token(cls, value: str | None) -> str | None:
        """The token is the alerts service's only credential (it reads every user's data):
        refuse short values and the placeholder shipped in the deploy templates."""
        if value is None:
            return value
        if "change-me" in value.lower():
            raise ValueError(
                "ALERTS_INTERNAL_TOKEN still contains the CHANGE-ME placeholder: "
                "replace it with a random secret (openssl rand -hex 32)"
            )
        if len(value) < INTERNAL_TOKEN_MIN_LEN:
            raise ValueError(
                f"ALERTS_INTERNAL_TOKEN must be at least {INTERNAL_TOKEN_MIN_LEN} characters "
                "(openssl rand -hex 32)"
            )
        return value

    @model_validator(mode="after")
    def _auth_methods_consistent(self) -> Self:
        if bool(self.oidc_issuer) != bool(self.oidc_client_id):
            raise ValueError("OIDC_ISSUER and OIDC_CLIENT_ID must be set together")
        if self.oidc_issuer:
            if not self.public_url:
                raise ValueError("OIDC needs PUBLIC_URL (it builds the redirect URI)")
            if not self.oidc_issuer.lower().startswith(
                ("https://", "http://") if self.oidc_allow_http else ("https://",)
            ):
                raise ValueError("OIDC_ISSUER must be https (OIDC_ALLOW_HTTP=true allows http)")
        if self.auth_trusted_header and not self.auth_header_proxies:
            raise ValueError(
                "AUTH_TRUSTED_HEADER needs AUTH_HEADER_PROXIES (the authenticating proxy's address)"
            )
        if (
            (self.oidc_issuer or self.auth_trusted_header)
            and not (
                self.auth_allowed_users
                or self.auth_allowed_groups
                or self.auth_admin_users
                or self.auth_admin_groups
            )
            and not self.auth_allow_any_user
        ):
            raise ValueError(
                "OIDC / trusted-header sign-in needs an allow-list: set AUTH_ALLOWED_USERS, "
                "AUTH_ALLOWED_GROUPS, AUTH_ADMIN_USERS or AUTH_ADMIN_GROUPS, or "
                "AUTH_ALLOW_ANY_USER=true to let every account your identity provider "
                "accepts sign in"
            )
        return self

    @property
    def auth_methods(self) -> list[str]:
        """Enabled sign-in methods, in display order; empty means the app is open."""
        methods = []
        if self.auth_password:
            methods.append("password")
        if self.oidc_issuer and self.oidc_client_id:
            methods.append("oidc")
        if self.auth_trusted_header:
            methods.append("header")
        return methods

    @field_validator(
        "backup_dir",
        "backup_tz",
        "backup_passphrase",
        "backup_s3_endpoint",
        "backup_s3_bucket",
        "backup_s3_access_key_id",
        "backup_s3_secret_access_key",
        mode="before",
    )
    @classmethod
    def _backup_blank_is_none(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator(
        "backup_enabled",
        "backup_at",
        "backup_include_cache",
        "backup_s3_prefix",
        "backup_s3_region",
        "backup_s3_path_style",
        "backup_keep_daily",
        "backup_keep_weekly",
        "backup_keep_monthly",
        "backup_upload_max_mb",
        "backup_restore_max_mb",
        mode="before",
    )
    @classmethod
    def _backup_blank_is_default(cls, value: Any, info: ValidationInfo) -> Any:
        """A blank value (compose passes `BACKUP_X=${BACKUP_X:-}`) means the default."""
        if isinstance(value, str) and not value.strip():
            return cls.model_fields[info.field_name or ""].default
        return value

    @field_validator("backup_at", mode="after")
    @classmethod
    def _backup_at_valid(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("BACKUP_AT must be HH:MM (24 hours), e.g. 03:30")
        return value

    @field_validator("backup_tz", mode="after")
    @classmethod
    def _backup_tz_valid(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                ZoneInfo(value)
            except (ZoneInfoNotFoundError, ValueError, OSError):
                raise ValueError(f"BACKUP_TZ {value!r} is not an IANA time zone") from None
        return value

    @field_validator("backup_dir", mode="after")
    @classmethod
    def _backup_dir_absolute(cls, value: str | None) -> str | None:
        if value is not None and not PurePath(value).is_absolute():
            raise ValueError("BACKUP_DIR must be an absolute path")
        return value

    @field_validator("backup_passphrase", mode="after")
    @classmethod
    def _backup_passphrase_long(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < BACKUP_PASSPHRASE_MIN:
            raise ValueError(
                f"BACKUP_PASSPHRASE must be at least {BACKUP_PASSPHRASE_MIN} characters"
            )
        return value

    @field_validator("backup_s3_endpoint", mode="after")
    @classmethod
    def _backup_s3_endpoint_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parts = urlsplit(value)
            _ = parts.port
        except ValueError:
            raise ValueError("BACKUP_S3_ENDPOINT is not a valid URL") from None
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("BACKUP_S3_ENDPOINT must be an http(s) URL with a host")
        if parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError("BACKUP_S3_ENDPOINT must be a plain base URL")
        return value.rstrip("/")

    @field_validator("backup_s3_prefix", mode="after")
    @classmethod
    def _backup_s3_prefix_norm(cls, value: str) -> str:
        value = value.strip().lstrip("/")
        if ".." in value.split("/") or "\\" in value or any(ord(c) < 32 for c in value):
            raise ValueError("BACKUP_S3_PREFIX must not contain '..', backslashes or controls")
        return value if not value or value.endswith("/") else value + "/"

    @model_validator(mode="after")
    def _backup_consistent(self) -> Self:
        s3 = {
            "BACKUP_S3_ENDPOINT": self.backup_s3_endpoint,
            "BACKUP_S3_BUCKET": self.backup_s3_bucket,
            "BACKUP_S3_ACCESS_KEY_ID": self.backup_s3_access_key_id,
            "BACKUP_S3_SECRET_ACCESS_KEY": self.backup_s3_secret_access_key
            and self.backup_s3_secret_access_key.get_secret_value(),
        }
        if any(s3.values()) and not all(s3.values()):
            missing = ", ".join(name for name, v in s3.items() if not v)
            raise ValueError(f"the S3 backup target needs all of its settings; missing: {missing}")
        return self

    @field_validator("metrics_token", mode="before")
    @classmethod
    def _metrics_blank_is_none(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip() or None
        return value

    @field_validator("metrics_enabled", "metrics_public", mode="before")
    @classmethod
    def _metrics_blank_is_default(cls, value: Any) -> Any:
        """A blank value (compose passes `METRICS_X=${METRICS_X:-}`) means the default."""
        if isinstance(value, str) and not value.strip():
            return False
        return value

    @field_validator("metrics_token", mode="after")
    @classmethod
    def _metrics_token_long(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < METRICS_TOKEN_MIN_LEN:
            raise ValueError(
                f"METRICS_TOKEN must be at least {METRICS_TOKEN_MIN_LEN} characters "
                "(openssl rand -hex 32)"
            )
        return value

    @model_validator(mode="after")
    def _metrics_consistent(self) -> Self:
        if (
            self.metrics_enabled
            and not self.metrics_token
            and not self.metrics_public
            and self.auth_methods
        ):
            raise ValueError(
                "METRICS_ENABLED=true with sign-in configured needs METRICS_TOKEN (a bearer token "
                "for the scraper, openssl rand -hex 32), or METRICS_PUBLIC=true to serve "
                "/metrics without one"
            )
        return self

    @property
    def metrics_token_value(self) -> str | None:
        """The scrape token in the clear (for the endpoint's check only); None when not set."""
        return self.metrics_token.get_secret_value() if self.metrics_token else None

    @property
    def backup_passphrase_value(self) -> str | None:
        """The passphrase in the clear (for the encryption code only); None when not set."""
        return self.backup_passphrase.get_secret_value() if self.backup_passphrase else None

    @property
    def backup_s3_secret_value(self) -> str | None:
        return (
            self.backup_s3_secret_access_key.get_secret_value()
            if self.backup_s3_secret_access_key
            else None
        )

    @property
    def backup_s3_configured(self) -> bool:
        return bool(
            self.backup_s3_endpoint
            and self.backup_s3_bucket
            and self.backup_s3_access_key_id
            and self.backup_s3_secret_access_key
        )

    @property
    def backup_zone(self) -> str:
        """IANA zone of the daily backup: `BACKUP_TZ`, else `SCREENER_TZ` when set
        explicitly, else UTC."""
        if self.backup_tz:
            return self.backup_tz
        if "screener_tz" in self.model_fields_set:
            return self.screener_tz
        return "UTC"

    @field_validator("market_extra_holidays", mode="before")
    @classmethod
    def _split_dates(cls, value: Any) -> Any:
        if isinstance(value, str):
            return [part.strip() for part in value.split(",") if part.strip()]
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
