import asyncio
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from yfinance.exceptions import YFRateLimitError

from tickerglass_api.app import create_app
from tickerglass_api.providers import yahoo
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    ProviderError,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.yahoo import YahooProvider
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.settings import Settings


class FakeClock:
    """Monotonic clock whose `sleep` only advances time."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def make_guard(clock: FakeClock, **kw: Any) -> UpstreamGuard:
    opts: dict[str, Any] = {
        "rate_per_min": 60,
        "burst": 4,
        "cooldown_initial_s": 30,
        "cooldown_max_s": 100,
        "unavailable_cooldown_s": 10,
        **kw,
    }
    return UpstreamGuard(clock=clock, sleep=clock.sleep, **opts)


class CountingProvider:
    """Counts calls per method; `error` (if set) is raised by every call."""

    def __init__(self) -> None:
        self.calls: dict[str, int] = {}
        self.error: Exception | None = None

    def _hit(self, op: str) -> None:
        self.calls[op] = self.calls.get(op, 0) + 1
        if self.error is not None:
            raise self.error

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self._hit("history")
        return pd.DataFrame(columns=BAR_COLUMNS)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        self._hit("symbol_info")
        return {"symbol": symbol}

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        self._hit("search")
        return []

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self._hit("quotes")
        return []

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self._hit("extended_quotes")
        return []

    def events(self, symbol: str) -> dict[str, Any]:
        self._hit("events")
        return {}

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        self._hit("news")
        return []

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        self._hit("fundamentals")
        return {}


# ---------------------------------------------------------------- UpstreamGuard


def test_bucket_allows_burst_then_waits_for_refill() -> None:
    clock = FakeClock()
    guard = make_guard(clock)
    for _ in range(4):
        guard.acquire()
    assert clock.sleeps == []
    guard.acquire()  # one token per second at 60/min
    assert clock.sleeps == [pytest.approx(1.0)]


def test_foreground_gives_up_after_max_wait() -> None:
    clock = FakeClock()
    guard = make_guard(clock, rate_per_min=6, burst=1)
    guard.acquire()
    with pytest.raises(RateLimited) as info:
        guard.acquire()  # next token in 10s, beyond the 2s wait
    assert info.value.retry_after == 10
    assert clock.sleeps == []
    assert guard.snapshot()["refused"]["budget"] == 1


def test_cost_above_burst_leaves_debt() -> None:
    clock = FakeClock()
    guard = make_guard(clock)
    guard.acquire(7)
    assert guard.snapshot()["tokens"] == -3
    with pytest.raises(RateLimited):
        guard.acquire()  # 4s until a token: too long to wait
    clock.now += 4
    guard.acquire()


def test_background_keeps_reserve_for_foreground() -> None:
    clock = FakeClock()
    guard = make_guard(clock)  # burst 4: reserve 1
    with guard.background():
        assert guard.in_background()
        for _ in range(3):
            guard.acquire()
        with pytest.raises(RateLimited):
            guard.acquire()
    assert not guard.in_background()
    guard.acquire()  # the reserved token
    assert clock.sleeps == []


def test_background_flag_follows_to_thread() -> None:
    guard = UpstreamGuard()

    async def run() -> bool:
        with guard.background():
            return await asyncio.to_thread(guard.in_background)

    assert asyncio.run(run()) is True


def test_rate_limit_breaker_honours_retry_after_and_backs_off() -> None:
    clock = FakeClock()
    guard = make_guard(clock)
    assert guard.on_rate_limited(5) == 30  # backoff wins over a short hint
    with pytest.raises(RateLimited) as info:
        guard.acquire()
    assert info.value.retry_after == 30
    clock.now += 29.5
    with pytest.raises(RateLimited) as info:
        guard.acquire()
    assert info.value.retry_after == 1
    clock.now += 1
    guard.acquire()

    assert guard.on_rate_limited(None) == 60  # doubled
    assert guard.on_rate_limited(None) == 100  # capped
    assert guard.on_rate_limited(500) == 100  # long hints are capped too
    guard.on_success()
    assert guard.snapshot()["backoffS"] == 30
    assert guard.snapshot()["refused"]["rate_limited"] == 2


def test_unavailable_breaker() -> None:
    clock = FakeClock()
    guard = make_guard(clock)
    guard.on_unavailable()
    with pytest.raises(UpstreamUnavailable):
        guard.acquire()
    snap = guard.snapshot()
    assert snap["unavailable"] is True and snap["unavailableForS"] == 10
    clock.now += 10
    guard.acquire()


# ---------------------------------------------------------------- GuardedProvider


def test_rate_limited_upstream_pauses_all_calls() -> None:
    clock = FakeClock()
    inner = CountingProvider()
    stats = CacheStats()
    prov = GuardedProvider(inner, make_guard(clock), stats)
    inner.error = RateLimited("slow down", 1)
    with pytest.raises(RateLimited) as info:
        prov.history("AAPL", "1d", None, None, False)
    assert info.value.retry_after == 30  # raised to the guard's cooldown

    inner.error = None
    for _ in range(3):
        with pytest.raises(RateLimited):
            prov.symbol_info("AAPL")
    assert inner.calls == {"history": 1}
    assert stats.counter("upstream.history.rate_limited") == 1
    assert stats.counter("upstream.symbol_info.refused") == 3

    clock.now += 30
    prov.symbol_info("AAPL")
    assert inner.calls["symbol_info"] == 1


def test_unavailable_upstream_pauses_calls() -> None:
    clock = FakeClock()
    inner = CountingProvider()
    prov = GuardedProvider(inner, make_guard(clock))
    inner.error = UpstreamUnavailable("offline")
    with pytest.raises(UpstreamUnavailable):
        prov.news("AAPL", 5)
    inner.error = None
    with pytest.raises(UpstreamUnavailable):
        prov.news("AAPL", 5)
    assert inner.calls == {"news": 1}


def test_symbol_not_found_counts_as_success() -> None:
    clock = FakeClock()
    inner = CountingProvider()
    guard = make_guard(clock)
    stats = CacheStats()
    prov = GuardedProvider(inner, guard, stats)
    guard.on_rate_limited(None)
    clock.now += 30
    inner.error = SymbolNotFound("NOPE")
    with pytest.raises(SymbolNotFound):
        prov.events("NOPE")
    assert guard.snapshot()["backoffS"] == 30  # reset from 60
    assert stats.counter("upstream.events.not_found") == 1
    assert stats.counter("upstream.events.errors") == 0


def test_other_errors_do_not_open_breakers() -> None:
    clock = FakeClock()
    inner = CountingProvider()
    stats = CacheStats()
    prov = GuardedProvider(inner, make_guard(clock), stats)
    inner.error = ProviderError("bad payload")
    for _ in range(2):
        with pytest.raises(ProviderError):
            prov.search("apple", 5)
    assert inner.calls == {"search": 2}
    assert stats.counter("upstream.search.errors") == 2


def test_costs_follow_upstream_requests() -> None:
    stats = CacheStats()
    prov = GuardedProvider(CountingProvider(), UpstreamGuard(burst=1000, rate_per_min=1e6), stats)
    prov.quotes(["A", "B", "C"])
    prov.quotes([f"S{i}" for i in range(51)])
    prov.extended_quotes([f"S{i}" for i in range(120)])
    prov.extended_quotes([])
    assert stats.counter("upstream.quotes.requests") == 3  # one v7 request, then two
    assert stats.counter("upstream.extended_quotes.requests") == 3
    assert stats.counter("upstream.extended_quotes.calls") == 2


def test_cache_stats_snapshot_nests_names() -> None:
    stats = CacheStats()
    stats.incr("upstream.history.calls", 2)
    stats.incr("bars.fresh")
    stats.set_gauge("cache.entries", 7)
    assert stats.snapshot() == {
        "bars": {"fresh": 1},
        "cache": {"entries": 7},
        "upstream": {"history": {"calls": 2}},
    }


# ---------------------------------------------------------------- app wiring


def strict_settings() -> Settings:
    return Settings(  # type: ignore[call-arg]
        _env_file=None,
        upstream_rate_per_min=60,
        upstream_burst=20,
        upstream_cooldown_initial_s=30,
        upstream_cooldown_max_s=900,
        upstream_unavailable_cooldown_s=10,
    )


def test_app_guards_injected_provider_and_reports_stats(tmp_path: Path) -> None:
    inner = CountingProvider()
    inner.error = RateLimited("slow down", 5)
    app = create_app(
        provider=inner,
        database_url=f"sqlite:///{tmp_path}/g.db",
        settings_override=strict_settings(),
    )
    with TestClient(app) as client:
        first = client.get("/api/bars", params={"symbol": "AAPL"})
        assert first.status_code == 429 and first.headers["Retry-After"] == "30"
        inner.error = None
        assert client.get("/api/bars", params={"symbol": "AAPL"}).status_code == 429
        assert client.get("/api/symbols/AAPL").status_code == 429
        assert inner.calls == {"history": 1}

        body = client.get("/api/cache/stats").json()
    assert body["upstream"]["history"] == {
        "calls": 1,
        "rate_limited": 1,
        "refused": 1,
        "requests": 1,
    }
    assert body["upstream"]["symbol_info"] == {"refused": 1}
    assert body["bars"] == {"backfill": 2}
    assert body["guard"]["rateLimited"] is True and body["guard"]["backoffS"] == 60


# ---------------------------------------------------------------- YahooProvider retries


def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)


def _failing(error: Exception, calls: list[int]) -> Any:
    def fn() -> int:
        calls.append(1)
        raise error

    return fn


def test_rate_limit_retries_override(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_sleep(monkeypatch)
    calls: list[int] = []
    prov = YahooProvider(min_interval=0, retries=3, rate_limit_retries=0)
    with pytest.raises(RateLimited) as info:
        prov._call(_failing(YFRateLimitError(), calls))
    assert len(calls) == 1 and info.value.retry_after == 1


def test_other_errors_retried_once(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_sleep(monkeypatch)
    calls: list[int] = []
    with pytest.raises(ProviderError):
        YahooProvider(min_interval=0, retries=4)._call(_failing(ValueError("junk"), calls))
    assert len(calls) == 2

    calls.clear()
    with pytest.raises(UpstreamUnavailable):
        YahooProvider(min_interval=0, retries=2)._call(_failing(TimeoutError("t"), calls))
    assert len(calls) == 3  # network failures keep the full retry count


def test_currency_cache_is_bounded_lru(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(yahoo, "_CURRENCY_CACHE_MAX", 2)
    prov = YahooProvider(min_interval=0)

    def remember(symbol: str, currency: str) -> None:
        prov._remember_currency(symbol, SimpleNamespace(history_metadata={"currency": currency}))

    remember("aapl", "USD")
    remember("SAP.DE", "EUR")
    assert prov._currency("AAPL") == "USD"  # now most recently used
    remember("7203.T", "JPY")
    assert prov._currency("SAP.DE") is None
    assert prov._currency("AAPL") == "USD" and prov._currency("7203.T") == "JPY"
