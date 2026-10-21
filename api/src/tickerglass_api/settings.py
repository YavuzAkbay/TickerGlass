from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/tickerglass.db"
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    cors_origins: list[str] = ["http://localhost:5173"]
    live_poll_after_s: float = 20
    live_poll_interval_s: float = 15
    live_poll_closed_interval_s: float = 120

    # Upstream guard (providers/guard.py): request budget and cooldowns, per process.
    upstream_rate_per_min: float = 60
    upstream_burst: int = 20
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
    #: News items fetched per symbol; smaller requests are sliced from that one fetch.
    news_fetch_limit: int = 50
    #: Oldest value served stale (in the background-refresh window or after an upstream error).
    cache_stale_max_s: float = 7 * 86400
    #: Entries per cache (least recently used dropped first).
    cache_max_entries: int = 4096
    #: How long an unknown symbol is remembered as unknown.
    cache_negative_ttl_s: float = 3600

    # Alerts (docs/alerts.md §4.1). Secrets live only here, never in the browser.
    alerts_webhook_url: str | None = None
    alerts_webhook_secret: str | None = None
    #: Allow per-alert webhook URLs to target loopback/private/link-local addresses (SSRF guard).
    alerts_webhook_allow_private: bool = False
    telegram_bot_token: str | None = None
    telegram_chat_id: str | None = None
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from: str | None = None
    #: One address or a comma list.
    smtp_to: str | None = None
    smtp_tls: Literal["starttls", "ssl", "none"] = "starttls"
    alerts_log_max: int = 5000
    #: When set, service-only routes require the `X-Alerts-Token` header.
    alerts_internal_token: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
