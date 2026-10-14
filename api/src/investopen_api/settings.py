from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/investopen.db"
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    cors_origins: list[str] = ["http://localhost:5173"]
    live_poll_after_s: float = 20
    live_poll_interval_s: float = 15
    live_poll_closed_interval_s: float = 120

    # Alerts (docs/alerts.md §4.1). Secrets live only here, never in the browser.
    alerts_webhook_url: str | None = None
    alerts_webhook_secret: str | None = None
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
