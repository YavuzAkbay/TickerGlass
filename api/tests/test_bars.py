import socket
import threading
from datetime import UTC, date, datetime, time, timedelta, tzinfo
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from curl_cffi.requests import exceptions as curl_exc
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, inspect, select, text
from sqlalchemy.orm import Session
from yfinance.exceptions import YFRateLimitError

from tickerglass_api.app import create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.intervals import resolve_interval
from tickerglass_api.models import Bar, SeriesMeta
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    ProviderError,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from tickerglass_api.providers.yahoo import YahooProvider, _normalize
from tickerglass_api.services.bars import (
    TAIL_RETRY_AFTER,
    BarService,
    PruneReport,
    TailPolicy,
    _aware,
)
from tickerglass_api.services.stats import CacheStats
from tickerglass_api.services.symbols import SymbolService
from tickerglass_api.settings import Settings

FIXTURES = Path(__file__).parent / "fixtures"


def load_raw(name: str) -> pd.DataFrame:
    df = pd.read_csv(FIXTURES / name, index_col=0)
    df.index = pd.to_datetime(df.index, utc=True)
    return df


DAILY = _normalize(load_raw("aapl_1d_raw.csv"))
LAST_DAILY_TS = int(DAILY["ts"].iat[-1])
# A moment shortly after the last fixture bar.
NOW = datetime.fromtimestamp(LAST_DAILY_TS, UTC) + timedelta(hours=20)


class FakeProvider:
    """Replays a recorded frame, filtered to the requested range."""

    def __init__(self, frames: dict[tuple[str, str], pd.DataFrame]) -> None:
        self.frames = frames
        self.calls: list[tuple[str, str, datetime | None, datetime | None]] = []

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self.calls.append((symbol, interval, start, end))
        df = self.frames.get((symbol, interval))
        if df is None:
            return pd.DataFrame(columns=BAR_COLUMNS)
        if start is not None:
            df = df[df["ts"] >= int(start.timestamp())]
        if end is not None:
            df = df[df["ts"] < int(end.timestamp())]
        return df.reset_index(drop=True)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        if (symbol, "1d") not in self.frames:
            raise SymbolNotFound(symbol)
        return {"symbol": symbol, "timezone": "America/New_York"}

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        return []

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return [{"symbol": "AAPL", "name": "Apple Inc."}][:limit]


class FullProvider(FakeProvider):
    """`FakeProvider` plus the quote, event, news and fundamentals calls, so it is a complete
    `MarketDataProvider`. None of them is used by the bar tests."""

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        return []

    def events(self, symbol: str) -> dict[str, Any]:
        raise SymbolNotFound(symbol)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        return []

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        raise SymbolNotFound(symbol)


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    url = f"sqlite:///{tmp_path}/t.db"
    run_migrations(url)
    return make_engine(url)


def test_first_request_backfills_then_serves_from_cache(engine: Engine) -> None:
    provider = FakeProvider({("AAPL", "1d"): DAILY})
    svc = BarService(engine, provider)
    spec = resolve_interval("1d")

    res = svc.get_bars("aapl", spec, False, limit=10, now=NOW)
    assert len(provider.calls) == 1
    assert provider.calls[0][2] is None  # daily backfill asks for full history
    assert res.bars["ts"].tolist() == DAILY["ts"].tolist()[-10:]
    assert res.has_more

    svc.get_bars("AAPL", spec, False, limit=10, now=NOW + timedelta(minutes=1))
    assert len(provider.calls) == 1  # within tail TTL: no upstream call


def test_tail_refresh_after_ttl_appends_new_bar(engine: Engine) -> None:
    provider = FakeProvider({("AAPL", "1d"): DAILY.iloc[:-1].reset_index(drop=True)})
    svc = BarService(engine, provider)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)

    provider.frames[("AAPL", "1d")] = DAILY
    res = svc.get_bars("AAPL", spec, False, limit=1, now=NOW + spec.tail_ttl)
    assert len(provider.calls) == 2
    assert provider.calls[1][2] is not None  # tail fetch has a start
    assert res.bars["ts"].tolist() == [LAST_DAILY_TS]


def test_retroactive_adjustment_triggers_rebackfill(engine: Engine) -> None:
    provider = FakeProvider({("AAPL", "1d"): DAILY})
    svc = BarService(engine, provider)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)

    # Simulate a 2:1 split: Yahoo rewrites all history at half the price.
    split = DAILY.copy()
    for col in ("open", "high", "low", "close", "adj_close"):
        split[col] = split[col] / 2
    provider.frames[("AAPL", "1d")] = split
    res = svc.get_bars("AAPL", spec, False, limit=20_000, now=NOW + spec.tail_ttl)

    assert provider.calls[-1][2] is None  # full re-backfill
    assert res.bars["close"].tolist() == pytest.approx(split["close"].tolist())


def test_adjusted_applies_dividend_factor(engine: Engine) -> None:
    svc = BarService(engine, FakeProvider({("AAPL", "1d"): DAILY}))
    spec = resolve_interval("1d")
    raw = svc.get_bars("AAPL", spec, False, limit=20_000, now=NOW).bars
    adj = svc.get_bars("AAPL", spec, False, limit=20_000, adjusted=True, now=NOW).bars

    assert adj["close"].tolist() == pytest.approx(raw["adj_close"].tolist())
    factor = raw["adj_close"] / raw["close"]
    assert adj["open"].tolist() == pytest.approx((raw["open"] * factor).tolist())


def test_paging_backwards_with_to(engine: Engine) -> None:
    svc = BarService(engine, FakeProvider({("AAPL", "1d"): DAILY}))
    spec = resolve_interval("1d")
    seen: list[int] = []
    end: int | None = None
    while True:
        res = svc.get_bars("AAPL", spec, False, end=end, limit=20, now=NOW)
        seen = res.bars["ts"].tolist() + seen
        if not res.has_more:
            break
        end = int(res.bars["ts"].iat[0])
    assert seen == DAILY["ts"].tolist()


def test_intraday_backfill_is_chunked(engine: Engine) -> None:
    provider = FakeProvider({})
    svc = BarService(engine, provider)
    with pytest.raises(SymbolNotFound):
        svc.get_bars("AAPL", resolve_interval("1m"), False, now=NOW)
    # 29 days of 1m history in 7-day chunks.
    assert len(provider.calls) == 5
    for _, _, start, end in provider.calls:
        assert start is not None and end is not None
        assert end - start <= timedelta(days=7)


def test_prepost_ignored_for_daily(engine: Engine) -> None:
    provider = FakeProvider({("AAPL", "1d"): DAILY})
    svc = BarService(engine, provider)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, True, now=NOW)
    svc.get_bars("AAPL", spec, False, now=NOW)
    assert len(provider.calls) == 1


def test_normalize_snaps_live_quote_row() -> None:
    raw = load_raw("aapl_5m_prepost_raw.csv")
    out = _normalize(raw)
    assert list(out.columns) == BAR_COLUMNS
    assert (out["ts"] % 300 == 0).all()
    assert out["ts"].is_unique and out["ts"].is_monotonic_increasing


def test_normalize_merges_live_row_into_current_bar() -> None:
    base = 1_791_900_000  # multiple of 300
    idx = pd.to_datetime([base, base + 300, base + 400], unit="s", utc=True)
    raw = pd.DataFrame(
        {
            "Open": [1.0, 2.0, 2.5],
            "High": [1.5, 2.2, 3.0],
            "Low": [0.9, 1.9, 1.8],
            "Close": [1.2, 2.1, 2.9],
            "Adj Close": [1.2, 2.1, 2.9],
            "Volume": [10, 20, 0],
        },
        index=idx,
    )
    out = _normalize(raw)
    assert out["ts"].tolist() == [base, base + 300]
    last = out.iloc[-1]
    assert (last["high"], last["low"], last["close"]) == (3.0, 1.8, 2.9)


def test_bars_endpoint_contract(tmp_path: Path) -> None:
    app = create_app(
        provider=FakeProvider({("AAPL", "1d"): DAILY}), database_url=f"sqlite:///{tmp_path}/a.db"
    )
    with TestClient(app) as client:
        res = client.get("/api/bars", params={"symbol": "aapl", "interval": "1d", "limit": 5})
        assert res.status_code == 200
        body = res.json()
        assert body["symbol"] == "AAPL" and body["interval"] == "1d"
        columns = [body[k] for k in ("t", "o", "h", "l", "c", "v")]
        assert all(len(col) == 5 for col in columns)
        assert body["hasMore"] is True

        assert client.get("/api/bars", params={"symbol": "NOPE"}).status_code == 404
        assert (
            client.get("/api/bars", params={"symbol": "AAPL", "interval": "7m"}).status_code == 422
        )
        # "1h" is accepted as an alias for 60m (no 60m fixture, so not found rather than 422).
        assert (
            client.get("/api/bars", params={"symbol": "AAPL", "interval": "1h"}).status_code == 404
        )


def test_bars_endpoint_to_is_exclusive_upper_bound(tmp_path: Path) -> None:
    # Market replay pages forward with `to` mid-history and past "now".
    app = create_app(
        provider=FakeProvider({("AAPL", "1d"): DAILY}), database_url=f"sqlite:///{tmp_path}/a.db"
    )
    ts = DAILY["ts"].tolist()
    with TestClient(app) as client:
        mid = ts[len(ts) // 2]
        res = client.get(
            "/api/bars", params={"symbol": "AAPL", "interval": "1d", "limit": 3, "to": mid}
        )
        assert res.status_code == 200
        body = res.json()
        assert body["t"] == ts[len(ts) // 2 - 3 : len(ts) // 2]
        assert body["hasMore"] is True

        future = ts[-1] + 365 * 86_400
        res = client.get(
            "/api/bars", params={"symbol": "AAPL", "interval": "1d", "limit": 2, "to": future}
        )
        assert res.status_code == 200
        assert res.json()["t"] == ts[-2:]


class FailingProvider(FakeProvider):
    def __init__(self, error: Exception) -> None:
        super().__init__({})
        self.error = error

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        raise self.error


@pytest.mark.parametrize(
    ("error", "status", "retry_after"),
    [
        (RateLimited("slow down", 16), 429, "16"),
        (UpstreamUnavailable("offline"), 503, None),
        (ProviderError("bad payload"), 502, None),
    ],
)
def test_provider_errors_map_to_statuses(
    tmp_path: Path, error: Exception, status: int, retry_after: str | None
) -> None:
    app = create_app(provider=FailingProvider(error), database_url=f"sqlite:///{tmp_path}/e.db")
    with TestClient(app) as client:
        res = client.get("/api/bars", params={"symbol": "AAPL", "interval": "1d"})
    assert res.status_code == status
    assert res.headers.get("Retry-After") == retry_after
    assert res.json()["detail"] == str(error)


def _fast_provider(retries: int = 1) -> YahooProvider:
    return YahooProvider(min_interval=0, retries=retries)


def test_call_raises_rate_limited_after_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)
    calls = 0

    def fn() -> int:
        nonlocal calls
        calls += 1
        raise YFRateLimitError()

    with pytest.raises(RateLimited) as info:
        _fast_provider(2)._call(fn)
    assert calls == 3 and info.value.retry_after == 4


@pytest.mark.parametrize(
    "error",
    [
        curl_exc.ConnectionError("down"),
        curl_exc.Timeout("slow"),
        TimeoutError("t"),
        socket.gaierror("dns"),
    ],
)
def test_call_raises_unavailable_on_connection_failure(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)

    def fn() -> int:
        raise error

    with pytest.raises(UpstreamUnavailable):
        _fast_provider()._call(fn)


@pytest.mark.parametrize("error", [PermissionError("cache"), FileNotFoundError("cache")])
def test_call_disk_errors_are_not_unavailable(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)

    def fn() -> int:
        raise error

    with pytest.raises(ProviderError) as info:
        _fast_provider()._call(fn)
    assert type(info.value) is ProviderError


def test_call_other_failures_stay_provider_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)

    def fn() -> int:
        raise ValueError("junk")

    with pytest.raises(ProviderError) as info:
        _fast_provider()._call(fn)
    assert type(info.value) is ProviderError


class FlakyTailProvider(FullProvider):
    """Serves the recorded frame until `error` is set, then raises it."""

    def __init__(self, frames: dict[tuple[str, str], pd.DataFrame]) -> None:
        super().__init__(frames)
        self.error: Exception | None = None

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        if self.error is not None:
            self.calls.append((symbol, interval, start, end))
            raise self.error
        return super().history(symbol, interval, start, end, prepost)


def _tail_fetched_at(engine: Engine) -> datetime:
    with Session(engine) as s:
        meta = s.get(SeriesMeta, ("AAPL", "1d", False))
        assert meta is not None
        return meta.tail_fetched_at


def test_tail_sync_skipped_when_range_ends_before_newest_bar(engine: Engine) -> None:
    provider = FullProvider({("AAPL", "1d"): DAILY})
    stats = CacheStats()
    svc = BarService(engine, provider, stats=stats)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)

    later = NOW + spec.tail_ttl
    res = svc.get_bars("AAPL", spec, False, end=LAST_DAILY_TS, limit=5, now=later)
    assert len(provider.calls) == 1  # paging back: no tail sync
    assert res.bars["ts"].tolist() == DAILY["ts"].tolist()[-6:-1]
    assert stats.counter("bars.covered") == 1

    svc.get_bars("AAPL", spec, False, end=LAST_DAILY_TS + 1, now=later)
    assert len(provider.calls) == 2  # the range reaches the newest bar
    assert stats.counter("bars.tail_refresh") == 1


@pytest.mark.parametrize("error", [ProviderError("bad payload"), UpstreamUnavailable("offline")])
def test_failed_tail_refresh_serves_cached_bars(engine: Engine, error: Exception) -> None:
    provider = FlakyTailProvider({("AAPL", "1d"): DAILY})
    stats = CacheStats()
    svc = BarService(engine, provider, stats=stats)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)
    fetched = _tail_fetched_at(engine)

    provider.error = error
    later = NOW + spec.tail_ttl
    res = svc.get_bars("AAPL", spec, False, limit=3, now=later)
    assert res.bars["ts"].tolist() == DAILY["ts"].tolist()[-3:]
    assert len(provider.calls) == 2
    assert _tail_fetched_at(engine) == fetched  # still due for a refresh
    assert stats.counter("bars.stale_error") == 1

    # Within the retry pause: cached bars, no upstream call.
    svc.get_bars("AAPL", spec, False, now=later + timedelta(seconds=10))
    assert len(provider.calls) == 2
    assert stats.counter("bars.stale_retry_wait") == 1

    # After the pause the refresh is retried and, once it works, recorded.
    provider.error = None
    retry = later + TAIL_RETRY_AFTER
    svc.get_bars("AAPL", spec, False, now=retry)
    assert len(provider.calls) == 3
    assert _aware(_tail_fetched_at(engine)) == retry


def test_failed_tail_refresh_honours_retry_after(engine: Engine) -> None:
    provider = FlakyTailProvider({("AAPL", "1d"): DAILY})
    svc = BarService(engine, provider)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)

    provider.error = RateLimited("slow down", 120)
    later = NOW + spec.tail_ttl
    svc.get_bars("AAPL", spec, False, now=later)
    svc.get_bars("AAPL", spec, False, now=later + timedelta(seconds=119))
    assert len(provider.calls) == 2
    svc.get_bars("AAPL", spec, False, now=later + timedelta(seconds=120))
    assert len(provider.calls) == 3


def test_failed_rebackfill_rolls_back_cached_bars(engine: Engine) -> None:
    provider = FlakyTailProvider({("AAPL", "1d"): DAILY})
    svc = BarService(engine, provider)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)

    # A re-adjusted tail starts a wipe + re-backfill, whose full fetch then fails.
    split = DAILY.copy()
    split["close"] = split["close"] / 2
    split["adj_close"] = split["adj_close"] / 2
    provider.frames[("AAPL", "1d")] = split
    real_history = FakeProvider.history

    def history(
        self: FlakyTailProvider,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        if start is None:
            self.calls.append((symbol, interval, start, end))
            raise UpstreamUnavailable("offline")
        return real_history(self, symbol, interval, start, end, prepost)

    provider.history = history.__get__(provider)  # type: ignore[method-assign]
    res = svc.get_bars("AAPL", spec, False, limit=20_000, now=NOW + spec.tail_ttl)
    assert provider.calls[-1][2] is None  # the re-backfill was attempted
    assert res.bars["close"].tolist() == pytest.approx(DAILY["close"].tolist())


def test_tail_refresh_failure_without_cached_bars_still_raises(engine: Engine) -> None:
    provider = FlakyTailProvider({})
    svc = BarService(engine, provider)
    provider.error = UpstreamUnavailable("offline")
    with pytest.raises(UpstreamUnavailable):
        svc.get_bars("AAPL", resolve_interval("1d"), False, now=NOW)


# ------------------------------------------------------ market-session schedule

NY = ZoneInfo("America/New_York")
TOKYO = ZoneInfo("Asia/Tokyo")
US_EQUITY: dict[str, Any] = {
    "symbol": "AAPL",
    "type": "equity",
    "timezone": "America/New_York",
    "session": "0930-1600",
}


def ny(y: int, m: int, d: int, hh: int = 0, mm: int = 0, ss: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, ss, tzinfo=NY).astimezone(UTC)


def weekdays(first: date, last: date) -> list[date]:
    days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
    return [d for d in days if d.weekday() < 5]


def bar_frame(stamps: list[datetime]) -> pd.DataFrame:
    rows = [(int(t.timestamp()), 1.0, 1.0, 1.0, 1.0, 1.0, 100.0) for t in stamps]
    return pd.DataFrame(rows, columns=BAR_COLUMNS)


def daily_frame(days: list[date], tz: tzinfo) -> pd.DataFrame:
    return bar_frame([datetime.combine(d, time(0), tz) for d in days])


def intraday_frame(days: list[date], step_s: int = 300) -> pd.DataFrame:
    stamps: list[datetime] = []
    for d in days:
        t, close = datetime.combine(d, time(9, 30), NY), datetime.combine(d, time(16), NY)
        while t < close:
            stamps.append(t)
            t += timedelta(seconds=step_s)
    return bar_frame(stamps)


class ClockedProvider(FullProvider):
    """Only serves bars that have opened by `clock`."""

    def __init__(self, frames: dict[tuple[str, str], pd.DataFrame]) -> None:
        super().__init__(frames)
        self.clock = datetime.min.replace(tzinfo=UTC)

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        df = super().history(symbol, interval, start, end, prepost)
        return df[df["ts"] <= int(self.clock.timestamp())].reset_index(drop=True)


class Scheduled:
    """A session-aware BarService over a ClockedProvider, driven by a fake clock."""

    def __init__(
        self,
        engine: Engine,
        frame: pd.DataFrame,
        interval: str,
        info: dict[str, Any] | None,
        *,
        symbol: str = "AAPL",
        lookup: bool = True,
    ) -> None:
        self.provider = ClockedProvider({(symbol, interval): frame})
        self.stats = CacheStats()

        def session_lookup(s: str) -> dict[str, Any] | None:
            return info if s == symbol else None

        self.svc = BarService(
            engine,
            self.provider,
            stats=self.stats,
            session_lookup=session_lookup if lookup else None,
            policy=TailPolicy(),
        )
        self.engine = engine
        self.symbol = symbol
        self.spec = resolve_interval(interval)

    def at(self, when: datetime) -> bool:
        """Request the series at `when`; True if that fetched from upstream."""
        before = len(self.provider.calls)
        self.provider.clock = when
        self.svc.get_bars(self.symbol, self.spec, False, limit=1, now=when)
        return len(self.provider.calls) > before

    def poll(self, start: datetime, stop: datetime, step: timedelta) -> list[datetime]:
        """Request every `step` in [start, stop]; the times that fetched."""
        fetched: list[datetime] = []
        t = start
        while t <= stop:
            if self.at(t):
                fetched.append(t)
            t += step
        return fetched

    def meta(self) -> SeriesMeta:
        with Session(self.engine) as s:
            meta = s.get(SeriesMeta, (self.symbol, self.spec.name, False))
            assert meta is not None
            return meta

    def next_check(self) -> datetime | None:
        at = self.meta().next_check_at
        return None if at is None else _aware(at)

    def last_accessed(self) -> datetime | None:
        at = self.meta().last_accessed_at
        return None if at is None else _aware(at)


def test_saturday_makes_no_tail_calls(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 12))
    run = Scheduled(engine, daily_frame(days, NY), "1d", US_EQUITY)
    assert run.at(ny(2026, 10, 10, 12))  # backfill
    weekend = run.poll(ny(2026, 10, 10, 12, 5), ny(2026, 10, 12, 9, 25), timedelta(minutes=5))
    assert weekend == []
    assert run.stats.counter("bars.tail_skipped_closed") > 500
    assert run.next_check() == ny(2026, 10, 12, 9, 30)
    assert run.at(ny(2026, 10, 12, 9, 30))  # Monday's open


def test_unscheduled_series_catches_up_once_on_the_weekend(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 9))
    frame = daily_frame(days, NY)
    # Cached Friday mid-session without a schedule (no lookup).
    plain = Scheduled(engine, frame, "1d", US_EQUITY, lookup=False)
    assert plain.at(ny(2026, 10, 9, 12))
    assert plain.next_check() is None

    run = Scheduled(engine, frame, "1d", US_EQUITY)
    fetched = run.poll(ny(2026, 10, 10, 9), ny(2026, 10, 11, 23), timedelta(minutes=30))
    assert fetched == [ny(2026, 10, 10, 9)]  # Friday's settle check was overdue


def test_weekday_after_close_one_fetch_after_settle(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 13))
    run = Scheduled(engine, daily_frame(days, NY), "1d", US_EQUITY)
    assert run.at(ny(2026, 10, 12, 15, 58))  # backfill; 5 min later is past the close
    fetched = run.poll(ny(2026, 10, 12, 15, 59), ny(2026, 10, 13, 9, 29), timedelta(minutes=1))
    assert fetched == [ny(2026, 10, 12, 16, 20)]
    assert run.at(ny(2026, 10, 13, 9, 30))


def test_weekday_open_refreshes_at_ttl(engine: Engine) -> None:
    run = Scheduled(engine, intraday_frame([date(2026, 10, 12)]), "5m", US_EQUITY)
    assert run.at(ny(2026, 10, 12, 11))
    step = timedelta(seconds=10)
    fetched = run.poll(ny(2026, 10, 12, 11, 0, 10), ny(2026, 10, 12, 11, 30), step)
    assert fetched == [ny(2026, 10, 12, 11, 0, 30) + i * timedelta(seconds=30) for i in range(60)]
    assert run.meta().quiet_streak == 0
    assert run.stats.counter("bars.tail_skipped_fresh") == 180 - 60


def test_daily_open_refreshes_at_daily_ttl(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 12))
    run = Scheduled(engine, daily_frame(days, NY), "1d", US_EQUITY)
    assert run.at(ny(2026, 10, 12, 11))
    fetched = run.poll(ny(2026, 10, 12, 11, 1), ny(2026, 10, 12, 11, 30), timedelta(minutes=1))
    assert fetched == [ny(2026, 10, 12, 11, 5 * i) for i in range(1, 7)]


def test_crypto_refreshes_on_the_weekend(engine: Engine) -> None:
    first = date(2026, 9, 1)
    days = [first + timedelta(days=i) for i in range(41)]  # through Sunday 10-11
    crypto = {"symbol": "BTC-USD", "type": "cryptocurrency", "timezone": "UTC", "session": None}
    run = Scheduled(engine, daily_frame(days, UTC), "1d", crypto, symbol="BTC-USD")
    saturday = datetime(2026, 10, 10, 12, tzinfo=UTC)
    assert run.at(saturday)
    minute = timedelta(minutes=1)
    fetched = run.poll(saturday + minute, saturday + 60 * minute, minute)
    assert fetched == [saturday + 5 * i * minute for i in range(1, 13)]


def test_holiday_stops_refreshing_until_next_open(engine: Engine) -> None:
    # Monday 10-12 is a holiday: no bars between Friday and Tuesday.
    frame = intraday_frame([date(2026, 10, 9), date(2026, 10, 13)])
    run = Scheduled(engine, frame, "5m", US_EQUITY)
    assert run.at(ny(2026, 10, 12, 9))  # backfill before the open
    morning = run.poll(ny(2026, 10, 12, 9, 0, 30), ny(2026, 10, 12, 10, 30), timedelta(seconds=30))
    # Doubling pauses while quiet, then a jump to the next open past the grace.
    assert morning == [
        ny(2026, 10, 12, 9, 30),
        ny(2026, 10, 12, 9, 31),
        ny(2026, 10, 12, 9, 33),
        ny(2026, 10, 12, 9, 37),
        ny(2026, 10, 12, 9, 45),
        ny(2026, 10, 12, 10, 1),
    ]
    assert run.next_check() == ny(2026, 10, 13, 9, 30)
    rest = run.poll(ny(2026, 10, 12, 10, 40), ny(2026, 10, 13, 9, 20), timedelta(minutes=10))
    assert rest == []
    assert run.stats.counter("bars.tail_quiet") == 6
    # Tuesday's first bar ends the quiet streak.
    assert run.at(ny(2026, 10, 13, 9, 30))
    assert run.meta().quiet_streak == 0
    assert run.at(ny(2026, 10, 13, 9, 30, 30))


def test_tokyo_daily_after_close(engine: Engine) -> None:
    info = {"symbol": "7203.T", "type": "equity", "timezone": "Asia/Tokyo", "session": "0900-1530"}
    days = weekdays(date(2026, 9, 1), date(2026, 10, 22))
    run = Scheduled(engine, daily_frame(days, TOKYO), "1d", info, symbol="7203.T")

    def jst(d: int, hh: int, mm: int = 0) -> datetime:
        return datetime(2026, 10, d, hh, mm, tzinfo=TOKYO).astimezone(UTC)

    assert run.at(jst(21, 15))
    fetched = run.poll(jst(21, 15, 1), jst(22, 8, 59), timedelta(minutes=1))
    assert fetched == [jst(21, 15, m) for m in (5, 10, 15, 20, 25, 50)]
    assert run.at(jst(22, 9))


def test_without_lookup_weekend_keeps_plain_ttl(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 9))
    run = Scheduled(engine, daily_frame(days, NY), "1d", US_EQUITY, lookup=False)
    assert run.at(ny(2026, 10, 10, 12))
    fetched = run.poll(ny(2026, 10, 10, 12, 1), ny(2026, 10, 10, 12, 20), timedelta(minutes=1))
    assert fetched == [ny(2026, 10, 10, 12, m) for m in (5, 10, 15, 20)]
    assert run.next_check() is None
    assert run.stats.counter("bars.fresh") == 16
    assert run.stats.counter("bars.tail_skipped_closed") == 0


def test_lookup_without_stored_symbol_keeps_plain_ttl(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 9))
    run = Scheduled(engine, daily_frame(days, NY), "1d", None)
    assert run.at(ny(2026, 10, 10, 12))
    fetched = run.poll(ny(2026, 10, 10, 12, 1), ny(2026, 10, 10, 12, 20), timedelta(minutes=1))
    assert fetched == [ny(2026, 10, 10, 12, m) for m in (5, 10, 15, 20)]
    assert run.next_check() == ny(2026, 10, 10, 12, 25)


def test_last_accessed_at_is_throttled(engine: Engine) -> None:
    days = weekdays(date(2026, 9, 1), date(2026, 10, 9))
    run = Scheduled(engine, daily_frame(days, NY), "1d", US_EQUITY)
    start = ny(2026, 10, 10, 12)
    run.at(start)
    assert run.last_accessed() == start
    run.at(start + timedelta(minutes=59))
    assert run.last_accessed() == start
    later = start + timedelta(minutes=61)
    run.at(later)
    assert run.last_accessed() == later


def test_cached_info_never_calls_upstream(engine: Engine) -> None:
    provider = FullProvider({("AAPL", "1d"): DAILY})
    symbols = SymbolService(engine, provider)
    assert symbols.cached_info("aapl") is None
    info = symbols.info("AAPL")
    provider.frames.clear()  # upstream would now fail
    assert symbols.cached_info("aapl") == info


def test_app_schedules_bars_from_stored_symbol_info(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/a.db"
    app = create_app(provider=FullProvider({("AAPL", "1d"): DAILY}), database_url=url)
    with TestClient(app) as client:
        assert client.get("/api/symbols/AAPL").status_code == 200
        assert client.get("/api/bars", params={"symbol": "AAPL"}).status_code == 200
    engine = make_engine(url)
    with Session(engine) as s:
        meta = s.get(SeriesMeta, ("AAPL", "1d", False))
        assert meta is not None and meta.next_check_at is not None
    engine.dispose()


def test_series_schedule_migration_up_down_up(tmp_path: Path) -> None:
    from alembic import command
    from test_userdata import alembic_config

    url = f"sqlite:///{tmp_path}/m.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, "3f8a6c1d9e47")
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO series_meta VALUES "
                "('AAPL', '1d', 0, '2026-10-01 12:00:00.000000', '2026-10-02 12:00:00.000000')"
            )
        )
    new = {"next_check_at", "quiet_streak", "last_accessed_at"}

    def columns() -> set[str]:
        return {c["name"] for c in inspect(engine).get_columns("series_meta")}

    command.upgrade(cfg, "head")
    assert new <= columns()
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT next_check_at, quiet_streak, last_accessed_at FROM series_meta")
        ).one()
    assert tuple(row) == (None, 0, "2026-10-01 12:00:00.000000")
    command.downgrade(cfg, "3f8a6c1d9e47")
    assert not new & columns()
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM series_meta")).scalar() == 1
    command.upgrade(cfg, "head")
    assert new <= columns()
    engine.dispose()


# ------------------------------------------------------ overlap classification

# Weekdays from July through 2026-10-09: more 5m history than the 59-day lookback.
SUMMER = weekdays(date(2026, 7, 1), date(2026, 10, 9))
CACHED_AT = ny(2026, 8, 14, 12)  # first request (backfill)
REFRESH_AT = ny(2026, 10, 9, 12)  # eight weeks later: tail refresh


def priced(frame: pd.DataFrame) -> pd.DataFrame:
    """`frame` with a distinct price and volume per bar."""
    out = frame.copy()
    step = pd.Series(range(len(out)), dtype="float64")
    out["close"] = 100 + step * 0.01
    out["open"] = out["close"] - 0.05
    out["high"] = out["close"] + 0.2
    out["low"] = out["close"] - 0.3
    out["adj_close"] = out["close"]
    out["volume"] = 1000 + step
    return out


def cached_5m(
    engine: Engine, frame: pd.DataFrame
) -> tuple[ClockedProvider, CacheStats, BarService]:
    """A 5m series of `frame` backfilled at `CACHED_AT`."""
    provider = ClockedProvider({("AAPL", "5m"): frame})
    stats = CacheStats()
    svc = BarService(engine, provider, stats=stats)
    provider.clock = CACHED_AT
    svc.get_bars("AAPL", resolve_interval("5m"), False, now=CACHED_AT)
    assert len(provider.calls) == 1
    return provider, stats, svc


def stored(svc: BarService, interval: str, now: datetime) -> pd.DataFrame:
    return svc.get_bars("AAPL", resolve_interval(interval), False, limit=100_000, now=now).bars


def test_intraday_revision_upserts_and_keeps_history(engine: Engine) -> None:
    frame = priced(intraday_frame(SUMMER))
    provider, stats, svc = cached_5m(engine, frame)
    # The provider revises the second-newest cached bar (the newest closed one); the
    # backfill ended before `CACHED_AT`.
    revised = frame.copy()
    second = revised.index[revised["ts"] < int(CACHED_AT.timestamp())][-2]
    revised.loc[second, ["close", "adj_close"]] = 123.45
    provider.frames[("AAPL", "5m")] = revised
    provider.clock = REFRESH_AT

    bars = stored(svc, "5m", REFRESH_AT)
    assert len(provider.calls) == 2  # the tail fetch only
    assert provider.calls[1][2] is not None
    assert stats.counter("bars.overlap_revised") == 1
    assert stats.counter("bars.rebackfill") == 0
    # Everything up to now, including bars older than the provider's lookback.
    expected = revised[revised["ts"] <= int(REFRESH_AT.timestamp())]
    lookback_start = REFRESH_AT - resolve_interval("5m").max_lookback  # type: ignore[operator]
    assert bars["ts"].tolist()[0] < int(lookback_start.timestamp())
    assert bars["ts"].tolist() == expected["ts"].tolist()
    assert bars["close"].tolist() == pytest.approx(expected["close"].tolist())


def test_intraday_split_rescales_history_without_refetch(engine: Engine) -> None:
    frame = priced(intraday_frame(SUMMER))
    provider, stats, svc = cached_5m(engine, frame)
    # A 2:1 split: the provider rewrites its whole window at half the price, twice the volume.
    split = frame.copy()
    for col in ("open", "high", "low", "close", "adj_close"):
        split[col] = split[col] / 2
    split["volume"] = split["volume"] * 2
    provider.frames[("AAPL", "5m")] = split
    provider.clock = REFRESH_AT

    bars = stored(svc, "5m", REFRESH_AT)
    assert len(provider.calls) == 2
    assert stats.counter("bars.overlap_rescaled") == 1
    assert stats.counter("bars.rebackfill") == 0
    expected = split[split["ts"] <= int(REFRESH_AT.timestamp())]
    assert bars["ts"].tolist() == expected["ts"].tolist()
    for col in ("open", "high", "low", "close", "adj_close", "volume"):
        assert bars[col].tolist() == pytest.approx(expected[col].tolist()), col
    adjusted = svc.get_bars(
        "AAPL", resolve_interval("5m"), False, limit=100_000, adjusted=True, now=REFRESH_AT
    ).bars
    assert adjusted["close"].tolist() == pytest.approx(expected["close"].tolist())


def test_intraday_unchanged_overlap_counts_same(engine: Engine) -> None:
    frame = priced(intraday_frame(SUMMER))
    provider, stats, svc = cached_5m(engine, frame)
    provider.clock = REFRESH_AT
    stored(svc, "5m", REFRESH_AT)
    assert len(provider.calls) == 2
    assert stats.counter("bars.overlap_same") == 1


def test_daily_revision_still_rebackfills(engine: Engine) -> None:
    provider = FullProvider({("AAPL", "1d"): DAILY})
    stats = CacheStats()
    svc = BarService(engine, provider, stats=stats)
    spec = resolve_interval("1d")
    svc.get_bars("AAPL", spec, False, now=NOW)

    revised = DAILY.copy()
    revised.loc[revised.index[-2], ["close", "adj_close"]] *= 1.01
    provider.frames[("AAPL", "1d")] = revised
    res = svc.get_bars("AAPL", spec, False, limit=20_000, now=NOW + spec.tail_ttl)

    assert len(provider.calls) == 3  # backfill, tail, full re-backfill
    assert provider.calls[-1][2] is None
    assert stats.counter("bars.rebackfill") == 1
    assert res.bars["close"].tolist() == pytest.approx(revised["close"].tolist())


# ------------------------------------------------------------------- pruning

PRUNE_NOW = datetime(2026, 10, 21, 12, tzinfo=UTC)


def seed(
    engine: Engine,
    symbol: str,
    interval: str,
    rows: int,
    used: datetime,
    *,
    accessed: bool = True,
) -> None:
    """A cached series of `rows` bars, last read at `used` (or cached then, if not `accessed`)."""
    with Session(engine) as s:
        s.add(
            SeriesMeta(
                symbol=symbol,
                interval=interval,
                prepost=False,
                backfilled_at=used - timedelta(days=1000) if accessed else used,
                tail_fetched_at=used,
                quiet_streak=0,
                last_accessed_at=used if accessed else None,
            )
        )
        s.add_all(
            Bar(
                symbol=symbol,
                interval=interval,
                prepost=False,
                ts=1_700_000_000 + i * 60,
                open=1.0,
                high=1.0,
                low=1.0,
                close=1.0,
                adj_close=1.0,
                volume=1.0,
            )
            for i in range(rows)
        )
        s.commit()


def series_in(engine: Engine) -> set[str]:
    with Session(engine) as s:
        metas = {m.symbol for m in s.scalars(select(SeriesMeta))}
        bars = set(s.scalars(select(Bar.symbol).distinct()))
    assert metas == bars  # bars and meta go together
    return metas


def days_ago(n: float) -> datetime:
    return PRUNE_NOW - timedelta(days=n)


def prune(svc: BarService, max_rows: int = 1_000_000) -> PruneReport:
    return svc.prune(
        PRUNE_NOW, max_rows=max_rows, intraday_retention_days=30, daily_retention_days=365
    )


def test_prune_by_age(engine: Engine) -> None:
    seed(engine, "OLD5", "5m", 10, days_ago(31))
    seed(engine, "NEW5", "5m", 20, days_ago(29))
    seed(engine, "LEGACY", "1m", 5, days_ago(40), accessed=False)
    seed(engine, "OLDD", "1d", 7, days_ago(366))
    seed(engine, "MIDD", "1wk", 3, days_ago(100))
    stats = CacheStats()
    svc = BarService(engine, FullProvider({}), stats=stats)

    report = prune(svc)
    assert report == PruneReport(
        intraday_age_series=2,
        intraday_age_rows=15,
        daily_age_series=1,
        daily_age_rows=7,
        rows_remaining=23,
    )
    assert (report.series_deleted, report.rows_deleted) == (3, 22)
    assert series_in(engine) == {"NEW5", "MIDD"}
    assert stats.counter("bars.pruned_series") == 3
    assert stats.counter("bars.pruned_rows") == 22

    report = svc.prune_with_settings(Settings(bars_intraday_retention_days=7), now=PRUNE_NOW)
    assert (report.intraday_age_series, report.rows_remaining) == (1, 3)
    assert series_in(engine) == {"MIDD"}


def test_prune_by_budget_evicts_least_recently_used_intraday_first(engine: Engine) -> None:
    seed(engine, "A", "1d", 30, days_ago(10))
    seed(engine, "B", "5m", 30, days_ago(2))
    seed(engine, "C", "5m", 30, days_ago(5))
    seed(engine, "D", "1d", 30, days_ago(3))
    svc = BarService(engine, FullProvider({}))

    report = prune(svc, max_rows=100)  # 120 rows: evict down to 90
    assert report == PruneReport(budget_series=1, budget_rows=30, rows_remaining=90)
    assert series_in(engine) == {"A", "B", "D"}

    report = prune(svc, max_rows=60)  # 90 rows: evict down to 54
    assert report == PruneReport(budget_series=2, budget_rows=60, rows_remaining=30)
    assert series_in(engine) == {"D"}  # B (intraday) went before the older daily A

    assert prune(svc, max_rows=30) == PruneReport(rows_remaining=30)  # within budget


def test_prune_never_deletes_recently_used_series(engine: Engine) -> None:
    seed(engine, "HOT", "5m", 10, PRUNE_NOW - timedelta(hours=1))
    seed(engine, "WARM", "1d", 10, days_ago(2))
    seed(engine, "COLD", "5m", 10, days_ago(2))
    svc = BarService(engine, FullProvider({}))

    report = svc.prune(PRUNE_NOW, max_rows=1, intraday_retention_days=0, daily_retention_days=0)
    assert report.intraday_age_series == 1 and report.daily_age_series == 1
    assert report.rows_remaining == 10
    assert series_in(engine) == {"HOT"}

    report = svc.prune(
        PRUNE_NOW,
        max_rows=1,
        intraday_retention_days=0,
        daily_retention_days=0,
        protect_s=0,
    )
    assert report.intraday_age_series == 1
    assert series_in(engine) == set()


class BlockingProvider(FullProvider):
    """`history` waits for `release` after signalling `entered`."""

    def __init__(self) -> None:
        super().__init__({})
        self.entered = threading.Event()
        self.release = threading.Event()

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self.entered.set()
        assert self.release.wait(10)
        return super().history(symbol, interval, start, end, prepost)


def test_prune_skips_series_being_synced(engine: Engine) -> None:
    seed(engine, "BUSY", "1d", 10, days_ago(400))
    seed(engine, "IDLE", "1d", 10, days_ago(400))
    provider = BlockingProvider()
    svc = BarService(engine, provider)
    # A request refreshing BUSY's tail holds its lock while it waits on upstream.
    request = threading.Thread(
        target=svc.get_bars, args=("BUSY", resolve_interval("1d"), False), kwargs={"now": PRUNE_NOW}
    )
    request.start()
    try:
        assert provider.entered.wait(10)
        report = prune(svc)
    finally:
        provider.release.set()
        request.join(10)
    assert report == PruneReport(
        daily_age_series=1, daily_age_rows=10, skipped_busy=1, rows_remaining=10
    )
    assert series_in(engine) == {"BUSY"}
    # The request marked it used: protected from now on.
    assert prune(svc) == PruneReport(rows_remaining=10)
