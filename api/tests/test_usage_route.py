"""GET /providers/usage, the credit budget the app shows, and the startup usage seed."""

import logging
import threading
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from tickerglass_api.app import create_app
from tickerglass_api.providers.base import BAR_COLUMNS, RateLimited, Usage
from tickerglass_api.settings import Settings


class Fake:
    """Counts what reaches it; `error` is raised by quotes, `usage_*` drive `usage()`."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.error: Exception | None = None

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self.calls.append("history")
        return pd.DataFrame(columns=BAR_COLUMNS)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        self.calls.append("symbol_info")
        return {"symbol": symbol}

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return []

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.calls.append("quotes")
        if self.error is not None:
            raise self.error
        return [{"symbol": s, "last": 1.0, "marketState": "REGULAR"} for s in symbols]

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        return []


class Metered(Fake):
    def __init__(self, answer: Usage | Exception) -> None:
        super().__init__()
        self.answer = answer
        self.asked = threading.Event()

    def usage(self) -> Usage:
        self.calls.append("usage")
        self.asked.set()
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def settings(**kw: Any) -> Settings:
    return Settings(  # type: ignore[call-arg]
        _env_file=None, upstream_rate_per_min=60, upstream_burst=20, **kw
    )


def client_for(provider: Fake, tmp_path: Path, **kw: Any) -> TestClient:
    app = create_app(
        provider=provider,
        database_url=f"sqlite:///{tmp_path}/u.db",
        settings_override=settings(**kw),
    )
    return TestClient(app)


def wait_for(cond: Callable[[], bool], timeout: float = 3.0) -> None:
    import time

    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "condition not met in time"
        time.sleep(0.01)


def test_usage_of_an_unmetered_provider(tmp_path: Path) -> None:
    fake = Fake()
    with client_for(fake, tmp_path) as client:
        body = client.get("/api/providers/usage").json()
    assert body == {
        "plan": None,
        "metered": False,
        "minute": {"limit": 60, "left": 20},
        "daily": None,
        "state": "ok",
        "retryAfterS": 0,
    }
    assert fake.calls == []  # reading usage never reaches the upstream


def test_usage_follows_the_daily_limit_and_costs_no_credits(tmp_path: Path) -> None:
    fake = Fake()
    with client_for(fake, tmp_path, upstream_daily_limit=100) as client:
        first = client.get("/api/providers/usage").json()
        assert first["metered"] is True
        assert first["daily"]["limit"] == 100 and first["daily"]["used"] == 0
        assert first["daily"]["resetAt"].endswith("T00:00:00Z")
        client.get("/api/quotes", params={"symbols": "AAPL"})
        again = client.get("/api/providers/usage").json()
        assert again["daily"]["used"] == 1
        assert client.get("/api/providers/usage").json()["daily"]["used"] == 1
        assert fake.calls == ["quotes"]
        listed = client.get("/api/providers").json()["effectiveLimits"]
        assert listed["dailyCredits"] == 100 and listed["source"] == "env"


def test_zero_daily_limit_means_no_cap(tmp_path: Path) -> None:
    with client_for(Fake(), tmp_path, upstream_daily_limit=0) as client:
        assert client.get("/api/providers/usage").json()["daily"] is None


def test_daily_exhaustion_is_reported_and_served_as_429(tmp_path: Path) -> None:
    fake = Fake()
    fake.error = RateLimited("You have run out of API credits for the day", 60, daily=True)
    with client_for(fake, tmp_path, upstream_daily_limit=800) as client:
        res = client.get("/api/quotes", params={"symbols": "AAPL"})
        assert res.status_code == 429
        assert int(res.headers["Retry-After"]) > 0
        body = client.get("/api/providers/usage").json()
        assert body["state"] == "exhausted" and body["retryAfterS"] > 0
        assert body["daily"]["used"] == 800
        fake.error = None
        # Refused locally until the reset: the upstream is not asked again.
        assert client.get("/api/quotes", params={"symbols": "AAPL"}).status_code == 429
        assert fake.calls == ["quotes"]


def test_usage_is_ok_when_the_minute_budget_only_needs_a_moment(tmp_path: Path) -> None:
    with client_for(Fake(), tmp_path, upstream_daily_limit=100) as client:
        guard = client.app.state.upstream_guard  # type: ignore[attr-defined]
        guard.acquire(20)
        body = client.get("/api/providers/usage").json()
    # 60 credits a minute: the next one is back within a second or so.
    assert body["state"] == "ok" and 1 <= body["retryAfterS"] <= 5
    assert body["minute"]["left"] == 0


def test_usage_is_throttled_when_the_wait_is_longer_than_five_seconds(tmp_path: Path) -> None:
    app = create_app(
        provider=Fake(),
        database_url=f"sqlite:///{tmp_path}/slow.db",
        settings_override=Settings(  # type: ignore[call-arg]
            _env_file=None, upstream_rate_per_min=6, upstream_burst=4
        ),
    )
    with TestClient(app) as client:
        client.app.state.upstream_guard.acquire(4)  # type: ignore[attr-defined]
        body = client.get("/api/providers/usage").json()
    assert body["state"] == "throttled" and body["retryAfterS"] > 5
    assert body["minute"]["left"] == 0


def test_startup_seeds_the_daily_count_from_a_metered_provider(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)  # not set by the user: the upstream's numbers apply
    fake = Metered(Usage(minute_limit=8, minute_used=3, daily_limit=800, daily_used=420))
    app = create_app(
        provider=fake,
        database_url=f"sqlite:///{tmp_path}/m.db",
        settings_override=Settings(_env_file=None),  # type: ignore[call-arg]
    )
    with TestClient(app) as client:
        assert fake.asked.wait(3)
        wait_for(lambda: client.get("/api/providers/usage").json()["daily"] is not None)
        body = client.get("/api/providers/usage").json()
        assert body["metered"] is True
        assert body["daily"]["limit"] == 800 and body["daily"]["used"] == 420
        assert body["minute"]["limit"] == 8
        limits = client.get("/api/providers").json()["effectiveLimits"]
        assert limits == {
            "creditsPerMin": 8,
            "dailyCredits": 800,
            "quoteTtlS": 15,
            "pollIntervalS": 15,
            "source": "calibrated",
        }


def test_user_set_limits_are_not_overridden_by_the_seed(tmp_path: Path) -> None:
    fake = Metered(Usage(minute_limit=8, minute_used=3, daily_limit=800, daily_used=420))
    with client_for(fake, tmp_path, upstream_daily_limit=500) as client:
        assert fake.asked.wait(3)
        wait_for(lambda: client.get("/api/providers/usage").json()["daily"]["used"] == 420)
        body = client.get("/api/providers/usage").json()
    assert body["daily"]["limit"] == 500
    assert body["minute"]["limit"] == 60


def test_failed_seed_is_logged_and_ignored(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    fake = Metered(RateLimited("slow down", 5))
    with (
        caplog.at_level(logging.WARNING, logger="tickerglass_api.app"),
        client_for(fake, tmp_path, upstream_daily_limit=800) as client,
    ):
        assert fake.asked.wait(3)
        wait_for(lambda: any("credit usage" in r.getMessage() for r in caplog.records))
        body = client.get("/api/providers/usage").json()
    assert body["daily"]["limit"] == 800
