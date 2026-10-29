from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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
