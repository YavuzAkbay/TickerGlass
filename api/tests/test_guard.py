import asyncio
import contextlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pandas as pd
import pytest
import yfinance as yf
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
    Usage,
    report_usage,
)
from tickerglass_api.providers.guard import FUNDAMENTALS_REQUESTS, GuardedProvider, UpstreamGuard
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
    prov.fundamentals("AAPL")
    assert stats.counter("upstream.fundamentals.requests") == 7


def test_guard_fundamentals_cost_matches_yahoo() -> None:
    assert FUNDAMENTALS_REQUESTS == yahoo._FUNDAMENTALS_REQUESTS


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


# ---------------------------------------------------------------- priorities


class FakeUtc:
    """Wall clock (UTC) for the daily allowance."""

    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def granted(guard: UpstreamGuard, level: Any, cost: int = 1) -> int:
    """How many calls of `level` the guard lets through before refusing one."""
    n = 0
    with guard.priority(level):
        while True:
            try:
                guard.acquire(cost)
            except RateLimited:
                return n
            n += 1


def test_burst_reserves_by_priority() -> None:
    results = {}
    for level in ("interactive", "visible", "background", "prefetch"):
        clock = FakeClock()
        guard = make_guard(clock, burst=10)
        if level == "interactive":
            for _ in range(10):
                guard.acquire()
            results[level] = 10
            continue
        results[level] = granted(guard, level)
        assert clock.sleeps == []  # below interactive nothing ever waits
    # Reserves of 0 / 10% / 25% / 50% of the burst stay untouched.
    assert results == {"interactive": 10, "visible": 9, "background": 7, "prefetch": 5}


def test_lower_priorities_leave_tokens_for_higher_ones() -> None:
    clock = FakeClock()
    guard = make_guard(clock, burst=10)
    assert granted(guard, "prefetch") == 5
    assert granted(guard, "background") == 2  # tokens 5 -> 3
    assert granted(guard, "visible") == 2  # tokens 3 -> 1
    guard.acquire()  # interactive takes the rest
    assert guard.snapshot()["refused"]["budget"] == 3


def test_priority_context_nests_and_restores() -> None:
    guard = UpstreamGuard()
    assert guard.current_priority() == "interactive" and not guard.in_background()
    with guard.priority("visible"):
        assert not guard.in_background()
        with guard.background():
            assert guard.current_priority() == "background" and guard.in_background()
            with guard.priority("prefetch"):
                assert guard.in_background()
        assert guard.current_priority() == "visible"
    assert guard.current_priority() == "interactive"
    with pytest.raises(ValueError), guard.priority("urgent"):  # type: ignore[arg-type]
        pass


def test_priority_follows_to_thread() -> None:
    guard = UpstreamGuard()

    async def run() -> str:
        with guard.priority("visible"):
            return await asyncio.to_thread(guard.current_priority)

    assert asyncio.run(run()) == "visible"


# ---------------------------------------------------------------- daily allowance

DAY = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)


def daily_guard(limit: int = 100, now: datetime = DAY, **kw: Any) -> tuple[UpstreamGuard, FakeUtc]:
    utc = FakeUtc(now)
    opts: dict[str, Any] = {"burst": 1000, "rate_per_min": 1e6, **kw}
    return make_guard(FakeClock(), daily_limit=limit, utcnow=utc, **opts), utc


def test_daily_limit_refuses_until_utc_midnight() -> None:
    guard, utc = daily_guard(now=datetime(2026, 6, 17, 23, 0, tzinfo=UTC))
    guard.acquire(60)
    guard.acquire(40)
    tokens = guard.snapshot()["tokens"]
    with pytest.raises(RateLimited) as info:
        guard.acquire()
    assert info.value.retry_after == 3600  # to 00:00 UTC
    assert guard.snapshot()["refused"]["daily"] == 1
    assert guard.snapshot()["tokens"] == tokens  # a refusal costs nothing

    utc.now = datetime(2026, 6, 17, 23, 59, 59, tzinfo=UTC)
    with pytest.raises(RateLimited) as info:
        guard.acquire()
    assert info.value.retry_after == 1

    utc.now = datetime(2026, 6, 18, 0, 0, 0, tzinfo=UTC)
    guard.acquire(30)
    daily = guard.snapshot()["daily"]
    assert daily["used"] == 30 and daily["left"] == 70
    assert daily["resetAt"] == "2026-06-19T00:00:00Z"


def test_daily_cost_larger_than_what_is_left_is_refused() -> None:
    guard, _ = daily_guard()
    guard.acquire(95)
    with pytest.raises(RateLimited):
        guard.acquire(10)
    guard.acquire(5)  # the rest still fits
    assert guard.snapshot()["daily"]["left"] == 0


def test_daily_reserves_keep_credits_for_higher_priorities() -> None:
    guard, _ = daily_guard()
    with guard.priority("background"):
        for _ in range(85):  # refused once fewer than 15% would be left
            guard.acquire()
        with pytest.raises(RateLimited):
            guard.acquire()
    with guard.priority("visible"):
        for _ in range(10):  # down to 5%
            guard.acquire()
        with pytest.raises(RateLimited) as info:
            guard.acquire()
        assert "reserved" in str(info.value)
    for _ in range(5):
        guard.acquire()  # interactive may use it all
    with pytest.raises(RateLimited) as info:
        guard.acquire()
    assert "used up" in str(info.value)
    assert guard.snapshot()["refused"]["daily"] == 3


def test_no_daily_limit_by_default() -> None:
    clock = FakeClock()
    guard = make_guard(clock, burst=1000, rate_per_min=1e6)
    guard.acquire(500)
    snap = guard.snapshot()
    assert snap["daily"] is None and snap["state"] == "ok"
    assert guard.sustainable_rate_per_min() == pytest.approx(1e6)


def test_daily_exhaustion_from_the_upstream_closes_the_day() -> None:
    utc = FakeUtc(datetime(2026, 6, 17, 22, 0, tzinfo=UTC))
    guard = make_guard(FakeClock(), burst=1000, rate_per_min=1e6, daily_limit=800, utcnow=utc)
    inner = CountingProvider()
    prov = GuardedProvider(inner, guard)
    inner.error = RateLimited("out of credits for the day", 60, daily=True)
    with pytest.raises(RateLimited) as info:
        prov.quotes(["A"])
    assert info.value.retry_after == 2 * 3600
    snap = guard.snapshot()
    assert snap["daily"]["used"] == 800 and snap["state"] == "exhausted"
    assert not snap["rateLimited"]  # no cooldown: the daily check refuses by itself
    inner.error = None
    with pytest.raises(RateLimited):
        prov.quotes(["A"])
    assert inner.calls == {"quotes": 1}
    utc.now = datetime(2026, 6, 18, 0, 0, 1, tzinfo=UTC)
    prov.quotes(["A"])
    assert inner.calls == {"quotes": 2}


def test_daily_refusal_without_a_limit_is_an_ordinary_one() -> None:
    inner = CountingProvider()
    inner.error = RateLimited("daily", 5, daily=True)
    guard = make_guard(FakeClock())
    with pytest.raises(RateLimited):
        GuardedProvider(inner, guard).quotes(["A"])
    assert guard.snapshot()["rateLimited"] is True


def test_sustainable_rate_spreads_the_day() -> None:
    guard, utc = daily_guard(800, datetime(2026, 6, 17, 0, 0, tzinfo=UTC), rate_per_min=8)
    # 800 credits over 24h: about 0.56 a minute, far below the per-minute rate.
    assert guard.sustainable_rate_per_min() == pytest.approx(800 / 1440)
    utc.now = datetime(2026, 6, 17, 23, 0, tzinfo=UTC)
    assert guard.sustainable_rate_per_min() == pytest.approx(8)  # 800/60 > rate: rate caps it
    guard.acquire(790)
    assert guard.sustainable_rate_per_min() == pytest.approx(10 / 60)
    utc.now = datetime(2026, 6, 17, 23, 59, 50, tzinfo=UTC)  # under a minute left
    assert guard.sustainable_rate_per_min() == pytest.approx(8)  # 10 left in <1 min: rate caps
    guard.acquire(5)
    assert guard.sustainable_rate_per_min() == pytest.approx(5.0)  # the last minute counts as 1
    guard.mark_daily_exhausted()
    assert guard.sustainable_rate_per_min() == 0


def test_sustainable_rate_is_the_rate_without_a_daily_limit() -> None:
    assert make_guard(FakeClock(), rate_per_min=55).sustainable_rate_per_min() == pytest.approx(55)


# ---------------------------------------------------------------- calibration


def test_calibrate_lowers_tokens_but_never_raises_them() -> None:
    guard = make_guard(FakeClock(), rate_per_min=60, burst=20)
    guard.calibrate(minute_used=3, minute_left=5)
    assert guard.snapshot()["tokens"] == 5
    guard.calibrate(minute_used=0, minute_left=50)
    assert guard.snapshot()["tokens"] == 5
    guard.acquire(5)
    guard.calibrate(minute_used=1, minute_left=2)
    assert guard.snapshot()["tokens"] == 0


def test_calibrate_takes_the_per_minute_limit_from_used_plus_left() -> None:
    guard = make_guard(FakeClock(), rate_per_min=60, burst=20)
    assert guard.snapshot()["calibrated"] is False
    guard.calibrate(minute_used=3, minute_left=5)
    snap = guard.snapshot()
    assert snap["ratePerMin"] == pytest.approx(8) and snap["burst"] == 8
    assert snap["calibrated"] is True
    guard.calibrate(minute_used=0, minute_left=55)  # a larger plan: rate follows, burst stays
    assert guard.snapshot()["ratePerMin"] == pytest.approx(55)
    assert guard.snapshot()["burst"] == 8


def test_calibrate_keeps_limits_the_user_set() -> None:
    guard = make_guard(
        FakeClock(),
        rate_per_min=60,
        burst=20,
        daily_limit=500,
        calibrate_rate=False,
        calibrate_daily=False,
    )
    guard.calibrate(minute_used=3, minute_left=5, daily_limit=800, daily_used=40)
    snap = guard.snapshot()
    assert snap["ratePerMin"] == pytest.approx(60) and snap["burst"] == 20
    assert snap["tokens"] == 5  # still lowered
    assert snap["daily"]["limit"] == 500 and snap["daily"]["used"] == 40
    assert snap["calibrated"] is False


def test_calibrate_daily_count_only_grows() -> None:
    guard, _ = daily_guard(800)
    guard.acquire(10)
    guard.calibrate(daily_used=300, daily_limit=800)
    assert guard.snapshot()["daily"]["used"] == 300
    guard.calibrate(daily_used=120)  # another response, older: ignored
    assert guard.snapshot()["daily"]["used"] == 300
    guard.calibrate(daily_limit=1000)
    assert guard.snapshot()["daily"]["limit"] == 1000


def test_guarded_calls_report_usage_to_the_guard() -> None:
    class Reporting(CountingProvider):
        def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
            report_usage(minute_used=2, minute_left=6, daily_used=50, daily_limit=800)
            return []

    guard, _ = daily_guard(1000, rate_per_min=60)
    GuardedProvider(Reporting(), guard).quotes(["A"])
    snap = guard.snapshot()
    assert snap["ratePerMin"] == pytest.approx(8) and snap["tokens"] == 6
    assert snap["daily"]["limit"] == 800 and snap["daily"]["used"] == 50
    report_usage(minute_left=0)  # outside a guarded call: nothing happens
    assert guard.snapshot()["tokens"] == 6


def test_seed_usage_calibrates_from_a_metered_provider() -> None:
    class Metered(CountingProvider):
        def usage(self) -> Usage:
            self._hit("usage")
            return Usage(minute_limit=8, minute_used=3, daily_limit=800, daily_used=420)

    guard, _ = daily_guard(1000, rate_per_min=60)
    prov = GuardedProvider(Metered(), guard)
    assert prov.seed_usage() is True
    snap = guard.snapshot()
    assert snap["tokens"] == 5 and snap["ratePerMin"] == pytest.approx(8)
    assert snap["daily"]["limit"] == 800 and snap["daily"]["used"] == 420
    assert GuardedProvider(CountingProvider(), guard).seed_usage() is False


def test_snapshot_state_and_retry_after() -> None:
    clock = FakeClock()
    guard = make_guard(clock, rate_per_min=60, burst=4)
    assert guard.snapshot()["state"] == "ok" and guard.snapshot()["retryAfterS"] == 0
    guard.acquire(4)
    snap = guard.snapshot()
    # A one-second wait is ordinary pacing: reported, but not "throttled".
    assert snap["state"] == "ok" and snap["retryAfterS"] == 1
    clock.now += 1
    assert guard.snapshot()["state"] == "ok" and guard.snapshot()["retryAfterS"] == 0
    guard.on_rate_limited(20)
    snap = guard.snapshot()
    assert snap["state"] == "throttled" and snap["retryAfterS"] == 30
    assert timedelta(seconds=snap["retryAfterS"]) > timedelta(0)


def test_snapshot_throttled_only_for_waits_over_five_seconds() -> None:
    clock = FakeClock()
    guard = make_guard(clock, rate_per_min=6, burst=4)  # a token every 10 s
    guard.acquire(4)
    snap = guard.snapshot()
    assert snap["retryAfterS"] == 10 and snap["state"] == "throttled"
    clock.now += 5  # half a token back: 5 s to wait
    snap = guard.snapshot()
    assert snap["retryAfterS"] == 5 and snap["state"] == "ok"
    clock.now += 1
    assert guard.snapshot()["retryAfterS"] == 4


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


# ---------------------------------------------------------------- extra upstream cost


def _v7_broken_yahoo(
    monkeypatch: pytest.MonkeyPatch, downloads: list[list[str]], **kw: Any
) -> YahooProvider:
    """A YahooProvider whose v7 endpoint fails with a payload error and whose download
    fallback records the symbols it was asked for."""

    def download(symbols: list[str], **kwargs: Any) -> pd.DataFrame:
        downloads.append(list(symbols))
        return pd.DataFrame()

    monkeypatch.setattr(yf, "download", download)
    prov = YahooProvider(min_interval=0, retries=0, **kw)

    def v7(chunk: list[str]) -> list[dict[str, Any]]:
        raise ProviderError("Yahoo v7 quote: unexpected payload")

    prov._v7_quote = v7  # type: ignore[method-assign]
    return prov


def test_quote_download_fallback_is_charged_per_symbol(monkeypatch: pytest.MonkeyPatch) -> None:
    downloads: list[list[str]] = []
    stats = CacheStats()
    guard = UpstreamGuard(burst=1000, rate_per_min=1e6)
    prov = GuardedProvider(_v7_broken_yahoo(monkeypatch, downloads), guard, stats)
    prov.quotes(["A", "B", "C"])
    assert downloads == [["A", "B", "C"]]
    # One v7 request, then one download request per symbol.
    assert stats.counter("upstream.quotes.requests") == 4


def test_quote_fallback_refused_when_budget_cannot_cover_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    downloads: list[list[str]] = []
    clock = FakeClock()
    stats = CacheStats()
    guard = make_guard(clock, rate_per_min=6, burst=4)
    prov = GuardedProvider(_v7_broken_yahoo(monkeypatch, downloads), guard, stats)
    with pytest.raises(RateLimited):
        prov.quotes(["A", "B", "C", "D", "E"])  # 3 tokens left after v7, 5 needed
    assert downloads == []
    snap = guard.snapshot()
    assert snap["rateLimited"] is False and snap["backoffS"] == 30  # a local refusal
    assert stats.counter("upstream.quotes.refused") == 1
    assert stats.counter("upstream.quotes.rate_limited") == 0


def test_provider_retries_are_charged(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_sleep(monkeypatch)
    failures: list[Exception] = [TimeoutError("t"), TimeoutError("t"), ValueError("junk")]
    attempts: list[int] = []

    class FakeSearch:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            attempts.append(1)
            if failures:
                raise failures.pop(0)
            self.quotes: list[dict[str, Any]] = []

    monkeypatch.setattr(yf, "Search", FakeSearch)
    stats = CacheStats()
    guard = UpstreamGuard(burst=1000, rate_per_min=1e6)
    prov = GuardedProvider(YahooProvider(min_interval=0, retries=2), guard, stats)
    assert prov.search("apple", 5) == []
    assert len(attempts) == 4  # two network retries, one generic retry
    assert stats.counter("upstream.search.requests") == 4


def test_retry_skipped_when_budget_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    _no_sleep(monkeypatch)
    attempts: list[int] = []

    class FakeSearch:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            attempts.append(1)
            raise TimeoutError("t")

    monkeypatch.setattr(yf, "Search", FakeSearch)
    clock = FakeClock()
    guard = make_guard(clock, rate_per_min=6, burst=1)
    prov = GuardedProvider(YahooProvider(min_interval=0, retries=4), guard)
    with pytest.raises(UpstreamUnavailable):
        prov.search("apple", 5)
    assert len(attempts) == 1  # no token left for a retry: the original failure is raised


# ---------------------------------------------------------------- breaker epochs


class NestedProvider(CountingProvider):
    """`history` calls itself `depth` times before answering, so every call is issued
    before any of them returns; each then raises `errors[level]` (or succeeds)."""

    def __init__(self, prov: list[GuardedProvider], errors: list[Exception | None]) -> None:
        super().__init__()
        self.prov = prov
        self.errors = errors
        self.level = 0

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        level = self.level
        self.level += 1
        if self.level < len(self.errors):
            with contextlib.suppress(RateLimited):
                self.prov[0].history(symbol, interval, start, end, prepost)
        error = self.errors[level]
        if error is not None:
            raise error
        return pd.DataFrame(columns=BAR_COLUMNS)


def test_concurrent_rate_limits_escalate_once() -> None:
    clock = FakeClock()
    guard = make_guard(clock, burst=10, cooldown_max_s=10_000)
    holder: list[GuardedProvider] = []
    inner = NestedProvider(holder, [RateLimited("slow down", 1) for _ in range(5)])
    holder.append(GuardedProvider(inner, guard))
    with pytest.raises(RateLimited) as info:
        holder[0].history("AAPL", "1d", None, None, False)
    snap = guard.snapshot()
    assert snap["backoffS"] == 60  # doubled once, not five times
    assert snap["rateLimitedForS"] == 30
    assert info.value.retry_after == 30


def test_late_success_does_not_reset_backoff() -> None:
    clock = FakeClock()
    guard = make_guard(clock)
    holder: list[GuardedProvider] = []
    # The outer call was issued first, the inner one is refused, then the outer succeeds.
    inner = NestedProvider(holder, [None, RateLimited("slow down", 1)])
    holder.append(GuardedProvider(inner, guard))
    holder[0].history("AAPL", "1d", None, None, False)
    assert guard.snapshot()["backoffS"] == 60
    clock.now += 30
    holder[0].symbol_info("AAPL")  # issued after the cooldown: resets
    assert guard.snapshot()["backoffS"] == 30


def test_news_search_fallback_is_charged(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeTicker:
        def __init__(self, symbol: str) -> None:
            pass

        def get_news(self, count: int) -> list[dict[str, Any]]:
            return []  # the primary news endpoint answers with nothing

    class FakeSearch:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.news: list[dict[str, Any]] = []

    monkeypatch.setattr(yf, "Ticker", FakeTicker)
    monkeypatch.setattr(yf, "Search", FakeSearch)
    stats = CacheStats()
    guard = UpstreamGuard(burst=1000, rate_per_min=1e6)
    prov = GuardedProvider(YahooProvider(min_interval=0), guard, stats)
    assert prov.news("AAPL", 5) == []
    assert stats.counter("upstream.news.requests") == 2
