"""Twelve Data provider over recorded responses (`td_fake.FakeTD`): plans, symbol mapping,
bars, quotes, errors, credit accounting and the guard/app around it. No network."""

import logging
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr
from td_fake import FakeTD, body_of, error, monthly_rows

from tickerglass_api.app import create_app
from tickerglass_api.providers import http as http_module
from tickerglass_api.providers import twelvedata as td
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    LocalRateLimited,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    Usage,
    metering,
)
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.registry import PROVIDERS, apply_setting_defaults, load_config
from tickerglass_api.settings import Settings

KEY = "td-test-key-0123456789"
NY = ZoneInfo("America/New_York")
# 12:00:20 UTC on a Tuesday: 41 seconds to the next minute (+1).
NOW = datetime(2026, 10, 27, 12, 0, 20, tzinfo=UTC)
SPEC = PROVIDERS["twelvedata"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("TWELVEDATA_"):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


def config(**kwargs: Any) -> td.TwelveDataConfig:
    return td.TwelveDataConfig(api_key=SecretStr(KEY), _env_file=None, **kwargs)  # type: ignore[call-arg]


def make(
    fake: FakeTD | None = None, now: datetime = NOW, **kwargs: Any
) -> tuple[td.TwelveDataProvider, FakeTD]:
    fake = fake or FakeTD()
    return td.TwelveDataProvider(config(**kwargs), send=fake, clock=lambda: now), fake


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


# -- plans -------------------------------------------------------------------------------


def test_plan_table() -> None:
    basic, grow, pro, ultra = (td.PLAN_PROFILES[p] for p in ("basic", "grow", "pro", "ultra"))
    assert (basic.credits_per_min, basic.daily_credits, basic.international) == (8, 800, False)
    assert (grow.credits_per_min, grow.daily_credits, grow.international) == (55, None, True)
    assert (pro.credits_per_min, pro.extended) == (610, True)
    assert ultra.credits_per_min == td.PLAN_PROFILES["enterprise"].credits_per_min == 2584
    for plan in td.PLAN_PROFILES.values():
        # Events and the profile are one credit each on every plan; no statements.
        assert plan.events and plan.fundamentals_info and not plan.fundamentals_statements
    assert (basic.quote_ttl_s, basic.poll_interval_s) == (300, 300)
    assert (basic.tail_ttl_intraday_s, basic.tail_ttl_daily_s) == (300, 3600)
    assert (grow.quote_ttl_s, grow.tail_ttl_daily_s) == (60, 1800)
    assert (pro.quote_ttl_s, pro.tail_ttl_intraday_s, pro.tail_ttl_daily_s) == (15, 30, 300)


def test_effective_profile_without_config_is_basic() -> None:
    assert td.effective_profile(None) is td.PLAN_PROFILES["basic"]
    assert SPEC.capabilities(None).markets == {"us", "fx", "crypto"}
    assert SPEC.plan(None) == "basic"


def test_env_overrides_win_over_the_plan(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TWELVEDATA_API_KEY", KEY)
    monkeypatch.setenv("TWELVEDATA_PLAN", "grow")
    monkeypatch.setenv("TWELVEDATA_CREDITS_PER_MIN", "30")
    monkeypatch.setenv("TWELVEDATA_DAILY_CREDITS", "5000")
    monkeypatch.setenv("TWELVEDATA_EXTENDED_HOURS", "true")
    monkeypatch.setenv("TWELVEDATA_EVENTS", "false")
    monkeypatch.setenv("TWELVEDATA_FUNDAMENTALS", "false")
    monkeypatch.setenv("TWELVEDATA_INTERNATIONAL", "false")
    monkeypatch.setenv("TWELVEDATA_POLL_INTERVAL_S", "90")
    loaded = load_config(SPEC)
    p = td.effective_profile(loaded)
    assert (p.credits_per_min, p.daily_credits, p.extended) == (30, 5000, True)
    assert (p.events, p.fundamentals_info, p.international) == (False, False, False)
    assert (p.poll_interval_s, p.quote_ttl_s) == (90, 90)  # a TTL below the poll is pointless
    caps = SPEC.capabilities(loaded)
    assert not caps.events and not caps.fundamentals_info and caps.extended_quotes
    assert "intl" not in caps.markets
    assert SPEC.costs(loaded).events == 0


def test_zero_daily_credits_removes_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    assert td.effective_profile(config(daily_credits=0)).daily_credits is None
    assert "upstream_daily_limit" not in SPEC.setting_defaults(config(daily_credits=0))
    assert SPEC.setting_defaults(None)["upstream_daily_limit"] == 800


def test_empty_env_values_count_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # docker-compose passes unset variables through as "".
    monkeypatch.setenv("TWELVEDATA_API_KEY", KEY)
    monkeypatch.setenv("TWELVEDATA_CREDITS_PER_MIN", "")
    monkeypatch.setenv("TWELVEDATA_EVENTS", "")
    p = td.effective_profile(load_config(SPEC))
    assert p.credits_per_min == 8 and p.events is True


def test_missing_key_is_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ProviderNotConfigured, match="TWELVEDATA_API_KEY is not set"):
        load_config(SPEC)


def test_spec_capabilities_costs_and_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    caps = SPEC.capabilities(None)
    assert caps.intervals == td.INTERVALS and "5d" not in caps.intervals
    assert not caps.news and not caps.streaming and not caps.adjusted_close
    assert not caps.extended_history and not caps.extended_quotes
    assert caps.events == {"dividends", "splits", "earnings"} and caps.fundamentals_info
    assert not caps.fundamentals_statements
    costs = SPEC.costs(None)
    assert (costs.history, costs.symbol_info, costs.search) == (1, 0, 0)
    assert (costs.quote_batch, costs.quote_per_request, costs.quote_per_symbol) == (120, 0, 1)
    assert (costs.events, costs.fundamentals) == (3, 1)
    assert costs.quotes(10) == 10
    grow = config(plan="grow")
    assert SPEC.capabilities(grow).markets == {"us", "fx", "crypto", "intl", "index"}
    assert SPEC.capabilities(config(plan="pro")).extended_quotes
    defaults = SPEC.setting_defaults(None)
    assert defaults["upstream_rate_per_min"] == 8 and defaults["upstream_burst"] == 8
    assert defaults["upstream_daily_limit"] == 800
    assert defaults["cache_negative_ttl_s"] == 6 * 3600
    # Every default names a real setting (apply_setting_defaults would raise otherwise).
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)  # conftest's permissive guard
    applied = apply_setting_defaults(SPEC, Settings(_env_file=None), None)  # type: ignore[call-arg]
    assert applied.upstream_rate_per_min == 8 and applied.quote_ttl_s == 300


# -- symbol mapping ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("canonical", "symbol", "exchange", "market"),
    [
        ("AAPL", "AAPL", None, "us"),
        ("BRK-B", "BRK.B", None, "us"),
        ("BRK.B", "BRK.B", None, "us"),
        ("VOD.L", "VOD", "XLON", "intl"),
        ("EURUSD=X", "EUR/USD", None, "fx"),
        ("JPY=X", "USD/JPY", None, "fx"),
        ("BTC-USD", "BTC/USD", None, "crypto"),
        ("^GSPC", "SPX", None, "index"),
    ],
)
def test_to_provider(canonical: str, symbol: str, exchange: str | None, market: str) -> None:
    mapped = td.to_provider(canonical)
    assert mapped is not None
    assert mapped.symbol == symbol and mapped.market == market
    assert (mapped.exchange.mic if mapped.exchange else None) == exchange


@pytest.mark.parametrize("canonical", ["CL=F", "GC=F", "^UNKNOWN", "=X", ""])
def test_unmappable_symbols(canonical: str) -> None:
    assert td.to_provider(canonical) is None


def test_request_parameters_and_batch_keys() -> None:
    vod = td.to_provider("VOD.L")
    assert vod is not None
    assert vod.params() == {"symbol": "VOD", "exchange": "LSE"}
    assert vod.batch_key == "VOD:LSE"
    paris = td.to_provider("AIR.PA")
    assert paris is not None
    assert paris.params() == {"symbol": "AIR", "mic_code": "XPAR"}  # Euronext is shared
    aapl = td.to_provider("AAPL")
    assert aapl is not None and aapl.params() == {"symbol": "AAPL"} and aapl.batch_key == "AAPL"


@pytest.mark.parametrize(
    ("symbol", "kwargs", "canonical"),
    [
        ("AAPL", {"mic": "XNGS", "exchange": "NASDAQ"}, "AAPL"),
        ("BRK.B", {"mic": "XNYS", "exchange": "NYSE"}, "BRK-B"),
        ("VOD", {"mic": "XLON", "exchange": "LSE"}, "VOD.L"),
        ("EUR/USD", {"kind": "Physical Currency"}, "EURUSD=X"),
        ("USD/JPY", {"kind": "Physical Currency"}, "JPY=X"),
        ("BTC/USD", {"kind": "Digital Currency"}, "BTC-USD"),
        ("SPX", {"kind": "Index"}, "^GSPC"),
        ("BRK", {"mic": "AIMX", "exchange": "LSE"}, "BRK.L"),
        ("XYZ", {"mic": "ZZZZ", "exchange": "Mars Bourse"}, None),
        ("FOO", {"kind": "Index"}, None),
    ],
)
def test_from_provider(symbol: str, kwargs: dict[str, str], canonical: str | None) -> None:
    assert td.from_provider(symbol, **kwargs) == canonical


@pytest.mark.parametrize("canonical", ["AAPL", "BRK-B", "VOD.L", "EURUSD=X", "BTC-USD", "^GSPC"])
def test_symbol_map_round_trips(canonical: str) -> None:
    mapped = td.to_provider(canonical)
    assert mapped is not None
    kind = {"fx": "Physical Currency", "crypto": "Digital Currency", "index": "Index"}.get(
        mapped.market
    )
    mic = mapped.exchange.mic if mapped.exchange else None
    name = "NASDAQ" if mapped.market == "us" else None
    assert td.from_provider(mapped.symbol, mic=mic, exchange=name, kind=kind) == canonical


def test_unmappable_and_gated_symbols_are_unsupported_and_free() -> None:
    provider, fake = make()
    for symbol, feature in (
        ("CL=F", "futures"),
        ("^FOO", "index symbols"),
        ("VOD.L", "international symbols"),  # Basic
        ("^GSPC", "index symbols"),  # Basic
    ):
        with pytest.raises(ProviderUnsupported) as exc:
            provider.history(symbol, "1d", None, None, False)
        assert exc.value.feature == feature
        with pytest.raises(ProviderUnsupported):
            provider.symbol_info(symbol)
    assert fake.calls == []


# -- history -----------------------------------------------------------------------------


def test_daily_bars_are_exchange_local_midnight_in_utc() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1d", utc(2026, 10, 20), utc(2026, 10, 28), False)
    assert list(df.columns) == BAR_COLUMNS
    assert df["ts"].dtype == "int64"
    assert len(df) == 5
    # 2026-10-27 00:00 New York (EDT, UTC-4) is 04:00 UTC.
    assert int(df["ts"].iloc[-1]) == int(utc(2026, 10, 27, 4).timestamp())
    assert df["ts"].is_monotonic_increasing
    last = df.iloc[-1]
    assert (last["open"], last["close"], last["volume"]) == (343.165, 347.32, 388284.0)
    assert (df["adj_close"] == df["close"]).all()  # unadjusted: no separate adjusted series
    path, params, headers = fake.calls[0]
    assert path == "/time_series" and params["interval"] == "1day"
    assert params["order"] == "desc" and params["outputsize"] == "5000"


def test_daily_range_is_half_open() -> None:
    provider, _ = make()
    start, end = utc(2026, 10, 22, 4), utc(2026, 10, 26, 4)
    df = provider.history("AAPL", "1d", start, end, False)
    stamps = [datetime.fromtimestamp(t, UTC) for t in df["ts"]]
    assert stamps == [utc(2026, 10, 22, 4), utc(2026, 10, 23, 4)]


def test_intraday_bars_are_bar_open_in_utc() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1m", utc(2026, 10, 26), utc(2026, 10, 28), False)
    assert len(df) == 300
    # 11:11 New York (EDT) is 15:11 UTC.
    assert datetime.fromtimestamp(int(df["ts"].iloc[-1]), UTC) == utc(2026, 10, 27, 15, 11)
    assert df["ts"].is_unique and df["ts"].is_monotonic_increasing
    params = fake.calls[0][1]
    assert params["interval"] == "1min" and params["start_date"] == "2026-10-25 20:00:00"
    assert "prepost" not in params


def test_weekly_bars_dated_monday() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1wk", utc(2026, 9, 20), utc(2026, 10, 28), False)
    assert fake.calls[0][1]["interval"] == "1week"
    days = [datetime.fromtimestamp(t, UTC).astimezone(NY) for t in df["ts"]]
    assert all(d.weekday() == 0 and (d.hour, d.minute) == (0, 0) for d in days)
    assert len(df) == 5


def test_a_further_page_is_charged_and_walks_back() -> None:
    provider, fake = make()
    charges: list[int] = []
    td_page = td.PAGE_SIZE
    td.PAGE_SIZE = 300  # the recorded pages hold 300 rows
    try:
        with metering(charges.append):
            df = provider.history("AAPL", "1m", utc(2026, 10, 23, 19), utc(2026, 10, 28), False)
    finally:
        td.PAGE_SIZE = td_page
    assert charges == [1]  # the first page is the guard's charge, the second is ours
    assert len(fake.calls) == 2
    # The synthetic page 2 is requested with end_date = oldest row of page 1.
    assert fake.calls[1][1]["end_date"] == "2026-10-26 12:42:00"
    assert df["ts"].is_unique and df["ts"].is_monotonic_increasing
    assert int(df["ts"].iloc[0]) >= int(utc(2026, 10, 23, 19).timestamp())
    assert len(df) > 300  # rows of both pages


def test_paging_stops_at_max_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    provider, fake = make()
    monkeypatch.setattr(td, "PAGE_SIZE", 300)
    monkeypatch.setattr(td, "MAX_PAGES", 3)
    meta = body_of("time_series_1min_aapl")["meta"]
    pages = [0]

    def answer(params: dict[str, str]) -> tuple[int, dict[str, str], Any]:
        # Every page is full and older than the last: a real series cannot be walked forever.
        top = datetime(2026, 9, 28, 16) - timedelta(minutes=300 * pages[0])
        pages[0] += 1
        values = [
            {
                "datetime": (top - timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S"),
                "open": "1",
                "high": "2",
                "low": "1",
                "close": "2",
                "volume": "5",
            }
            for i in range(300)
        ]
        return 200, {}, {"meta": meta, "values": values, "status": "ok"}

    fake.answers["/time_series"] = answer
    with metering(lambda n: None):
        df = provider.history("AAPL", "1m", utc(2020, 1, 1), None, False)
    assert len(fake.calls) == 3 and len(df) == 900


def test_an_empty_range_is_not_an_error() -> None:
    provider, fake = make()
    fake.answers["/time_series"] = lambda p: (
        400,
        {},
        error(400, "No data is available on the specified dates. Try setting different dates."),
    )
    df = provider.history("AAPL", "1d", utc(2026, 1, 1), utc(2026, 1, 2), False)
    assert df.empty and list(df.columns) == BAR_COLUMNS


def test_synthesized_2m_bars_aggregate_the_1m_source() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "2m", utc(2026, 10, 26), utc(2026, 10, 28), False)
    assert fake.calls[0][1]["interval"] == "1min"
    assert (df["ts"] % 120 == 0).all() and df["ts"].is_unique
    source = provider.history("AAPL", "1m", utc(2026, 10, 26), utc(2026, 10, 28), False)
    assert df["volume"].sum() == pytest.approx(source["volume"].sum(), rel=0.01)
    assert len(df) < len(source)


def test_synthesized_90m_bars_anchor_on_the_session_open() -> None:
    provider, fake = make()
    day = [
        {"datetime": f"2026-10-26 {h:02d}:{m:02d}:00", "open": "10", "high": "12", "low": "9",
         "close": "11", "volume": "100"}
        for h, m in reversed([(9, 30), (10, 0), (10, 30), (11, 0), (11, 30), (12, 0), (12, 30),
                              (13, 0), (13, 30), (14, 0), (14, 30), (15, 0), (15, 30)])
    ]  # fmt: skip
    meta = body_of("time_series_1min_aapl")["meta"]
    fake.answers["/time_series"] = lambda p: (
        200,
        {},
        {"meta": meta, "values": day, "status": "ok"},
    )
    df = provider.history("AAPL", "90m", utc(2026, 10, 26), utc(2026, 10, 27), False)
    assert fake.calls[0][1]["interval"] == "30min"
    opens = [datetime.fromtimestamp(t, UTC).astimezone(NY).strftime("%H:%M") for t in df["ts"]]
    assert opens == ["09:30", "11:00", "12:30", "14:00", "15:30"]
    assert df["volume"].tolist() == [300, 300, 300, 300, 100]


def test_synthesized_3mo_bars_are_quarters() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "3mo", utc(2025, 12, 1), utc(2026, 11, 1), False)
    assert fake.calls[0][1]["interval"] == "1month"
    days = [datetime.fromtimestamp(t, UTC).astimezone(NY) for t in df["ts"]]
    assert [(d.month, d.day, d.hour) for d in days] == [(1, 1, 0), (4, 1, 0), (7, 1, 0), (10, 1, 0)]
    assert df["volume"].tolist() == [3000, 3000, 3000, 1000]
    assert monthly_rows()[-1]["datetime"] == "2026-01-01"


def test_unsupported_interval() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported):
        provider.history("AAPL", "5d", None, None, False)
    assert fake.calls == []


def test_prepost_only_on_plans_with_extended_hours() -> None:
    basic, fake = make()
    basic.history("AAPL", "5m", utc(2026, 10, 26), utc(2026, 10, 28), True)
    assert "prepost" not in fake.calls[0][1]
    pro, fake = make(plan="pro")
    pro.history("AAPL", "5m", utc(2026, 10, 26), utc(2026, 10, 28), True)
    assert fake.calls[0][1]["prepost"] == "true"
    pro.history("AAPL", "1d", utc(2026, 10, 26), utc(2026, 10, 28), True)
    assert "prepost" not in fake.calls[1][1]  # daily bars have no extended hours


def test_unknown_symbol_is_symbol_not_found() -> None:
    provider, _ = make()
    with pytest.raises(SymbolNotFound):
        provider.history("ZZZZNOTREAL", "1d", None, None, False)
    with pytest.raises(SymbolNotFound):
        provider.symbol_info("ZZZZNOTREAL")


def test_international_history_names_the_exchange() -> None:
    provider, fake = make(plan="grow")
    fake.answers["/time_series"] = lambda p: (
        200,
        {},
        {**body_of("time_series_1day_aapl"), "meta": {"exchange_timezone": "Europe/London"}},
    )
    df = provider.history("VOD.L", "1d", utc(2026, 10, 1), utc(2026, 10, 28), False)
    assert fake.calls[0][1]["symbol"] == "VOD" and fake.calls[0][1]["exchange"] == "LSE"
    # London midnight on 2026-10-27: BST ended on the 25th, so UTC+0.
    assert datetime.fromtimestamp(int(df["ts"].iloc[-1]), UTC) == utc(2026, 10, 27)
    # ... and on the 22nd it was still BST (UTC+1).
    assert datetime.fromtimestamp(int(df["ts"].iloc[1]), UTC) == utc(2026, 10, 21, 23)


# -- symbol info and search --------------------------------------------------------------


def test_symbol_info_picks_the_exact_us_listing() -> None:
    provider, fake = make()
    info = provider.symbol_info("BRK-B")
    assert fake.calls[0][1]["symbol"] == "BRK.B"  # ranked seventh, picked by exact match
    assert info["symbol"] == "BRK-B" and info["type"] == "equity"
    assert info["timezone"] == "America/New_York" and info["session"] == "0930-1600"
    assert info["name"] == "Berkshire Hathaway Inc. Class B"
    assert info["priceHint"] == 2 and info["minTick"] == 0.01 and info["hasIntraday"] is True


def test_symbol_info_for_other_markets() -> None:
    provider, _ = make(plan="grow")
    vod = provider.symbol_info("VOD.L")
    assert (vod["timezone"], vod["session"], vod["currency"]) == (
        "Europe/London",
        "0800-1630",
        "GBp",
    )
    fx = provider.symbol_info("EURUSD=X")
    assert (fx["type"], fx["priceHint"], fx["timezone"], fx["session"]) == (
        "currency",
        4,
        "UTC",
        "0000-2359",
    )
    assert provider.symbol_info("BTC-USD")["type"] == "cryptocurrency"
    assert provider.symbol_info("^GSPC")["type"] == "index"


def test_symbol_lookups_are_free_calls() -> None:
    provider, fake = make(fake=FakeTD(credits=(0, 8)))
    provider.symbol_info("AAPL")
    provider.search("AAPL", 5)
    assert fake.paths() == ["/symbol_search", "/symbol_search"]
    assert SPEC.costs(None).symbol_info == 0 and SPEC.costs(None).search == 0


def test_search_maps_and_drops_what_the_plan_cannot_serve() -> None:
    basic, _ = make()
    rows = basic.search("AAPL", 10)
    assert [r["symbol"] for r in rows] == ["AAPL"]  # the other listings are non-US
    assert rows[0]["type"] == "equity" and rows[0]["typeDisplay"] == "Common Stock"
    grow, _ = make(plan="grow")
    symbols = [r["symbol"] for r in grow.search("AAPL", 10)]
    assert symbols[0] == "AAPL" and "AAPL.TO" in symbols
    assert len(set(symbols)) == len(symbols)
    brk = [r["symbol"] for r in basic.search("BRK", 10)]
    assert "BRK-B" in brk and "BRK-A" in brk
    assert len(basic.search("BRK", 1)) == 1


# -- quotes ------------------------------------------------------------------------------


def test_single_quote_shape_and_time() -> None:
    provider, fake = make()
    rows = provider.quotes(["AAPL"])
    assert isinstance(rows, QuoteList) and rows.confirmed
    assert fake.calls[0][1] == {"symbol": "AAPL"}
    q = rows[0]
    assert q["symbol"] == "AAPL" and q["last"] == 347.25 and q["prevClose"] == 343.91
    assert q["change"] == pytest.approx(3.34) and q["changePercent"] == pytest.approx(0.97118325)
    assert q["volume"] == 391880 and q["currency"] == "USD" and q["marketState"] == "REGULAR"
    # `timestamp` is the session open; the quote time is `last_quote_at`.
    assert q["time"] == 1793113980 != 1793107800


def test_closed_market_state() -> None:
    provider, fake = make()
    entry = {**body_of("quote_aapl"), "is_market_open": False}
    fake.answers["/quote"] = lambda p: (200, {}, entry)
    assert provider.quotes(["AAPL"])[0]["marketState"] == "CLOSED"


def test_batch_quotes_omit_unknown_symbols_and_confirm() -> None:
    provider, fake = make()
    rows = provider.quotes(["AAPL", "MSFT", "ZZZZNOTREAL", "aapl"])
    assert [r["symbol"] for r in rows] == ["AAPL", "MSFT"]
    assert isinstance(rows, QuoteList) and rows.confirmed  # a 404 is a definite answer
    assert fake.calls[0][1]["symbol"] == "AAPL,MSFT,ZZZZNOTREAL"  # deduplicated


def test_plan_gated_batch_entry_is_unsupported_not_unknown() -> None:
    provider, fake = make(plan="grow")  # the account is Basic in reality
    entry = body_of("quote_batch")
    fake.answers["/quote"] = lambda p: (
        200,
        {},
        {"AAPL": entry["AAPL"], "VOD:LSE": entry["VOD:LSE"]},
    )
    rows = provider.quotes(["AAPL", "VOD.L"])
    assert [r["symbol"] for r in rows] == ["AAPL"] and rows.confirmed  # type: ignore[attr-defined]


def test_unsupported_symbols_are_not_sent() -> None:
    provider, fake = make()
    rows = provider.quotes(["AAPL", "VOD.L", "CL=F"])
    assert [r["symbol"] for r in rows] == ["AAPL"]
    assert fake.calls[0][1] == {"symbol": "AAPL"}
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["VOD.L"])
    assert len(fake.calls) == 1
    assert list(provider.quotes([])) == []


def test_quote_entry_missing_from_the_answer_is_not_confirmed() -> None:
    provider, fake = make()
    entry = body_of("quote_batch")["AAPL"]
    fake.answers["/quote"] = lambda p: (200, {}, {"AAPL": entry})
    rows = provider.quotes(["AAPL", "MSFT"])
    assert [r["symbol"] for r in rows] == ["AAPL"]
    assert not rows.confirmed  # type: ignore[attr-defined]


def test_quotes_are_chunked_at_120_symbols() -> None:
    provider, fake = make(plan="pro")
    symbols = [f"S{i}" for i in range(250)]
    rows = provider.quotes(symbols)
    assert [len(c[1]["symbol"].split(",")) for c in fake.calls] == [120, 120, 10]
    assert len(rows) == 250


def test_extended_quotes_need_a_plan_with_extended_hours() -> None:
    basic, _ = make()
    with pytest.raises(ProviderUnsupported):
        basic.extended_quotes(["AAPL"])
    pro, fake = make(plan="pro")
    entry = {
        **body_of("quote_aapl"),
        "is_market_open": False,
        "extended_price": "348.1",
        "extended_change": "0.85",
        "extended_percent_change": "0.24",
        "extended_timestamp": 1793127000,
    }
    fake.answers["/quote"] = lambda p: (200, {}, entry)
    row = pro.extended_quotes(["AAPL"])[0]
    assert fake.calls[0][1] == {"symbol": "AAPL", "prepost": "true"}
    assert row["marketState"] == "POST" and row["postMarketPrice"] == 348.1
    assert row["preMarketPrice"] is None and row["regularMarketPrice"] == 347.25


# -- events, fundamentals, the rest ------------------------------------------------------


def test_events_map_to_the_yahoo_shape() -> None:
    provider, fake = make()
    ev = provider.events("AAPL")
    assert fake.paths() == ["/dividends", "/splits", "/earnings"]
    # ex-date 2026-08-10, New York midnight (EDT) = 04:00 UTC.
    assert ev["dividends"] == [{"t": int(utc(2026, 8, 10, 4).timestamp()), "amount": 0.27}]
    assert ev["splits"] == [{"t": int(utc(2020, 8, 31, 4).timestamp()), "ratio": 4.0}]
    assert [e["epsActual"] for e in ev["earnings"]] == [2.01, 2.02]  # oldest first
    assert ev["earnings"][1] == {
        "t": int(utc(2026, 7, 30, 4).timestamp()),
        "epsEstimate": 1.89,
        "epsActual": 2.02,
        "surprisePercent": 6.88,
    }


def test_events_disabled_by_the_user_are_unsupported() -> None:
    provider, fake = make(events=False)
    with pytest.raises(ProviderUnsupported):
        provider.events("AAPL")
    assert fake.calls == []


def test_fundamentals_come_from_the_profile() -> None:
    provider, fake = make()
    data = provider.fundamentals("AAPL")
    assert fake.paths() == ["/profile"]
    info = data["info"]
    assert info["longName"] == "Apple Inc." and info["quoteType"] == "EQUITY"
    assert info["sector"] == "Technology" and info["fullTimeEmployees"] == 150000
    assert info["website"] == "https://www.apple.com" and "longBusinessSummary" in info
    assert "financials" not in data


def test_news_and_statements_are_unsupported() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported):
        provider.news("AAPL", 5)
    assert fake.calls == []


def test_usage_from_the_api_usage_fixture() -> None:
    provider, fake = make()
    assert provider.usage() == Usage(minute_limit=8, minute_used=1, daily_limit=800, daily_used=1)
    assert fake.paths() == ["/api_usage"]
    pinned, _ = make(credits_per_min=5, daily_credits=100)
    assert pinned.usage() == Usage(minute_limit=None, minute_used=1, daily_limit=None, daily_used=1)


# -- transport, errors and credits -------------------------------------------------------


def test_key_travels_in_the_header_never_in_the_url() -> None:
    provider, fake = make(plan="grow")
    provider.quotes(["AAPL", "MSFT"])
    provider.history("AAPL", "1d", None, None, False)
    provider.symbol_info("AAPL")
    provider.events("AAPL")
    provider.usage()
    assert fake.urls and all(KEY not in url for url in fake.urls)
    assert all(headers["Authorization"] == f"apikey {KEY}" for _, _, headers in fake.calls)
    assert all("apikey" not in params for _, params, _ in fake.calls)
    assert KEY not in repr(config()) and KEY not in str(config().model_dump())


def test_invalid_key_is_not_configured() -> None:
    provider, fake = make()
    fake.answers["/quote"] = lambda p: (401, {}, error(401, "**apikey** parameter is incorrect"))
    with pytest.raises(ProviderNotConfigured, match="TWELVEDATA_API_KEY"):
        provider.quotes(["AAPL"])


def test_error_in_a_200_body_is_classified() -> None:
    provider, fake = make()
    fake.answers["/time_series"] = lambda p: (200, {}, error(404, "**symbol** not found: X"))
    with pytest.raises(SymbolNotFound):
        provider.history("AAPL", "1d", None, None, False)
    fake.answers["/time_series"] = lambda p: (
        200,
        {},
        error(404, "This symbol is available starting with the Grow or Venture plan."),
    )
    with pytest.raises(ProviderUnsupported):
        provider.history("AAPL", "1d", None, None, False)
    fake.answers["/time_series"] = lambda p: (400, {}, error(400, "Invalid **interval**"))
    with pytest.raises(td.ProviderError) as exc:
        provider.history("AAPL", "1d", None, None, False)
    assert not isinstance(exc.value, (SymbolNotFound, ProviderUnsupported))


def test_per_minute_429_retries_at_the_next_minute() -> None:
    provider, fake = make()
    fake.answers["/quote"] = lambda p: (429, {}, body_of("error_429"))
    with pytest.raises(RateLimited) as exc:
        provider.quotes(["AAPL"])
    assert exc.value.retry_after == 41 and exc.value.daily is False  # 12:00:20 -> 12:01:01
    late, fake = make(now=utc(2026, 10, 27, 12, 0, 59))
    fake.answers["/quote"] = lambda p: (429, {}, body_of("error_429"))
    with pytest.raises(RateLimited) as exc:
        late.quotes(["AAPL"])
    assert exc.value.retry_after == 2


def test_daily_429_is_flagged_and_waits_for_midnight() -> None:
    provider, fake = make(now=utc(2026, 10, 27, 23, 0, 0))
    message = "You have run out of API credits for the day. 801 API credits were used, 800 allowed."
    fake.answers["/time_series"] = lambda p: (429, {}, error(429, message))
    with pytest.raises(RateLimited) as exc:
        provider.history("AAPL", "1d", None, None, False)
    assert exc.value.daily is True and exc.value.retry_after == 3600


def test_server_errors_are_unavailable() -> None:
    provider, fake = make()
    fake.answers["/quote"] = lambda p: (503, {}, {"message": "down"})
    with pytest.raises(td.ProviderError) as exc:
        provider.quotes(["AAPL"])
    assert type(exc.value).__name__ == "UpstreamUnavailable"


def test_nothing_is_sent_that_the_minute_cannot_pay_for() -> None:
    fake = FakeTD(credits=(5, 3))  # the API says 3 credits are left this minute
    provider, _ = make(fake)
    provider.quotes(["AAPL"])
    assert len(fake.calls) == 1
    with pytest.raises(RateLimited) as exc:
        provider.quotes(["AAPL", "MSFT", "GOOG", "IBM"])  # 4 needed, 3 left
    assert exc.value.retry_after == 41
    assert len(fake.calls) == 1  # refused locally: a refused request is charged in full
    provider.quotes(["AAPL", "MSFT", "GOOG"])  # 3 fit
    assert len(fake.calls) == 2
    next_minute, _ = make(fake, now=utc(2026, 10, 27, 12, 1, 5))
    next_minute.quotes(["AAPL", "MSFT", "GOOG"])
    assert len(fake.calls) == 3


# -- through the guard -------------------------------------------------------------------


def guarded(
    fake: FakeTD, guard: UpstreamGuard | None = None, **kwargs: Any
) -> tuple[GuardedProvider, UpstreamGuard]:
    provider, _ = make(fake, **kwargs)
    profile = td.effective_profile(config(**kwargs))
    guard = guard or UpstreamGuard(rate_per_min=60, burst=20)
    return (
        GuardedProvider(
            provider,
            guard,
            costs=td.costs_for(profile),
            capabilities=td.capabilities_for(profile),
        ),
        guard,
    )


def test_response_headers_calibrate_the_guard() -> None:
    fake = FakeTD(credits=(5, 3))
    gp, guard = guarded(fake)
    gp.quotes(["AAPL"])
    snap = guard.snapshot()
    assert snap["calibrated"] is True
    assert (snap["burst"], snap["ratePerMin"]) == (8, 8)  # used + left
    assert snap["tokens"] <= 3


def test_an_over_limit_429_does_not_raise_the_limit_it_exceeded() -> None:
    fake = FakeTD()
    fake.answers["/quote"] = lambda p: (
        429,
        {"api-credits-used": "9", "api-credits-left": "0"},
        body_of("error_429"),
    )
    gp, guard = guarded(fake)
    with pytest.raises(RateLimited):
        gp.quotes(["AAPL"])
    snap = guard.snapshot()
    assert snap["calibrated"] is False and snap["burst"] == 20  # not "9 per minute"
    assert snap["tokens"] == 0 and snap["rateLimited"] is True


def test_daily_429_exhausts_the_guard_until_midnight() -> None:
    fake = FakeTD()
    fake.answers["/time_series"] = lambda p: (
        429,
        {},
        error(429, "You have run out of API credits for the day."),
    )
    guard = UpstreamGuard(rate_per_min=60, burst=20, daily_limit=800)
    gp, _ = guarded(fake, guard)
    with pytest.raises(RateLimited) as exc:
        gp.history("AAPL", "1d", None, None, False)
    assert exc.value.daily and exc.value.retry_after > 1
    snap = guard.snapshot()
    assert snap["state"] == "exhausted" and snap["daily"]["left"] == 0
    calls = len(fake.calls)
    with pytest.raises(RateLimited):
        gp.quotes(["AAPL"])
    assert len(fake.calls) == calls  # nothing more is sent


def test_pinned_limits_are_not_calibrated_away() -> None:
    fake = FakeTD(credits=(5, 3))
    gp, guard = guarded(fake, credits_per_min=20)
    gp.quotes(["AAPL"])
    assert guard.snapshot()["calibrated"] is False  # only the tokens drop to what is left


def test_seed_usage_calibrates_from_api_usage() -> None:
    fake = FakeTD()
    guard = UpstreamGuard(rate_per_min=60, burst=20, daily_limit=None)
    gp, _ = guarded(fake, guard)
    assert gp.seed_usage() is True
    snap = guard.snapshot()
    assert snap["daily"]["limit"] == 800 and snap["daily"]["used"] >= 1
    assert snap["burst"] == 8


def test_free_lookups_take_no_tokens() -> None:
    fake = FakeTD()
    gp, guard = guarded(fake, UpstreamGuard(rate_per_min=8, burst=8))
    gp.symbol_info("AAPL")
    gp.search("AAPL", 5)
    assert guard.snapshot()["tokens"] == 8
    assert guard.acquire(0) == 0  # a zero-cost call is allowed and takes nothing
    assert guard.snapshot()["tokens"] == 8


def test_zero_cost_calls_still_respect_the_breakers() -> None:
    guard = UpstreamGuard(rate_per_min=8, burst=8)
    guard.on_rate_limited(30)
    with pytest.raises(RateLimited):
        guard.acquire(0)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


class RecordingProvider:
    """Answers every quote request, remembering the sizes asked."""

    def __init__(self, fail_from: int | None = None) -> None:
        self.sizes: list[int] = []
        self.fail_from = fail_from

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.sizes.append(len(symbols))
        if self.fail_from is not None and len(self.sizes) >= self.fail_from:
            raise RateLimited("no", 5)
        return QuoteList(({"symbol": s, "last": 1.0} for s in symbols), confirmed=True)

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        return self.quotes(symbols)


def chunking_guard(clock: FakeClock, max_wait: float) -> UpstreamGuard:
    return UpstreamGuard(
        rate_per_min=8, burst=8, max_wait_s=max_wait, clock=clock, sleep=clock.sleep
    )


def symbols(n: int) -> list[str]:
    return [f"S{i}" for i in range(n)]


def test_quote_chunks_never_exceed_the_burst() -> None:
    clock = FakeClock()
    inner = RecordingProvider()
    gp = GuardedProvider(
        inner,
        chunking_guard(clock, 60),
        costs=td.costs_for(td.effective_profile(None)),  # type: ignore[arg-type]
    )
    rows = gp.quotes(symbols(10))
    assert inner.sizes == [8, 2]  # the second waits for tokens
    assert len(rows) == 10 and rows.confirmed  # type: ignore[attr-defined]
    assert clock.now == pytest.approx(15)  # 2 tokens at 8 per minute


def test_interactive_chunks_that_cannot_wait_are_skipped() -> None:
    clock = FakeClock()
    inner = RecordingProvider()
    gp = GuardedProvider(
        inner,
        chunking_guard(clock, 2),
        costs=td.costs_for(td.effective_profile(None)),  # type: ignore[arg-type]
    )
    rows = gp.quotes(symbols(10))
    assert inner.sizes == [8]
    assert len(rows) == 8
    assert not rows.confirmed  # type: ignore[attr-defined]  # the other two are unknown, not absent


def test_background_chunks_are_not_waited_for() -> None:
    clock = FakeClock()
    inner = RecordingProvider()
    guard = chunking_guard(clock, 60)
    gp = GuardedProvider(inner, guard, costs=td.costs_for(td.effective_profile(None)))  # type: ignore[arg-type]
    with guard.priority("background"):
        rows = gp.quotes(symbols(10))
    assert inner.sizes == [8]  # a full bucket pays the first chunk; the rest is refused
    assert len(rows) == 8 and clock.now == 0


def test_a_refused_first_chunk_raises() -> None:
    clock = FakeClock()
    inner = RecordingProvider(fail_from=1)
    gp = GuardedProvider(
        inner,
        chunking_guard(clock, 60),
        costs=td.costs_for(td.effective_profile(None)),  # type: ignore[arg-type]
    )
    with pytest.raises(RateLimited):
        gp.quotes(symbols(10))


def test_no_chunking_when_the_burst_covers_the_call() -> None:
    inner = RecordingProvider()
    guard = UpstreamGuard(rate_per_min=60, burst=20)
    gp = GuardedProvider(inner, guard, costs=td.costs_for(td.effective_profile(None)))  # type: ignore[arg-type]
    gp.quotes(symbols(10))
    assert inner.sizes == [10]


def test_extended_quotes_chunk_and_report_partial_results() -> None:
    from tickerglass_api.providers.base import PartialQuotes

    clock = FakeClock()
    inner = RecordingProvider()
    pro = td.effective_profile(config(plan="pro", credits_per_min=8))
    gp = GuardedProvider(
        inner,  # type: ignore[arg-type]
        chunking_guard(clock, 2),
        costs=td.costs_for(pro),
        capabilities=td.capabilities_for(pro),
    )
    with pytest.raises(PartialQuotes) as exc:
        gp.extended_quotes(symbols(10))
    assert len(exc.value.quotes) == 8 and exc.value.failed == ["S8", "S9"]


def test_yahoo_costs_still_make_one_call() -> None:
    from tickerglass_api.providers.base import CostModel

    inner = RecordingProvider()
    gp = GuardedProvider(inner, UpstreamGuard(rate_per_min=60, burst=20), costs=CostModel())  # type: ignore[arg-type]
    gp.quotes(symbols(500))
    assert inner.sizes == [500]


# -- review fixes ------------------------------------------------------------------------


def full_page(params: dict[str, str]) -> tuple[int, dict[str, str], Any]:
    """A full 1m page of crypto bars ending at the request's `end_date`: every page is
    older than the last, so a walk back never ends by itself."""
    end = datetime.strptime(params.get("end_date", "2026-10-27 12:00:00"), "%Y-%m-%d %H:%M:%S")
    values = [
        {
            "datetime": (end - timedelta(minutes=i)).strftime("%Y-%m-%d %H:%M:%S"),
            "open": "1",
            "high": "2",
            "low": "1",
            "close": "2",
            "volume": "5",
        }
        for i in range(td.PAGE_SIZE)
    ]
    return 200, {}, {"meta": {"exchange_timezone": "UTC"}, "values": values, "status": "ok"}


def budget_guard(clock: FakeClock, burst: int = 8) -> UpstreamGuard:
    return UpstreamGuard(
        rate_per_min=burst,
        burst=burst,
        daily_limit=800,
        calibrate_rate=False,
        clock=clock,
        sleep=clock.sleep,
    )


def test_paging_beyond_the_burst_keeps_the_pages_fetched() -> None:
    fake = FakeTD()
    fake.answers["/time_series"] = full_page
    clock = FakeClock()
    guard = budget_guard(clock)
    gp, _ = guarded(fake, guard)
    df = gp.history("BTC-USD", "2m", NOW - timedelta(days=60), NOW, False)
    # Eight pages (the burst) of 1m bars, not an error that throws them away.
    assert len(fake.calls) == 8
    assert len(df) > 19_000  # 39,993 distinct minutes (pages share a boundary row) as 2m bars
    snap = guard.snapshot()
    assert snap["daily"]["used"] == 8 and snap["rateLimited"] is False
    assert snap["refused"]["rate_limited"] == 0


def test_paging_is_capped_by_max_pages() -> None:
    fake = FakeTD()
    fake.answers["/time_series"] = full_page
    provider = td.TwelveDataProvider(config(), send=fake, clock=lambda: NOW, max_pages=3)
    with metering(lambda n: None):
        df = provider.history("BTC-USD", "1m", NOW - timedelta(days=60), NOW, False)
    # Pages share their boundary row (two), and the row stamped `end` itself is out.
    assert len(fake.calls) == 3 and len(df) == 3 * td.PAGE_SIZE - 3


def test_paging_stops_when_the_minutes_credits_run_out() -> None:
    fake = FakeTD(credits=(6, 2))  # the API says two credits are left this minute
    fake.answers["/time_series"] = full_page
    gp, guard = guarded(fake, UpstreamGuard(rate_per_min=60, burst=20, daily_limit=800))
    df = gp.history("BTC-USD", "1m", NOW - timedelta(days=60), NOW, False)
    # Pages share their boundary row (two), and the row stamped `end` itself is out.
    assert len(fake.calls) == 3 and len(df) == 3 * td.PAGE_SIZE - 3
    assert guard.snapshot()["daily"]["used"] == 3  # the refused fourth page was not paid for


def test_a_quote_batch_of_unsupported_symbols_still_serves_the_rest() -> None:
    fake = FakeTD()
    clock = FakeClock()
    guard = budget_guard(clock)
    gp, _ = guarded(fake, guard)
    futures = ["GC=F", "SI=F", "PL=F", "PA=F", "CL=F", "BZ=F", "NG=F", "^FTSE"]
    rows = gp.quotes([*futures, "AAPL", "MSFT", "aapl", "MSFT"])
    assert [r["symbol"] for r in rows] == ["AAPL", "MSFT"]
    assert cast(QuoteList, rows).confirmed
    assert [p["symbol"] for _, p, _ in fake.calls] == ["AAPL,MSFT"]  # once each, nothing else
    assert guard.snapshot()["daily"]["used"] == 2  # no credit for the unsupported or duplicates


def test_a_batch_of_only_unsupported_symbols_costs_nothing() -> None:
    fake = FakeTD()
    guard = budget_guard(FakeClock())
    gp, _ = guarded(fake, guard)
    with pytest.raises(ProviderUnsupported):
        gp.quotes(["GC=F", "^FTSE", "VOD.L"])
    assert fake.calls == []
    snap = guard.snapshot()
    assert snap["daily"]["used"] == 0 and snap["tokens"] == 8


class PickyProvider(RecordingProvider):
    """No hook to tell what it cannot serve: a chunk of only `U...` symbols is refused."""

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.sizes.append(len(symbols))
        if all(s.startswith("U") for s in symbols):
            raise ProviderUnsupported("futures")
        rows = ({"symbol": s, "last": 1.0} for s in symbols if not s.startswith("U"))
        return QuoteList(rows, confirmed=True)


def test_an_unsupported_chunk_is_answered_and_the_next_one_still_asked() -> None:
    inner = PickyProvider()
    gp = GuardedProvider(
        inner,
        chunking_guard(FakeClock(), 60),
        costs=td.costs_for(td.effective_profile(None)),  # type: ignore[arg-type]
    )
    rows = gp.quotes([*(f"U{i}" for i in range(8)), "AAPL", "MSFT"])
    assert inner.sizes == [8, 2]
    assert [r["symbol"] for r in rows] == ["AAPL", "MSFT"]
    assert cast(QuoteList, rows).confirmed


def test_fx_crypto_and_index_have_no_events_or_profile_and_cost_nothing() -> None:
    fake = FakeTD()
    guard = budget_guard(FakeClock())
    gp, _ = guarded(fake, guard, plan="grow")
    nothing = {"dividends": [], "splits": [], "earnings": []}
    for symbol in ("EURUSD=X", "BTC-USD", "^GSPC"):
        assert gp.events(symbol) == nothing
        assert gp.fundamentals(symbol) == {"info": {}}
    for symbol in ("CL=F", "^FOO"):  # what Twelve Data does not know at all
        with pytest.raises(ProviderUnsupported):
            gp.events(symbol)
        with pytest.raises(ProviderUnsupported):
            gp.fundamentals(symbol)
        with pytest.raises(ProviderUnsupported):
            gp.history(symbol, "1d", None, None, False)
    assert fake.calls == []
    snap = guard.snapshot()
    assert snap["daily"]["used"] == 0 and snap["tokens"] == 8


def test_events_of_a_stock_are_paid_for_up_front() -> None:
    fake = FakeTD()
    guard = budget_guard(FakeClock())
    gp, _ = guarded(fake, guard)
    gp.events("AAPL")
    assert fake.paths() == ["/dividends", "/splits", "/earnings"]
    assert guard.snapshot()["daily"]["used"] == 3

    short = FakeTD(credits=(7, 2))  # two credits left this minute: three are needed
    gp, guard = guarded(short, budget_guard(FakeClock()))
    gp.quotes(["AAPL"])  # learns the window
    sent = len(short.calls)
    with pytest.raises(RateLimited):
        gp.events("AAPL")
    assert len(short.calls) == sent  # not one of the three was sent


def test_a_later_events_failure_returns_what_came_first() -> None:
    provider, fake = make()
    fake.answers["/splits"] = lambda p: (500, {}, error(500, "boom"))
    events = provider.events("AAPL")
    assert events["dividends"] and events["splits"] == [] and events["earnings"]
    fake.answers["/dividends"] = lambda p: (500, {}, error(500, "boom"))
    with pytest.raises(td.ProviderError):  # nothing to return: the failure is the answer
        provider.events("AAPL")


def test_window_check_never_overcommits_across_threads() -> None:
    fake = FakeTD(credits=(3, 5))
    provider, _ = make(fake)
    provider.quotes(["AAPL"])  # the response says five credits are left this minute
    granted: list[int] = []
    refused: list[LocalRateLimited] = []
    barrier = threading.Barrier(24)

    def worker() -> None:
        barrier.wait()
        try:
            provider._window_check(1)
            granted.append(1)
        except LocalRateLimited as exc:
            refused.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(granted) == 5 and len(refused) == 19
    assert all(e.credits == 1 and e.retry_after == 41 for e in refused)


def test_the_previous_minutes_credits_count_for_the_first_seconds_of_the_next() -> None:
    fake = FakeTD(credits=(7, 1))
    provider, _ = make(fake, now=utc(2026, 10, 27, 12, 0, 59))
    provider.quotes(["AAPL"])
    early, _ = make(fake, now=utc(2026, 10, 27, 12, 1, 1))  # the API's clock may lag ours
    early._window = provider._window
    with pytest.raises(LocalRateLimited) as exc:
        early._window_check(2)
    assert exc.value.retry_after == 1
    late, _ = make(fake, now=utc(2026, 10, 27, 12, 1, 3))
    late._window = provider._window
    late._window_check(2)  # a new minute is trusted from the third second


def test_a_local_refusal_opens_no_breaker_and_gives_the_tokens_back() -> None:
    fake = FakeTD()
    guard = UpstreamGuard(rate_per_min=60, burst=20, daily_limit=800, calibrate_rate=False)
    gp, _ = guarded(fake, guard)
    inner = cast(td.TwelveDataProvider, gp.inner)
    inner._window = (inner._minute(), 1)  # one credit left in this minute
    with pytest.raises(LocalRateLimited):
        gp.quotes(["AAPL", "MSFT"])
    assert fake.calls == []
    snap = guard.snapshot()
    assert snap["rateLimited"] is False and snap["backoffS"] == 30  # no cooldown, no escalation
    assert snap["daily"]["used"] == 0 and snap["tokens"] == pytest.approx(20, abs=0.5)
    assert snap["refused"]["rate_limited"] == 0
    assert len(gp.quotes(["AAPL"])) == 1  # the next call that fits goes straight through


def test_guard_refund_never_exceeds_the_burst() -> None:
    guard = UpstreamGuard(rate_per_min=8, burst=8, daily_limit=800)
    guard.acquire(3)
    guard.refund(3)
    snap = guard.snapshot()
    assert snap["daily"]["used"] == 0 and snap["tokens"] == pytest.approx(8, abs=0.1)
    guard.refund(5)
    assert guard.snapshot()["tokens"] <= 8


def test_90m_bars_from_a_mid_session_start_still_anchor_on_the_open() -> None:
    provider, fake = make()
    day = [
        {"datetime": f"2026-10-26 {h:02d}:{m:02d}:00", "open": "10", "high": "12", "low": "9",
         "close": "11", "volume": "100"}
        for h, m in reversed([(9, 30), (10, 0), (10, 30), (11, 0), (11, 30), (12, 0), (12, 30),
                              (13, 0), (13, 30), (14, 0), (14, 30), (15, 0), (15, 30)])
    ]  # fmt: skip
    meta = body_of("time_series_1min_aapl")["meta"]
    fake.answers["/time_series"] = lambda p: (
        200,
        {},
        {"meta": meta, "values": day, "status": "ok"},
    )
    start = datetime(2026, 10, 26, 11, 10, tzinfo=NY)  # between two buckets
    df = provider.history("AAPL", "90m", start, utc(2026, 10, 27), False)
    # The request reaches back to the local midnight, so the day's first bar is in hand.
    assert fake.calls[0][1]["start_date"] == "2026-10-26 00:00:00"
    opens = [datetime.fromtimestamp(t, UTC).astimezone(NY).strftime("%H:%M") for t in df["ts"]]
    assert opens == ["12:30", "14:00", "15:30"]  # same edges as a full-day request
    assert df["volume"].tolist() == [300, 300, 100]


def test_fx_aliases_name_one_listing_and_each_gets_its_row() -> None:
    assert td.to_provider("USDJPY=X") == td.to_provider("JPY=X")
    assert td.from_provider("USD/JPY", kind="Physical Currency") == "JPY=X"
    assert td.from_provider("EUR/JPY", kind="Physical Currency") == "EURJPY=X"
    for canonical in ("USDJPY=X", "JPY=X"):
        mapped = td.to_provider(canonical)
        assert mapped is not None and mapped.symbol == "USD/JPY"
    provider, fake = make()
    rows = provider.quotes(["USDJPY=X", "JPY=X", "EURUSD=X"])
    assert fake.calls[0][1]["symbol"] == "USD/JPY,EUR/USD"  # one entry (one credit) each
    assert [r["symbol"] for r in rows] == ["USDJPY=X", "JPY=X", "EURUSD=X"]
    assert cast(QuoteList, rows).confirmed


def test_usage_warns_when_the_api_reports_another_plan(caplog: pytest.LogCaptureFixture) -> None:
    provider, fake = make(plan="pro")
    with caplog.at_level(logging.WARNING, logger=td.log.name):
        provider.usage()
        provider.usage()
    assert "reports plan 'basic'" in caplog.text and "'pro'" in caplog.text
    assert caplog.text.count("reports plan") == 1  # once, not on every call
    quiet, _ = make()  # basic, as the API says
    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=td.log.name):
        quiet.usage()
    assert caplog.text == ""


def usage_body(**over: Any) -> Any:
    body = dict(body_of("api_usage_start"))
    body.update(over)
    return lambda p: (200, {}, body)


def test_usage_adopts_the_daily_limit_the_api_reports_and_an_absent_cap() -> None:
    provider, fake = make()
    fake.answers["/api_usage"] = usage_body(plan_daily_limit=None)
    assert provider.usage().daily_limit == 0  # 0: no daily cap
    fake.answers["/api_usage"] = usage_body(plan_daily_limit=0)
    assert provider.usage().daily_limit == 0
    body = dict(body_of("api_usage_start"))
    del body["plan_daily_limit"]
    fake.answers["/api_usage"] = lambda p: (200, {}, body)
    assert provider.usage().daily_limit is None  # not told: nothing to adopt
    pinned, pinned_fake = make(daily_credits=100)
    pinned_fake.answers["/api_usage"] = usage_body(plan_daily_limit=None)
    assert pinned.usage().daily_limit is None  # the user's own limit stays


def test_a_calibrated_guard_drops_its_daily_cap_when_the_api_has_none() -> None:
    fake = FakeTD()
    fake.answers["/api_usage"] = usage_body(plan_daily_limit=None, plan_category="grow")
    gp, guard = guarded(fake, UpstreamGuard(rate_per_min=55, burst=55, daily_limit=800))
    assert gp.seed_usage()
    assert guard.snapshot()["daily"] is None
    # ... unless the user set the cap themselves.
    gp, guard = guarded(
        fake, UpstreamGuard(rate_per_min=55, burst=55, daily_limit=800, calibrate_daily=False)
    )
    assert gp.seed_usage()
    assert guard.snapshot()["daily"]["limit"] == 800


def test_poll_interval_override_sets_the_quote_ttl() -> None:
    profile = td.effective_profile(config(plan="pro", poll_interval_s=5))
    assert profile.poll_interval_s == 5 and profile.quote_ttl_s == 5
    slow = td.effective_profile(config(plan="grow", poll_interval_s=600))
    assert slow.quote_ttl_s == 600
    assert td.setting_defaults_for(td.effective_profile(None))["quote_closed_ttl_s"] == 86400


# -- the app -----------------------------------------------------------------------------


@pytest.fixture
def served(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeTD]:
    """`MARKET_PROVIDER=twelvedata` with a key, the network replaced by `FakeTD`."""
    fake = FakeTD()
    monkeypatch.setenv("TWELVEDATA_API_KEY", KEY)
    # The plan's budget (8 per minute) applies, not conftest's permissive guard.
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)
    monkeypatch.setattr(http_module, "urllib_send", fake)
    yield fake


def app_client(tmp_path: Path) -> TestClient:
    settings = Settings(_env_file=None, market_provider="twelvedata")  # type: ignore[call-arg]
    app = create_app(settings_override=settings, database_url=f"sqlite:///{tmp_path}/t.db")
    return TestClient(app)


def test_international_symbol_on_basic_is_501_and_free(served: FakeTD, tmp_path: Path) -> None:
    with app_client(tmp_path) as client:
        r = client.get("/api/bars", params={"symbol": "VOD.L", "interval": "1d"})
        assert r.status_code == 501
        assert r.json() == {
            "detail": "international symbols is not supported by Twelve Data",
            "code": "unsupported",
            "feature": "international symbols",
            "provider": "Twelve Data",
        }
        q = client.get("/api/quotes", params={"symbols": "VOD.L"})
        assert q.status_code == 501
        assert client.get("/api/symbols/VOD.L").status_code == 501
    assert fake_calls_excluding_usage(served) == []


def fake_calls_excluding_usage(fake: FakeTD) -> list[str]:
    # The startup thread asks /api_usage once; nothing else may reach the upstream.
    return [p for p in fake.paths() if p != "/api_usage"]


def test_app_serves_bars_and_quotes(served: FakeTD, tmp_path: Path) -> None:
    with app_client(tmp_path) as client:
        r = client.get("/api/quotes", params={"symbols": "AAPL,MSFT"})
        assert r.status_code == 200
        assert {q["symbol"] for q in r.json()} >= {"AAPL", "MSFT"}
        listing = client.get("/api/providers").json()
        assert listing["active"] == "twelvedata"
        assert listing["activeCapabilities"]["intervals"]
        assert KEY not in client.get("/api/providers").text
        limits = listing["effectiveLimits"]
        assert limits["creditsPerMin"] == 8 and limits["dailyCredits"] == 800


def test_unknown_symbols_are_remembered(served: FakeTD, tmp_path: Path) -> None:
    with app_client(tmp_path) as client:
        for _ in range(3):
            r = client.get("/api/bars", params={"symbol": "ZZZZNOTREAL", "interval": "1d"})
            assert r.status_code == 404
            assert client.get("/api/symbols/ZZZZNOTREAL").status_code == 404
        paths = fake_calls_excluding_usage(served)
        # One lookup per path, however often the typo is asked for.
        assert paths.count("/time_series") <= 1 and paths.count("/symbol_search") <= 1


def test_app_starts_without_a_key(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def refuse(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("no key, no request")

    monkeypatch.setattr(http_module, "urllib_send", refuse)
    with app_client(tmp_path) as client:
        entry = next(
            p for p in client.get("/api/providers").json()["providers"] if p["id"] == "twelvedata"
        )
        assert entry["configured"] is False
        key = next(f for f in entry["config"] if f["name"] == "api_key")
        assert key["env"] == "TWELVEDATA_API_KEY" and key["set"] is False
        assert entry["plan"] == "basic"
        for url, params in (
            ("/api/quotes", {"symbols": "AAPL"}),
            ("/api/bars", {"symbol": "AAPL", "interval": "1d"}),
        ):
            r = client.get(url, params=params)
            assert r.status_code == 503 and r.json()["code"] == "not_configured"
        test = client.post("/api/providers/test").json()
        assert test["ok"] is False and test["code"] == "not_configured"
