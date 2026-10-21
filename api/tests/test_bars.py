import socket
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from curl_cffi.requests import exceptions as curl_exc
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session
from yfinance.exceptions import YFRateLimitError

from tickerglass_api.app import create_app
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.intervals import resolve_interval
from tickerglass_api.models import SeriesMeta
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    ProviderError,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from tickerglass_api.providers.yahoo import YahooProvider, _normalize
from tickerglass_api.services.bars import TAIL_RETRY_AFTER, BarService, _aware
from tickerglass_api.services.stats import CacheStats

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


class FlakyTailProvider(FakeProvider):
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
    provider = FakeProvider({("AAPL", "1d"): DAILY})
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
