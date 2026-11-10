"""Screener fundamentals: the `ScreenInfoProvider` capability (Yahoo, demo, guard) and the
fundamentals run (services/screener/fundamentals.py). No network."""

import asyncio
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_screener_job import Clock, Ctx, FakeProvider

from tickerglass_api.models import ScreenerFundamental
from tickerglass_api.providers import yahoo
from tickerglass_api.providers.base import (
    CostModel,
    ProviderUnsupported,
    SymbolNotFound,
    as_screen_info,
)
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.twelvedata import TwelveDataProvider
from tickerglass_api.services.screener.fundamentals import INFO_MAX_AGE, quote_values
from tickerglass_api.services.stats import CacheStats

NOW = datetime(2026, 11, 6, 23, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _db_dir(tmp_path: Path) -> None:
    Ctx.db_dir = tmp_path


class FundProvider(FakeProvider):
    """`FakeProvider` with the screener capability (demo values); records calls."""

    def __init__(self, clock: Clock) -> None:
        super().__init__(clock)
        self.batches: list[list[str]] = []
        self.infos: list[str] = []
        self.unknown_info: set[str] = set()

    def screen_fields(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.batches.append(list(symbols))
        return self.demo.screen_fields(symbols)

    def info(self, symbol: str) -> dict[str, Any]:
        self.infos.append(symbol)
        if symbol in self.unknown_info:
            raise SymbolNotFound(symbol)
        return self.demo.info(symbol)


def universe() -> list[tuple[str, str]]:
    return (
        [(f"S{i:03d}", "stocks") for i in range(60)]
        + [(f"E{i:03d}", "etfs") for i in range(30)]
        + [(f"C{i:03d}-USD", "crypto") for i in range(30)]
    )


def fundamentals(ctx: Ctx) -> dict[str, ScreenerFundamental]:
    with Session(ctx.engine) as s:
        rows = list(s.scalars(select(ScreenerFundamental)))
        for r in rows:
            s.expunge(r)
        return {r.symbol: r for r in rows}


def test_fundamentals_run_batches_quotes_and_infos_stocks() -> None:
    async def scenario() -> None:
        clock = Clock()
        provider = FundProvider(clock)
        ctx = Ctx(clock, universe(), provider=provider)
        assert ctx.job.fundamentals_supported
        run = await ctx.run("fundamentals")
        assert (run.status, run.total, run.done, run.failed) == ("done", 180, 180, 0)
        assert [len(b) for b in provider.batches] == [50, 50, 20]
        assert ctx.stats.counter("upstream.screen_fields.requests") == 3
        assert ctx.stats.counter("upstream.info.requests") == 60
        assert run.tokens == 63
        assert sorted(provider.infos) == [f"S{i:03d}" for i in range(60)]
        # Paced: 3 batches at 24/min, 60 infos at 10/min.
        assert clock.sleeps == [2.5] * 3 + [6.0] * 60
        rows = fundamentals(ctx)
        assert len(rows) == 120
        stock, etf = rows["S000"], rows["E000"]
        assert stock.mcap is not None and stock.mcap > 0
        assert stock.sector is not None and stock.beta is not None
        assert stock.quote_at is not None and stock.info_at is not None
        assert etf.sector is None and etf.info_at is None
        assert stock.next_earnings_ts is not None and stock.next_earnings_ts > NOW.timestamp()
        assert stock.div_yield_pct is not None and 0 <= stock.div_yield_pct <= 6

        # Next night: the quote pass again, the infos are fresh.
        provider.batches.clear()
        provider.infos.clear()
        clock.t += timedelta(days=1)
        run = await ctx.run("fundamentals")
        assert (run.status, run.total) == ("done", 120)
        assert len(provider.batches) == 3 and provider.infos == []
        # A week on, the infos are due again.
        clock.t += INFO_MAX_AGE
        run = await ctx.run("fundamentals")
        assert len(provider.infos) == 60

    asyncio.run(scenario())


def test_unknown_info_symbol_is_stamped_and_counted_failed() -> None:
    async def scenario() -> None:
        clock = Clock()
        provider = FundProvider(clock)
        provider.unknown_info.add("S001")
        ctx = Ctx(clock, [("S000", "stocks"), ("S001", "stocks")], provider=provider)
        run = await ctx.run("fundamentals")
        assert (run.status, run.failed) == ("partial", 1)
        row = fundamentals(ctx)["S001"]
        assert row.info_at is not None and row.sector is None
        provider.infos.clear()
        await ctx.run("fundamentals")
        assert provider.infos == []  # asked again only once the week is over

    asyncio.run(scenario())


def test_provider_without_capability() -> None:
    async def scenario() -> None:
        clock = Clock()
        ctx = Ctx(clock, universe()[:3])
        assert not ctx.job.fundamentals_supported
        assert as_screen_info(ctx.provider) is None
        with pytest.raises(ProviderUnsupported):
            ctx.guarded.screen_fields(["S000"])
        with pytest.raises(ProviderUnsupported):
            ctx.guarded.info("S000")
        run = await ctx.run("fundamentals")
        assert run.status == "failed"
        assert run.error is not None and "not supported" in run.error

    asyncio.run(scenario())


def test_capability_detection() -> None:
    assert as_screen_info(DemoProvider()) is not None
    assert as_screen_info(yahoo.YahooProvider(min_interval=0)) is not None
    assert as_screen_info(TwelveDataProvider) is None  # technicals only


def test_guard_chunks_per_symbol_costs_like_quotes() -> None:
    calls: list[list[str]] = []

    class PerSymbol:
        def screen_fields(self, symbols: list[str]) -> list[dict[str, Any]]:
            calls.append(list(symbols))
            return [{"symbol": s} for s in symbols]

        def info(self, symbol: str) -> dict[str, Any]:
            return {}

    stats = CacheStats()
    guard = UpstreamGuard(rate_per_min=1e6, burst=8)
    costs = CostModel(quote_batch=120, quote_per_request=0, quote_per_symbol=1)
    guarded = GuardedProvider(PerSymbol(), guard, stats, costs=costs)  # type: ignore[arg-type]
    rows = guarded.screen_fields([f"X{i}" for i in range(20)])
    assert len(rows) == 20
    assert [len(c) for c in calls] == [8, 8, 4]
    assert stats.counter("upstream.screen_fields.requests") == 20
    guarded.info("X1")
    assert stats.counter("upstream.info.requests") == 1


def test_yahoo_cost_is_one_token_per_50_symbols() -> None:
    stats = CacheStats()
    guard = UpstreamGuard(rate_per_min=1e6, burst=100)

    class Inner:
        def screen_fields(self, symbols: list[str]) -> list[dict[str, Any]]:
            return [{"symbol": s} for s in symbols]

        def info(self, symbol: str) -> dict[str, Any]:
            return {}

    guarded = GuardedProvider(Inner(), guard, stats)  # type: ignore[arg-type]
    guarded.screen_fields([f"X{i}" for i in range(120)])
    assert stats.counter("upstream.screen_fields.calls") == 1
    assert stats.counter("upstream.screen_fields.requests") == 3


def test_quote_values_mapping() -> None:
    now = NOW
    future = int(now.timestamp()) + 5 * 86400
    later = future + 86400
    past = int(now.timestamp()) - 30 * 86400
    v = quote_values(
        {
            "marketCap": 2.5e12,
            "trailingPE": 31.5,
            "forwardPE": 28.0,
            "epsTrailingTwelveMonths": 6.1,
            "trailingAnnualDividendYield": 0.0052,
            "dividendYield": 0.55,
            "sharesOutstanding": 1.5e10,
            "earningsTimestamp": past,
            "earningsTimestampStart": later,
            "earningsTimestampEnd": future,
        },
        now,
    )
    assert v["mcap"] == 2.5e12 and v["pe"] == 31.5 and v["fwd_pe"] == 28.0
    assert v["eps_ttm"] == 6.1 and v["shares_out"] == 1.5e10
    assert v["div_yield_pct"] == pytest.approx(0.52)
    assert v["next_earnings_ts"] == future
    # `dividendYield` (percent) only without the trailing yield; junk is dropped.
    v = quote_values(
        {"dividendYield": 1.2, "trailingPE": "n/a", "marketCap": math.inf, "eps": None}, now
    )
    assert v["div_yield_pct"] == 1.2
    assert v["pe"] is None and v["mcap"] is None and v["next_earnings_ts"] is None


def test_mcap_is_stored_only_for_usd_quotes() -> None:
    usd = quote_values({"marketCap": 5e9, "currency": "USD"}, NOW)
    assert usd["mcap"] == 5e9
    assert quote_values({"marketCap": 5e9, "currency": "usd "}, NOW)["mcap"] == 5e9
    assert quote_values({"marketCap": 5e9}, NOW)["mcap"] == 5e9  # no currency named
    for code in ("EUR", "GBp", "JPY"):
        v = quote_values({"marketCap": 5e9, "currency": code, "trailingPE": 12.0}, NOW)
        assert v["mcap"] is None and v["pe"] == 12.0


def test_yahoo_screen_row_keeps_currency_codes(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = yahoo.YahooProvider(min_interval=0)
    monkeypatch.setattr(
        provider,
        "_v7_quote",
        lambda chunk: [
            {"symbol": s, "marketCap": 1e9, "currency": "EUR", "financialCurrency": " "}
            for s in chunk
        ],
    )
    (row,) = provider.screen_fields(["SAP.DE"])
    assert row == {"symbol": "SAP.DE", "marketCap": 1e9, "currency": "EUR"}


def test_yahoo_screen_fields_uses_v7_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = yahoo.YahooProvider(min_interval=0)
    chunks: list[list[str]] = []

    def fake_v7(chunk: list[str]) -> list[dict[str, Any]]:
        chunks.append(chunk)
        return [
            {
                "symbol": s,
                "marketCap": 1e9,
                "trailingPE": "Infinity",
                "forwardPE": 12.5,
                "regularMarketPrice": 10.0,  # not a screener field
                "earningsTimestamp": 1_800_000_000,
            }
            for s in chunk
        ] + [{"symbol": None}]

    monkeypatch.setattr(provider, "_v7_quote", fake_v7)
    rows = provider.screen_fields([f"X{i}" for i in range(120)])
    assert [len(c) for c in chunks] == [50, 50, 20]
    assert len(rows) == 120
    assert rows[0] == {
        "symbol": "X0",
        "marketCap": 1e9,
        "forwardPE": 12.5,
        "earningsTimestamp": 1_800_000_000,
    }


def test_yahoo_info_reads_ticker_info_only(monkeypatch: pytest.MonkeyPatch) -> None:
    infos = {
        "AAPL": {"quoteType": "EQUITY", "beta": 1.2, "sector": "Technology", "industry": "HW"},
        "NOPE": {},
    }

    class Ticker:
        def __init__(self, symbol: str) -> None:
            self.info = infos[symbol]

        @property
        def income_stmt(self) -> None:
            raise AssertionError("statements must not be fetched")

    monkeypatch.setattr(yahoo.yf, "Ticker", Ticker)
    provider = yahoo.YahooProvider(min_interval=0)
    assert provider.info("AAPL") == {"beta": 1.2, "sector": "Technology", "industry": "HW"}
    with pytest.raises(SymbolNotFound):
        provider.info("NOPE")


def test_demo_values_are_deterministic() -> None:
    clock = Clock()
    a = DemoProvider(clock=clock.now)
    b = DemoProvider(clock=clock.now)
    assert a.screen_fields(["GLSS", "LENS"]) == b.screen_fields(["glss", "LENS"])
    assert a.info("GLSS") == b.info("GLSS")
    row = a.screen_fields(["GLSS"])[0]
    assert {"marketCap", "sharesOutstanding", "earningsTimestamp"} <= set(row)
