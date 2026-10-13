from functools import lru_cache

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
