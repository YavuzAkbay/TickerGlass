"""Tiingo provider over hand-built responses (`tiingo_fake.FakeTiingo`): plans, symbol mapping,
bars (split adjustment, weekly / monthly / quarterly and intraday interval synthesis, sessions),
quotes, search, errors, request accounting, the registry entry and the live source over a fake
WebSocket network. No network."""

import asyncio
import logging
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from pydantic import SecretStr, ValidationError
from tiingo_fake import Answer, FakeTiingo, error
from ws_fake import FakeConn, FakeNet, until

from tickerglass_api.live import normalize_message
from tickerglass_api.metrics import upstream
from tickerglass_api.providers import tiingo
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    PartialQuotes,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
    as_symbol_routing,
    metering,
)
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.registry import (
    PROVIDERS,
    apply_setting_defaults,
    config_fields,
    load_config,
    missing_config,
)
from tickerglass_api.providers.stream import Backoff
from tickerglass_api.settings import Settings

KEY = "tiingo-test-key-0123456789abcdef"
NY = ZoneInfo("America/New_York")
# 15:59:59 New York on Tuesday 2026-10-27.
NOW = datetime(2026, 10, 27, 19, 59, 59, tzinfo=UTC)
SPEC = PROVIDERS["tiingo"]
WINDOW = (datetime(2026, 10, 26, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))
DAYS = (datetime(2026, 10, 20, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))
STOCK_DAILY = "/tiingo/daily/aapl/prices"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("TIINGO_"):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


def config(**kwargs: Any) -> tiingo.TiingoConfig:
    return tiingo.TiingoConfig(
        api_key=SecretStr(KEY),
        _env_file=None,  # type: ignore[call-arg]
        **kwargs,
    )


def make(
    fake: FakeTiingo | None = None, now: datetime = NOW, **kwargs: Any
) -> tuple[tiingo.TiingoProvider, FakeTiingo]:
    fake = fake or FakeTiingo()
    return tiingo.TiingoProvider(config(**kwargs), send=fake, clock=lambda: now), fake


class Meter:
    """Collects the requests a call charges beyond the guard's own (`charge_upstream`)."""

    def __init__(self) -> None:
        self.charges: list[int] = []

    def __call__(self, n: int) -> None:
        self.charges.append(n)

    @property
    def total(self) -> int:
        return sum(self.charges)


def day_row(day: str, close: float, *, split: float = 1.0, volume: int = 1000) -> dict[str, Any]:
    """A daily row: open one below, high one above and low two below the close."""
    return {
        "date": f"{day}T00:00:00.000Z",
        "open": close - 1,
        "high": close + 1,
        "low": close - 2,
        "close": close,
        "volume": volume,
        "adjClose": close - 0.5,
        "splitFactor": split,
        "divCash": 0.0,
    }


def serve_daily(fake: FakeTiingo, rows: list[dict[str, Any]]) -> None:
    fake.answers[STOCK_DAILY] = lambda params: (200, {}, rows)


def local_midnight(ts: int, tz: ZoneInfo = NY) -> tuple[int, int, int, int]:
    local = datetime.fromtimestamp(ts, tz)
    return local.month, local.day, local.hour, local.minute


# -- plans and configuration -------------------------------------------------------------


def test_plan_table() -> None:
    starter, power = tiingo.PLAN_PROFILES["starter"], tiingo.PLAN_PROFILES["power"]
    assert (starter.requests_per_hour, starter.burst, starter.requests_per_day) == (50, 10, 1000)
    assert starter.symbols_per_month == 500
    assert (power.requests_per_hour, power.requests_per_day) == (10_000, 100_000)


def test_capabilities_state_what_tiingo_serves() -> None:
    caps = tiingo.capabilities_for(None)
    # 1m and 2m cannot be built from the documented 5-minute bars, 5d is never offered.
    assert caps.intervals == {"5m", "15m", "30m", "60m", "90m", "1d", "1wk", "1mo", "3mo"}
    assert caps.markets == {"us", "crypto"}
    assert caps.search and caps.adjusted_close
    assert not caps.extended_history and not caps.extended_quotes
    assert not caps.news and not caps.events
    assert not caps.fundamentals_info and not caps.fundamentals_statements


def test_streaming_capability_follows_the_stream_setting() -> None:
    assert not tiingo.capabilities_for(None).streaming
    assert not tiingo.capabilities_for(config()).streaming
    assert tiingo.capabilities_for(config(stream=True)).streaming


def test_a_quote_batch_is_one_request_whatever_its_size() -> None:
    costs = tiingo.costs_for(None)
    assert (costs.history, costs.symbol_info, costs.search) == (1, 1, 1)
    assert costs.quotes(1) == 1 and costs.quotes(200) == 1 and costs.quotes(201) == 2
    assert (costs.events, costs.news, costs.fundamentals) == (0, 0, 0)


def test_setting_defaults_follow_the_plan() -> None:
    starter = tiingo.setting_defaults_for(config())
    assert starter["upstream_rate_per_min"] == pytest.approx(50 / 60)
    assert (starter["upstream_burst"], starter["upstream_daily_limit"]) == (10, 1000)
    assert tiingo.setting_defaults_for(None) == starter
    power = tiingo.setting_defaults_for(config(plan="power"))
    assert power["upstream_rate_per_min"] == pytest.approx(10_000 / 60)
    assert (power["upstream_burst"], power["upstream_daily_limit"]) == (100, 100_000)
    assert starter["quote_ttl_s"] > power["quote_ttl_s"]  # a scarce budget caches longer
    assert tiingo.plan_of(config(plan="power")) == "power"
    assert tiingo.plan_of(None) == "starter"


def test_registry_entry_and_config_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    assert SPEC.config is tiingo.TiingoConfig and SPEC.self_paging and SPEC.network
    assert SPEC.make_live is not None and SPEC.probe_symbol == "AAPL"
    assert SPEC.terms is not None and "TIINGO_API_KEY" in SPEC.terms
    assert missing_config(SPEC) == ["TIINGO_API_KEY"]
    with pytest.raises(ProviderNotConfigured, match="TIINGO_API_KEY"):
        load_config(SPEC)
    monkeypatch.setenv("TIINGO_API_KEY", KEY)
    loaded = load_config(SPEC)
    assert isinstance(loaded, tiingo.TiingoConfig) and loaded.plan == "starter"
    assert not loaded.stream
    fields = {f.name: f for f in config_fields(SPEC, loaded)}
    assert fields["api_key"].secret and fields["api_key"].value is None
    assert fields["api_key"].required and fields["api_key"].env == "TIINGO_API_KEY"
    assert fields["plan"].value == "starter" and not fields["plan"].secret
    assert fields["stream"].value is False and fields["stream"].env == "TIINGO_STREAM"
    assert fields["base_url"].value == "https://api.tiingo.com"
    assert SPEC.capabilities(loaded) == tiingo.capabilities_for(loaded)
    assert SPEC.plan(loaded) == "starter"
    # The budget follows the plan unless the user set one.
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)  # conftest's permissive guard
    defaults = apply_setting_defaults(SPEC, Settings(_env_file=None), loaded)  # type: ignore[call-arg]
    assert defaults.upstream_rate_per_min == pytest.approx(50 / 60)
    assert (defaults.upstream_burst, defaults.upstream_daily_limit) == (10, 1000)
    pinned = apply_setting_defaults(
        SPEC,
        Settings(upstream_rate_per_min=7, _env_file=None),  # type: ignore[call-arg]
        loaded,
    )
    assert pinned.upstream_rate_per_min == 7
    made = SPEC.make(defaults, loaded)
    assert isinstance(made, tiingo.TiingoProvider)
    # The stream is opt-in: without TIINGO_STREAM the hub polls.
    assert SPEC.make_live(made, loaded) is None  # type: ignore[misc]
    monkeypatch.setenv("TIINGO_STREAM", "true")
    streaming = load_config(SPEC)
    assert isinstance(SPEC.make_live(made, streaming), tiingo.TiingoLiveSource)  # type: ignore[misc]


# -- symbols -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("canonical", "mapped"),
    [
        ("AAPL", ("aapl", False)),
        ("aapl", ("aapl", False)),
        ("BRK-B", ("brk-b", False)),
        ("BRK.B", ("brk-b", False)),
        ("BTC-USD", ("btcusd", True)),
        ("ETH-USDT", ("ethusdt", True)),
        ("SOL-EUR", ("soleur", True)),
    ],
)
def test_to_provider_maps_canonical_symbols(canonical: str, mapped: tuple[str, bool]) -> None:
    found = tiingo.to_provider(canonical)
    assert found is not None and (found.ticker, found.crypto) == mapped


@pytest.mark.parametrize(
    "unsupported", ["^GSPC", "EURUSD=X", "GC=F", "VOD.L", "SAP.DE", "BTC-JPY", "TOOLONGSYMBOL", ""]
)
def test_to_provider_refuses_what_tiingo_does_not_serve(unsupported: str) -> None:
    assert tiingo.to_provider(unsupported) is None


def test_symbol_timezones_and_crypto_names() -> None:
    stock, coin = tiingo.to_provider("AAPL"), tiingo.to_provider("BTC-USD")
    assert stock is not None and stock.timezone == "America/New_York"
    assert coin is not None and coin.timezone == "UTC" and coin.currency == "USD"
    assert tiingo.crypto_symbol("btc", "usd") == "BTC-USD"
    assert tiingo.crypto_symbol("btc", "jpy") is None


def test_symbol_routing_answers_unsupported_symbols_locally() -> None:
    provider, fake = make()
    routing = as_symbol_routing(provider)
    assert routing is not None
    assert routing.billable(["AAPL", "aapl", "^GSPC", "BTC-USD", "VOD.L"]) == ["AAPL", "BTC-USD"]
    assert routing.answers_locally("history", "^GSPC") and not routing.answers_locally(
        "history", "AAPL"
    )
    assert routing.answers_locally("events", "AAPL") and routing.answers_locally("news", "AAPL")
    assert routing.answers_locally("fundamentals", "AAPL")
    assert fake.calls == []


# -- history: daily and longer -------------------------------------------------------------


def test_daily_request_shape_and_frame() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1d", *DAYS, False)
    assert list(df.columns) == BAR_COLUMNS
    assert len(fake.calls) == 1
    path, params, headers = fake.calls[0]
    assert path == STOCK_DAILY
    # Fetched up to today (no endDate): the splits after each bar must be known.
    assert params == {"startDate": "2026-10-19"}
    assert headers["Authorization"] == f"Token {KEY}"
    assert KEY not in fake.urls[0]
    assert df["ts"].tolist()[0] == int(datetime(2026, 10, 20, 4, tzinfo=UTC).timestamp())
    assert len(df) == 6
    last = df.iloc[-1]
    assert (last["open"], last["high"], last["low"], last["close"]) == (
        343.165,
        347.77,
        342.4,
        347.25,
    )
    assert df["ts"].is_monotonic_increasing
    # `close` is raw here (no splits), `adj_close` is Tiingo's adjClose.
    assert df.iloc[0]["close"] == 340.2 and df.iloc[0]["adj_close"] == 339.2


def test_daily_bars_are_stamped_at_new_york_midnight() -> None:
    provider, _ = make()
    df = provider.history("AAPL", "1d", *DAYS, False)
    assert {local_midnight(int(t)) for t in df["ts"]} == {
        (10, d, 0, 0) for d in (20, 21, 22, 23, 26, 27)
    }


def test_daily_window_is_cut_to_the_range() -> None:
    provider, _ = make()
    start, end = datetime(2026, 10, 22, 4, tzinfo=UTC), datetime(2026, 10, 26, 4, tzinfo=UTC)
    df = provider.history("AAPL", "1d", start, end, False)
    assert [local_midnight(int(t))[1] for t in df["ts"]] == [22, 23]  # [start, end)


def test_no_start_asks_from_the_earliest_date() -> None:
    provider, fake = make()
    provider.history("AAPL", "1d", None, None, False)
    assert fake.calls[0][1]["startDate"] == "1962-01-02"


def test_splits_after_a_bar_adjust_its_prices_and_volume() -> None:
    fake = FakeTiingo()
    serve_daily(
        fake,
        [
            day_row("2026-10-19", 404, volume=1000),
            day_row("2026-10-20", 102, split=4, volume=4000),  # 4-for-1, ex-date
            day_row("2026-10-21", 103),
            day_row("2026-10-22", 51, split=2),  # 2-for-1
            day_row("2026-10-23", 52),
        ],
    )
    provider, _ = make(fake)
    df = provider.history("AAPL", "1d", datetime(2026, 10, 19, tzinfo=UTC), DAYS[1], False)
    # Split-adjusted like Yahoo's: one continuous series (404/8, 102/2, 103/2, 51, 52).
    assert df["close"].tolist() == pytest.approx([50.5, 51, 51.5, 51, 52])
    assert df["open"].tolist() == pytest.approx([50.375, 50.5, 51.0, 50.0, 51.0])
    assert df["volume"].tolist() == pytest.approx([8000, 8000, 2000, 1000, 1000])
    assert df["adj_close"].tolist() == [403.5, 101.5, 102.5, 50.5, 51.5]  # Tiingo's as given


def test_missing_adj_close_and_split_columns_fall_back_to_close() -> None:
    fake = FakeTiingo()
    rows = [day_row("2026-10-20", 100), day_row("2026-10-21", 101)]
    for row in rows:
        del row["adjClose"], row["splitFactor"]
    serve_daily(fake, rows)
    provider, _ = make(fake)
    df = provider.history("AAPL", "1d", *DAYS, False)
    assert df["adj_close"].tolist() == df["close"].tolist() == [100, 101]


def test_weekly_bars_are_built_from_daily_ones_and_stamped_on_mondays() -> None:
    fake = FakeTiingo()
    serve_daily(
        fake,
        [
            day_row("2026-10-06", 100, volume=10),  # Tuesday of the week of the 5th
            day_row("2026-10-07", 110, volume=20),
            day_row("2026-10-09", 105, volume=30),
            day_row("2026-10-13", 120, volume=40),  # the week of the 12th
            day_row("2026-10-14", 118, volume=50),
        ],
    )
    provider, fake = make(fake)
    start, end = datetime(2026, 10, 7, tzinfo=UTC), datetime(2026, 10, 30, tzinfo=UTC)
    # A mid-week start asks from the Monday so the first week is whole (and then dropped as
    # it starts before `start`).
    df = provider.history("AAPL", "1wk", start, end, False)
    assert fake.calls[0][1]["startDate"] == "2026-10-05"
    assert [local_midnight(int(t)) for t in df["ts"]] == [(10, 12, 0, 0)]
    bar = df.iloc[0]
    assert (bar["open"], bar["high"], bar["low"], bar["close"], bar["volume"]) == (
        119,
        121,
        116,
        118,
        90,
    )
    whole = provider.history("AAPL", "1wk", datetime(2026, 10, 5, 4, tzinfo=UTC), end, False)
    assert [local_midnight(int(t)) for t in whole["ts"]] == [(10, 5, 0, 0), (10, 12, 0, 0)]
    first = whole.iloc[0]
    assert (first["open"], first["high"], first["low"], first["close"], first["volume"]) == (
        99,
        111,
        98,
        105,
        60,
    )
    assert first["adj_close"] == 104.5  # the last day's adjClose


def test_monthly_and_quarterly_bars_are_built_from_daily_ones() -> None:
    fake = FakeTiingo()
    serve_daily(
        fake,
        [
            day_row("2026-08-03", 100, volume=1),
            day_row("2026-08-31", 101, volume=2),
            day_row("2026-09-15", 102, volume=3),
            day_row("2026-10-01", 103, volume=4),
            day_row("2026-10-27", 105, volume=5),
        ],
    )
    provider, fake = make(fake)
    start, end = datetime(2026, 7, 1, tzinfo=NY), datetime(2026, 11, 1, tzinfo=UTC)
    monthly = provider.history("AAPL", "1mo", start, end, False)
    assert fake.calls[0][1]["startDate"] == "2026-07-01"
    assert [local_midnight(int(t)) for t in monthly["ts"]] == [
        (8, 1, 0, 0),
        (9, 1, 0, 0),
        (10, 1, 0, 0),
    ]
    assert monthly["volume"].tolist() == [3, 3, 9]
    quarterly = provider.history("AAPL", "3mo", start, end, False)
    assert [local_midnight(int(t)) for t in quarterly["ts"]] == [(7, 1, 0, 0), (10, 1, 0, 0)]
    assert quarterly["volume"].tolist() == [6, 9]
    q3 = quarterly.iloc[0]
    assert (q3["open"], q3["high"], q3["low"], q3["close"]) == (99, 103, 98, 102)


def test_a_period_stops_at_the_end_of_the_range() -> None:
    fake = FakeTiingo()
    serve_daily(
        fake, [day_row("2026-10-06", 100), day_row("2026-10-08", 110), day_row("2026-10-09", 90)]
    )
    provider, _ = make(fake)
    start, end = datetime(2026, 10, 5, 4, tzinfo=UTC), datetime(2026, 10, 9, 4, tzinfo=UTC)
    df = provider.history("AAPL", "1wk", start, end, False)
    assert len(df) == 1 and df.iloc[0]["close"] == 110 and df.iloc[0]["volume"] == 2000


def test_a_quarter_start_aligns_the_fetch() -> None:
    provider, fake = make()
    provider.history("AAPL", "3mo", datetime(2026, 11, 20, tzinfo=UTC), None, False)
    assert fake.calls[0][1]["startDate"] == "2026-10-01"


def test_empty_answers_and_ranges_are_empty_frames() -> None:
    provider, fake = make()
    far = datetime(2027, 3, 1, tzinfo=UTC)
    for interval in ("1d", "1wk", "1mo", "3mo", "5m", "60m"):
        df = provider.history("AAPL", interval, far, far + timedelta(days=3), False)
        assert df.empty and list(df.columns) == BAR_COLUMNS, interval
    before = len(fake.calls)
    reversed_range = provider.history("AAPL", "1d", WINDOW[1], WINDOW[0], False)
    assert reversed_range.empty and len(fake.calls) == before  # nothing was asked


def test_an_unknown_stock_is_not_found() -> None:
    provider, _ = make()
    with pytest.raises(SymbolNotFound):
        provider.history("ZZZZ", "1d", *DAYS, False)
    with pytest.raises(SymbolNotFound):
        provider.history("ZZZZ", "5m", *WINDOW, False)


def test_malformed_payloads_are_provider_errors() -> None:
    fake = FakeTiingo()
    fake.answers[STOCK_DAILY] = lambda params: (200, {}, {"detail": "odd"})
    with pytest.raises(ProviderError, match="unexpected prices payload"):
        make(fake)[0].history("AAPL", "1d", *DAYS, False)
    fake.answers[STOCK_DAILY] = lambda params: (200, {}, [{"date": "2026-10-20T00:00:00.000Z"}])
    with pytest.raises(ProviderError, match="lacks 'open'"):
        make(fake)[0].history("AAPL", "1d", *DAYS, False)
    # Rows without usable numbers are skipped.
    fake.answers[STOCK_DAILY] = lambda params: (
        200,
        {},
        [day_row("2026-10-20", 100), {**day_row("2026-10-21", 101), "close": None}],
    )
    assert len(make(fake)[0].history("AAPL", "1d", *DAYS, False)) == 1


# -- history: intraday ---------------------------------------------------------------------


def test_five_minute_request_shape_and_regular_session_cut() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "5m", *WINDOW, False)
    assert len(fake.calls) == 1
    path, params, _ = fake.calls[0]
    assert path == "/iex/aapl/prices"
    assert params == {
        "startDate": "2026-10-25",  # New York date of the start (Sunday evening)
        "endDate": "2026-10-27",
        "resampleFreq": "5min",
        "columns": "open,high,low,close,volume",
    }
    stamps = [datetime.fromtimestamp(int(t), UTC).strftime("%d %H:%M") for t in df["ts"]]
    # The 12:00Z (pre-market) and 20:00Z (post-market) bars are not served.
    assert "26 12:00" not in stamps and "26 20:00" not in stamps
    assert stamps[0] == "26 13:30" and len(df) == 10
    assert (df.iloc[0]["open"], df.iloc[0]["volume"]) == (343.0, 52000)
    assert (df["adj_close"] == df["close"]).all()
    # `prepost` changes nothing: extended hours are not a capability.
    assert provider.history("AAPL", "5m", *WINDOW, True)["ts"].tolist() == df["ts"].tolist()


def test_an_hour_bar_overlapping_the_session_is_kept() -> None:
    assert not tiingo.capabilities_for(None).extended_history
    frame = pd.DataFrame(
        {
            "ts": [int(datetime(2026, 10, 27, h, m, tzinfo=NY).timestamp()) for h, m in
                   [(9, 25), (9, 30), (15, 55), (16, 0)]],
            "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "adj_close": 1.0, "volume": 1.0,
        }
    )  # fmt: skip
    kept = tiingo._regular_hours(frame, 5)
    assert [datetime.fromtimestamp(int(t), NY).strftime("%H:%M") for t in kept["ts"]] == [
        "09:30",
        "15:55",
    ]
    # A 09:25 bar of five minutes ends at the open: out; a 60-minute 09:00 bar overlaps: in.
    assert len(tiingo._regular_hours(frame, 60)) == 3


@pytest.mark.parametrize(
    ("interval", "starts"),
    [
        ("15m", ["26 13:30", "26 13:45", "26 14:00", "26 19:45", "27 13:30", "27 15:00"]),
        ("30m", ["26 13:30", "26 14:00", "26 19:30", "27 13:30", "27 15:00", "27 19:30"]),
        ("60m", ["26 13:30", "26 19:30", "27 13:30", "27 14:30", "27 19:30"]),
        ("90m", ["26 13:30", "26 19:30", "27 13:30", "27 15:00", "27 19:30"]),
    ],
)
def test_longer_intraday_bars_are_built_from_five_minute_ones(
    interval: str, starts: list[str]
) -> None:
    provider, fake = make()
    df = provider.history("AAPL", interval, *WINDOW, False)
    assert len(fake.calls) == 1 and fake.calls[0][1]["resampleFreq"] == "5min"
    got = [datetime.fromtimestamp(int(t), UTC).strftime("%d %H:%M") for t in df["ts"]]
    assert got[: len(starts)] == starts
    five = provider.history("AAPL", "5m", *WINDOW, False)
    assert df["volume"].sum() == five["volume"].sum()  # nothing lost or counted twice
    assert df["high"].max() == five["high"].max() and df["low"].min() == five["low"].min()


def test_thirty_minute_bar_values() -> None:
    provider, _ = make()
    df = provider.history("AAPL", "30m", *WINDOW, False)
    first = df.iloc[0]  # 13:30, 13:35, 13:40, 13:55 of Monday
    assert (first["open"], first["high"], first["low"], first["close"], first["volume"]) == (
        343.0,
        344.6,
        342.9,
        343.4,
        137000,
    )


def test_unserved_intervals_are_unsupported_without_a_request() -> None:
    provider, fake = make()
    for interval in ("1m", "2m", "5d", "4h", ""):
        with pytest.raises(ProviderUnsupported, match="bars"):
            provider.history("AAPL", interval, *WINDOW, False)
    assert fake.calls == []


def test_an_intraday_call_without_start_looks_back_a_bounded_span() -> None:
    provider, fake = make()
    provider.history("AAPL", "5m", None, None, False)
    assert "endDate" not in fake.calls[0][1]
    assert fake.calls[0][1]["startDate"] == (NOW - tiingo.INTRADAY_DEFAULT_SPAN).date().isoformat()
    provider.history("AAPL", "5m", None, datetime(2026, 9, 1, tzinfo=UTC), False)
    # 60 days before 2026-09-01 00:00Z, as the New York date.
    assert fake.calls[1][1]["startDate"] == "2026-07-02"


def test_intraday_range_is_cut_to_start_and_end() -> None:
    provider, _ = make()
    start, end = (
        datetime(2026, 10, 27, 13, 35, tzinfo=UTC),
        datetime(2026, 10, 27, 15, 0, tzinfo=UTC),
    )
    df = provider.history("AAPL", "5m", start, end, False)
    assert [datetime.fromtimestamp(int(t), UTC).strftime("%H:%M") for t in df["ts"]] == ["13:35"]


# -- history: crypto -----------------------------------------------------------------------


def test_crypto_daily_bars_use_the_crypto_endpoint_and_utc_midnight() -> None:
    provider, fake = make()
    df = provider.history("BTC-USD", "1d", *DAYS, False)
    path, params, _ = fake.calls[0]
    assert path == "/tiingo/crypto/prices"
    assert params == {
        "startDate": "2026-10-20",
        "tickers": "btcusd",
        "resampleFreq": "1day",
        "endDate": "2026-10-27",
    }
    assert len(df) == 5
    assert {local_midnight(int(t), ZoneInfo("UTC")) for t in df["ts"]} == {
        (10, d, 0, 0) for d in (23, 24, 25, 26, 27)
    }
    assert (df["adj_close"] == df["close"]).all()  # crypto has no adjustments
    assert df.iloc[0]["close"] == 92000.0 and df.iloc[0]["volume"] == 1500.5


def test_crypto_intraday_bars_have_no_session_filter() -> None:
    provider, fake = make()
    five = provider.history("BTC-USD", "5m", *WINDOW, False)
    assert len(five) == 48  # both days' 24 bars, midnight included
    assert fake.calls[0][1]["resampleFreq"] == "5min" and "columns" not in fake.calls[0][1]
    assert fake.calls[0][1]["startDate"] == "2026-10-26"
    ninety = provider.history("BTC-USD", "90m", *WINDOW, False)
    stamps = [datetime.fromtimestamp(int(t), UTC).strftime("%d %H:%M") for t in ninety["ts"]]
    assert stamps == ["26 00:00", "26 01:30", "27 00:00", "27 01:30"]  # anchored at UTC midnight
    assert ninety["volume"].sum() == five["volume"].sum()


def test_crypto_weekly_bars_come_from_utc_days() -> None:
    provider, _ = make()
    df = provider.history("BTC-USD", "1wk", datetime(2026, 10, 19, tzinfo=UTC), WINDOW[1], False)
    assert [local_midnight(int(t), ZoneInfo("UTC")) for t in df["ts"]] == [
        (10, 19, 0, 0),
        (10, 26, 0, 0),
    ]
    assert df["volume"].tolist() == pytest.approx([1500.5 + 1200.25 + 1100, 1300.75 + 900.5])


def test_an_unknown_crypto_pair_has_no_bars() -> None:
    provider, _ = make()
    assert provider.history("ZZZ-USD", "1d", *DAYS, False).empty


def test_unsupported_symbols_never_reach_the_api() -> None:
    provider, fake = make()
    for symbol, what in (
        ("^GSPC", "index"),
        ("EURUSD=X", "forex"),
        ("GC=F", "futures"),
        ("VOD.L", "non-US"),
    ):
        with pytest.raises(ProviderUnsupported, match=what):
            provider.history(symbol, "1d", *DAYS, False)
    assert fake.calls == []


# -- errors --------------------------------------------------------------------------------


def failing(name: str | None = None, status: int = 500, **head: str) -> FakeTiingo:
    fake = FakeTiingo()
    fake.answers[STOCK_DAILY] = lambda params: (
        error(name) if name else (status, dict(head), {"detail": "boom"})
    )
    return fake


def test_rejected_key_names_the_setting_and_never_leaks_it() -> None:
    provider, _ = make(failing("unauthorized"))
    with pytest.raises(ProviderNotConfigured, match="TIINGO_API_KEY") as info:
        provider.history("AAPL", "1d", *DAYS, False)
    assert KEY not in str(info.value)
    fake = FakeTiingo()
    fake.answers[STOCK_DAILY] = lambda params: (403, {}, {"detail": "Invalid token."})
    with pytest.raises(ProviderNotConfigured):
        make(fake)[0].history("AAPL", "1d", *DAYS, False)


def test_a_plan_restricted_endpoint_is_unsupported() -> None:
    provider, _ = make(failing("forbidden_plan"))
    with pytest.raises(ProviderUnsupported, match="Tiingo"):
        provider.history("AAPL", "1d", *DAYS, False)


def test_the_hourly_limit_is_a_rate_limit_until_the_next_hour() -> None:
    provider, _ = make(failing("hourly"), now=datetime(2026, 10, 27, 19, 40, 0, tzinfo=UTC))
    with pytest.raises(RateLimited, match="50 requests per hour") as limited:
        provider.history("AAPL", "1d", *DAYS, False)
    assert limited.value.retry_after == 20 * 60 and not limited.value.daily
    # A Retry-After header longer than that wins.
    fake = FakeTiingo()
    fake.answers[STOCK_DAILY] = lambda params: (
        429,
        {"retry-after": "5000"},
        {"detail": "over the allowed 50 requests per hour"},
    )
    with pytest.raises(RateLimited) as longer:
        make(fake)[0].history("AAPL", "1d", *DAYS, False)
    assert longer.value.retry_after == 5000


def test_the_daily_limit_is_a_daily_rate_limit_until_midnight_utc() -> None:
    provider, _ = make(failing("daily"), now=datetime(2026, 10, 27, 22, 0, 0, tzinfo=UTC))
    with pytest.raises(RateLimited, match="1000 requests per day") as limited:
        provider.history("AAPL", "1d", *DAYS, False)
    assert limited.value.daily and limited.value.retry_after == 2 * 3600


@pytest.mark.parametrize("name", ["monthly_symbols", "monthly_symbols_400"])
def test_the_monthly_symbol_cap_surfaces_tiingos_own_text(name: str) -> None:
    provider, _ = make(failing(name))
    with pytest.raises(ProviderError, match="500 symbol look up for this month") as info:
        provider.history("AAPL", "1d", *DAYS, False)
    # Not a rate limit: retrying cannot help, and the guard must not shut everything down.
    assert not isinstance(info.value, RateLimited)
    assert "monthly allowance" in str(info.value)


def test_other_failures_map_to_the_provider_errors() -> None:
    provider, _ = make(failing(status=429, **{"retry-after": "7"}))
    with pytest.raises(RateLimited) as limited:
        provider.history("AAPL", "1d", *DAYS, False)
    assert limited.value.retry_after == 7 and not limited.value.daily
    with pytest.raises(UpstreamUnavailable):
        make(failing(status=503))[0].history("AAPL", "1d", *DAYS, False)
    with pytest.raises(ProviderError, match="startDate is not a valid date"):
        make(failing("bad_request"))[0].history("AAPL", "1d", *DAYS, False)

    def down(url: str, headers: Mapping[str, str], timeout: float) -> Any:
        raise ConnectionResetError("reset")

    with pytest.raises(UpstreamUnavailable):
        tiingo.TiingoProvider(config(), send=down).history("AAPL", "1d", *DAYS, False)


def test_every_request_counts_in_the_upstream_metrics() -> None:
    before = upstream.snapshot().get(("tiingo", "ok"), 0)
    provider, fake = make()
    provider.history("AAPL", "1d", *DAYS, False)
    provider.search("AAPL", 3)
    provider.quotes(["AAPL", "BTC-USD"])  # a stock and a crypto request
    after = upstream.snapshot().get(("tiingo", "ok"), 0)
    assert after - before == len(fake.calls) == 4
    limited = upstream.snapshot().get(("tiingo", "rate_limited"), 0)
    with pytest.raises(RateLimited):
        make(failing(status=429))[0].history("AAPL", "1d", *DAYS, False)
    assert upstream.snapshot().get(("tiingo", "rate_limited"), 0) == limited + 1


def test_guarded_provider_refuses_unsupported_things_without_a_request() -> None:
    provider, fake = make()
    guarded = GuardedProvider(
        provider,
        UpstreamGuard(),
        costs=tiingo.costs_for(None),
        capabilities=tiingo.capabilities_for(None),
    )
    for call in (
        lambda: guarded.history("AAPL", "1m", *WINDOW, False),
        lambda: guarded.history("AAPL", "5d", *DAYS, False),
        lambda: guarded.events("AAPL"),
        lambda: guarded.fundamentals("AAPL"),
        lambda: guarded.news("AAPL", 3),
        lambda: guarded.extended_quotes(["AAPL"]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()
    assert fake.calls == []
    assert len(guarded.history("AAPL", "5m", *WINDOW, False)) == 10


def test_not_offered_features_raise_unsupported() -> None:
    provider, _ = make()
    for call in (
        lambda: provider.events("AAPL"),
        lambda: provider.news("AAPL", 3),
        lambda: provider.fundamentals("AAPL"),
        lambda: provider.extended_quotes(["AAPL"]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()


# -- quotes --------------------------------------------------------------------------------


def test_stock_quotes_are_one_request_and_use_tngo_last() -> None:
    provider, fake = make()
    rows = provider.quotes(["AAPL", "BRK-B", "MSFT"])
    assert len(fake.calls) == 1
    path, params, _ = fake.calls[0]
    assert path == "/iex/" and params == {"tickers": "aapl,brk-b,msft"}
    by_symbol = {r["symbol"]: r for r in rows}
    assert set(by_symbol) == {"AAPL", "BRK-B"}  # MSFT has no price yet
    aapl = by_symbol["AAPL"]
    assert aapl["last"] == 347.25 and aapl["prevClose"] == 343.91  # `last` is null upstream
    assert aapl["change"] == pytest.approx(3.34)
    assert aapl["changePercent"] == pytest.approx(3.34 / 343.91 * 100)
    assert (aapl["open"], aapl["dayHigh"], aapl["dayLow"]) == (343.165, 347.77, 342.4)
    assert aapl["volume"] == 391880 and aapl["currency"] == "USD"
    assert aapl["marketState"] == "REGULAR"
    assert aapl["time"] == int(datetime(2026, 10, 27, 19, 59, 58, 123456, tzinfo=UTC).timestamp())
    assert isinstance(rows, QuoteList) and not rows.confirmed


@pytest.mark.parametrize(
    ("now", "state"),
    [
        (datetime(2026, 10, 27, 12, 30, tzinfo=UTC), "PRE"),  # 08:30 New York
        (datetime(2026, 10, 27, 19, 59, tzinfo=UTC), "REGULAR"),
        (datetime(2026, 10, 27, 21, 0, tzinfo=UTC), "POST"),  # 17:00
        (datetime(2026, 10, 28, 15, 0, tzinfo=UTC), "CLOSED"),  # the last trade is yesterday's
    ],
)
def test_market_state_follows_the_new_york_clock_and_the_last_trade_day(
    now: datetime, state: str
) -> None:
    provider, _ = make(now=now)
    assert provider.quotes(["AAPL"])[0]["marketState"] == state


def test_last_is_the_fallback_when_tngo_last_is_missing() -> None:
    fake = FakeTiingo()
    fake.answers["/iex/"] = lambda params: (
        200,
        {},
        [
            {"ticker": "AAPL", "tngoLast": None, "last": 12.5, "prevClose": 10.0},
            {"ticker": "BRK-B", "tngoLast": 3, "last": None, "prevClose": None},
        ],
    )
    rows = make(fake)[0].quotes(["AAPL", "BRK-B"])
    by_symbol = {r["symbol"]: r for r in rows}
    assert by_symbol["AAPL"]["last"] == 12.5 and by_symbol["AAPL"]["changePercent"] == 25
    assert by_symbol["BRK-B"]["last"] == 3 and by_symbol["BRK-B"]["change"] is None
    assert by_symbol["BRK-B"]["marketState"] == "CLOSED" and by_symbol["BRK-B"]["time"] is None


def test_one_listing_named_two_ways_gets_a_row_each() -> None:
    provider, fake = make()
    rows = provider.quotes(["BRK-B", "BRK.B"])
    assert [r["symbol"] for r in rows] == ["BRK-B", "BRK.B"]
    assert fake.calls[0][1]["tickers"] == "brk-b"


def test_crypto_quotes_are_their_own_request_with_the_previous_daily_close() -> None:
    provider, fake = make()
    meter = Meter()
    with metering(meter):
        rows = provider.quotes(["AAPL", "BTC-USD"])
    assert fake.paths() == ["/iex/", "/tiingo/crypto/prices"]
    assert meter.total == 1  # the guard paid for one request, there were two
    crypto = fake.calls[1][1]
    assert crypto["tickers"] == "btcusd" and crypto["resampleFreq"] == "1day"
    assert crypto["startDate"] == "2026-10-25"  # two days back: enough for the previous close
    by_symbol = {r["symbol"]: r for r in rows}
    btc = by_symbol["BTC-USD"]
    assert btc["last"] == 94800.0 and btc["prevClose"] == 93500.0
    assert btc["change"] == pytest.approx(1300) and btc["currency"] == "USD"
    assert (btc["open"], btc["dayHigh"], btc["dayLow"]) == (93500.0, 95000.0, 93100.0)
    assert btc["marketState"] == "REGULAR" and btc["time"] == int(NOW.timestamp())


def test_a_crypto_quote_takes_its_currency_from_the_pair_asked_for() -> None:
    fake = FakeTiingo()
    fake.answers["/tiingo/crypto/prices"] = lambda params: (
        200,
        {},
        [
            # No `quoteCurrency` in the answer: the symbol's own quote is not USD.
            {
                "ticker": "etheur",
                "priceData": [{"date": "2026-10-27T00:00:00+00:00", "close": 5.0}],
            },
        ],
    )
    row = make(fake)[0].quotes(["ETH-EUR"])[0]
    assert row["currency"] == "EUR"


def test_non_positive_prices_are_dropped_from_quotes_and_bars() -> None:
    fake = FakeTiingo()
    fake.answers["/iex/"] = lambda params: (
        200,
        {},
        [
            {"ticker": "aapl", "tngoLast": 0.0, "last": -1.0, "prevClose": 10.0},
            {"ticker": "msft", "tngoLast": 0.0, "last": 7.5, "prevClose": 10.0},
        ],
    )
    fake.answers["/tiingo/crypto/prices"] = lambda params: (
        200,
        {},
        [
            {
                "ticker": "btcusd",
                "priceData": [
                    {"date": "2026-10-26T00:00:00+00:00", "close": 9.0},
                    {"date": "2026-10-27T00:00:00+00:00", "close": 0.0},
                ],
            }
        ],
    )
    provider = make(fake)[0]
    rows = provider.quotes(["AAPL", "MSFT", "BTC-USD"])
    by_symbol = {r["symbol"]: r for r in rows}
    assert set(by_symbol) == {"MSFT", "BTC-USD"}  # AAPL has no usable price
    assert by_symbol["MSFT"]["last"] == 7.5 and by_symbol["BTC-USD"]["last"] == 9.0
    frame = tiingo._frame(
        [
            {"date": "2026-10-26T00:00:00Z", "open": 1, "high": 2, "low": 0, "close": 1},
            {"date": "2026-10-27T00:00:00Z", "open": 1, "high": 2, "low": 1, "close": 1},
        ],
        "UTC",
        daily=True,
        split_adjust=False,
    )
    assert len(frame) == 1


def test_only_the_allowance_wording_counts_as_the_monthly_limit() -> None:
    assert tiingo._limit_kind("You have run over your 500 symbol look up for this month") == "month"
    assert tiingo._limit_kind("Your bandwidth allowance is used up") == "month"
    assert tiingo._limit_kind("Error: monthly limit reached") == "month"
    # A bad parameter that happens to name a month is not an allowance.
    assert tiingo._limit_kind("Error: month 13 is not a valid month") is None
    assert tiingo._limit_kind("over the allowed 50 requests per hour") == "hour"


@pytest.mark.parametrize("bad", ["http://api.example.com", "api.example.com", "ftp://x.example"])
def test_the_base_url_must_be_https_unless_it_is_local(bad: str) -> None:
    with pytest.raises(ValidationError, match="TIINGO_BASE_URL"):
        config(base_url=bad)
    assert config(base_url="https://proxy.example.com/tiingo").base_url
    assert config(base_url="http://127.0.0.1:8080").base_url


def test_a_lone_crypto_bar_has_no_previous_close() -> None:
    fake = FakeTiingo()
    fake.answers["/tiingo/crypto/prices"] = lambda params: (
        200,
        {},
        [
            {
                "ticker": "btcusd",
                "quoteCurrency": "usd",
                "priceData": [{"date": "2026-10-27T00:00:00+00:00", "close": 5.0}],
            },
            {"ticker": "ethusd", "quoteCurrency": "usd", "priceData": []},
        ],
    )
    row = make(fake)[0].quotes(["BTC-USD", "ETH-USD"])[0]
    assert row["last"] == 5.0 and row["prevClose"] is None and row["changePercent"] is None


def test_quotes_are_chunked_by_the_batch_size_and_a_failed_chunk_is_partial() -> None:
    fillers = [f"S{i:03d}" for i in range(200)]
    provider, fake = make()
    meter = Meter()
    with metering(meter):
        assert provider.quotes(["AAPL", *fillers]) == provider.quotes(["AAPL", *fillers])
    sizes = [len(p["tickers"].split(",")) for _, p, _ in fake.calls[:2]]
    assert sizes == [200, 1]
    assert meter.total == 0  # ceil(201 / 200) = 2: the guard paid for both

    failed = FakeTiingo()
    answered: list[int] = []

    def second_chunk_fails(params: dict[str, str]) -> Answer:
        answered.append(1)
        if len(answered) == 2:
            return 500, {}, {}
        return failed.route("/iex/", params)

    failed.answers["/iex/"] = second_chunk_fails
    with pytest.raises(PartialQuotes) as partial:
        make(failed)[0].quotes(["AAPL", *fillers])
    assert [q["symbol"] for q in partial.value.quotes] == ["AAPL"]
    assert partial.value.failed == [fillers[-1]]
    all_failed = FakeTiingo()
    all_failed.answers["/iex/"] = lambda params: (500, {}, {})
    with pytest.raises(UpstreamUnavailable):
        make(all_failed)[0].quotes(["AAPL"])


def test_quotes_of_nothing_servable_raise_unsupported_without_a_request() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["^GSPC", "EURUSD=X"])
    assert provider.quotes([]) == []
    assert fake.calls == []
    rows = provider.quotes(["^GSPC", "AAPL"])  # the servable ones are asked, the rest skipped
    assert [r["symbol"] for r in rows] == ["AAPL"] and len(fake.calls) == 1


def test_an_unknown_symbol_is_omitted_from_quotes() -> None:
    provider, _ = make()
    assert [r["symbol"] for r in provider.quotes(["AAPL", "ZZZZ"])] == ["AAPL"]


def test_a_rate_limited_quote_request_raises_rate_limited() -> None:
    fake = FakeTiingo()
    fake.answers["/iex/"] = lambda params: error("hourly")
    with pytest.raises(RateLimited):
        make(fake)[0].quotes(["AAPL"])


def test_a_malformed_quotes_payload_is_a_provider_error() -> None:
    fake = FakeTiingo()
    fake.answers["/iex/"] = lambda params: (200, {}, {"detail": "odd"})
    with pytest.raises(ProviderError, match="unexpected quotes payload"):
        make(fake)[0].quotes(["AAPL"])


# -- symbol info and search ----------------------------------------------------------------


def test_stock_symbol_info_from_the_meta_endpoint() -> None:
    provider, fake = make()
    info = provider.symbol_info("AAPL")
    assert fake.paths() == ["/tiingo/daily/aapl"]
    assert info["symbol"] == "AAPL" and info["name"] == "Apple Inc"
    assert info["exchange"] == "NASDAQ" and info["type"] == "equity"
    assert (info["timezone"], info["session"], info["currency"]) == (
        "America/New_York",
        "0930-1600",
        "USD",
    )
    assert info["hasIntraday"] is True
    assert provider.symbol_info("BRK.B")["symbol"] == "BRK.B"
    assert fake.paths()[-1] == "/tiingo/daily/brk-b"


def test_crypto_symbol_info_from_the_crypto_meta_endpoint() -> None:
    provider, fake = make()
    info = provider.symbol_info("BTC-USD")
    assert fake.calls[0][0] == "/tiingo/crypto" and fake.calls[0][1] == {"tickers": "btcusd"}
    assert info["type"] == "cryptocurrency" and info["name"] == "Bitcoin (BTC/USD)"
    assert (info["timezone"], info["session"], info["currency"]) == ("UTC", "0000-2359", "USD")
    with pytest.raises(SymbolNotFound):
        provider.symbol_info("ZZZ-USD")


def test_symbol_info_of_an_unknown_or_unsupported_symbol() -> None:
    provider, _ = make()
    with pytest.raises(SymbolNotFound):
        provider.symbol_info("ZZZZ")
    with pytest.raises(ProviderUnsupported):
        provider.symbol_info("^GSPC")
    fake = FakeTiingo()
    fake.answers["/tiingo/daily/aapl"] = lambda params: (200, {}, ["odd"])
    with pytest.raises(ProviderError, match="unexpected meta payload"):
        make(fake)[0].symbol_info("AAPL")


def test_search_keeps_servable_active_us_listings_in_tiingos_order() -> None:
    provider, fake = make()
    rows = provider.search("AAPL", 10)
    assert fake.calls[0][0] == "/tiingo/utilities/search" and fake.calls[0][1] == {"query": "AAPL"}
    # Dropped: the inactive warrant, the German listing and the London suffix.
    assert [r["symbol"] for r in rows] == ["AAPL", "AAPU", "AAPLX"]
    assert [r["type"] for r in rows] == ["equity", "etf", "mutualfund"]
    assert rows[1]["typeDisplay"] == "ETF" and rows[0]["name"] == "Apple Inc"
    assert [r["symbol"] for r in provider.search("AAPL", 2)] == ["AAPL", "AAPU"]


def test_search_of_nothing_is_free_and_a_malformed_answer_an_error() -> None:
    provider, fake = make()
    assert provider.search("  ", 5) == [] and provider.search("AAPL", 0) == []
    assert fake.calls == []
    odd = FakeTiingo()
    odd.answers["/tiingo/utilities/search"] = lambda params: (200, {}, {"detail": "odd"})
    with pytest.raises(ProviderError, match="unexpected search payload"):
        make(odd)[0].search("AAPL", 5)


# -- live ----------------------------------------------------------------------------------

STREAM = "wss://stream.test/iex"


def live(net: FakeNet, max_failures: int | None = 6, **kwargs: Any) -> tiingo.TiingoLiveSource:
    return tiingo.TiingoLiveSource(
        config(stream=True, **kwargs),
        stream_url=STREAM,
        connect=net,
        backoff_factory=lambda: Backoff(initial_s=0.001, max_s=0.002, jitter=0),
        max_failures=max_failures,
    )


def subscribe_frame(*tickers: str, sub_id: Any = None) -> dict[str, Any]:
    data: dict[str, Any] = {"thresholdLevel": 6, "tickers": list(tickers)}
    if sub_id is not None:
        data["subscriptionId"] = sub_id
    return {"eventName": "subscribe", "authorization": KEY, "eventData": data}


def subscribes(conn: FakeConn, n: int = 1) -> bool:
    return sum(1 for m in conn.sent_json() if m.get("eventName") == "subscribe") >= n


async def handshake(conn: FakeConn, sub_id: int = 4242) -> None:
    """The server side of a login: the subscribe arrives, `I` answers it."""
    await until(lambda: subscribes(conn))
    conn.feed({"messageType": "I", "data": {"subscriptionId": sub_id}, "response": {"code": 200}})


def trade(
    ticker: str, price: float | None, when: datetime = NOW, kind: str = "T"
) -> dict[str, Any]:
    nanos = int(when.timestamp()) * 10**9 + 123_456_000
    row = [kind, when.isoformat(), nanos, ticker, 200, 1.0, 1.0, 1.0, 100, price, 100, None, 0, 0]
    return {"messageType": "A", "service": "iex", "data": row}


class Ticks:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    async def __call__(self, tick: dict[str, Any]) -> None:
        self.items.append(tick)


def test_live_subscribes_and_emits_hub_ticks() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        # The index, a non-US symbol and crypto are not streamed (the hub polls them).
        await source.subscribe(["AAPL", "BRK-B", "^GSPC", "VOD.L", "BTC-USD"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        assert net.urls() == [STREAM]
        assert net.calls[0][1] == {}  # the key is in the frame, never in a header or the URL
        conn = net.conns[0]
        await handshake(conn)
        assert conn.sent_json() == [subscribe_frame("aapl", "brk-b")]
        early = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)  # 08:00 New York
        conn.feed(
            {"messageType": "H", "response": {"code": 200, "message": "HeartBeat"}},
            trade("aapl", 348.0),
            trade("zzz", 1.0),  # nobody asked for it
            trade("aapl", 349.0, kind="Q"),  # top of book, not a trade
            trade("aapl", None),  # a trade row without a price
            {"messageType": "A", "data": ["T", "x"]},  # too short
            {"messageType": "A", "data": "garbage"},
            trade("BRK-B", 512.4, early),  # tickers match in any case
            [1, 2, 3],  # not an object
        )
        await until(lambda: len(ticks.items) == 2)
        millis = int(NOW.timestamp()) * 1000 + 123
        assert ticks.items[0] == {"id": "AAPL", "price": 348.0, "time": millis, "market_hours": 1}
        assert ticks.items[1]["id"] == "BRK-B" and ticks.items[1]["market_hours"] == 0
        assert len(ticks.items) == 2
        for tick in ticks.items:  # the hub's own normalizer accepts them
            assert normalize_message(tick) is not None
        await source.close()
        await asyncio.wait_for(task, 2)
        assert conn.closed

    asyncio.run(scenario())


def test_a_trade_without_nanoseconds_takes_its_time_from_the_date() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        row = trade("aapl", 5.0)["data"]
        row[2] = None
        row[1] = "2026-10-27T15:59:58-04:00"
        net.conns[0].feed({"messageType": "A", "data": row})
        await until(lambda: len(ticks.items) == 1)
        assert ticks.items[0]["time"] == int(
            datetime(2026, 10, 27, 19, 59, 58, tzinfo=UTC).timestamp() * 1000
        )
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_listen_stays_unconnected_until_a_stock_is_subscribed() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        task = asyncio.create_task(source.listen(Ticks()))
        await asyncio.sleep(0.02)
        assert net.conns == []
        await source.subscribe(["BTC-USD"])  # crypto does not open the stock stream
        await asyncio.sleep(0.02)
        assert net.conns == []
        await source.subscribe(["AAPL"])
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        assert net.conns[0].sent_json() == [subscribe_frame("aapl")]
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_subscription_changes_resend_the_whole_list_with_the_subscription_id() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        conn = net.conns[0]
        await handshake(conn)
        await until(lambda: source._sub_id == 4242)
        await source.subscribe(["BRK-B", "AAPL"])
        await until(lambda: subscribes(conn, 2))
        assert conn.sent_json()[-1] == subscribe_frame("aapl", "brk-b", sub_id=4242)
        await source.subscribe(["AAPL"])  # nothing new: nothing sent
        await source.unsubscribe(["AAPL"])
        await until(lambda: subscribes(conn, 3))
        assert conn.sent_json()[-1] == subscribe_frame("brk-b", sub_id=4242)
        # A server that kept streaming the dropped ticker is filtered on our side.
        conn.feed(trade("aapl", 1.0), trade("brk-b", 2.0))
        await until(lambda: len(ticks.items) == 1)
        assert ticks.items[0]["id"] == "BRK-B"
        await source.unsubscribe(["ZZZ"])  # unknown: nothing happens
        assert len(conn.sent) == 3
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_unsubscribing_everything_hangs_up_and_a_new_symbol_reconnects() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        await source.unsubscribe(["AAPL"])
        await until(lambda: net.conns[0].closed)
        await asyncio.sleep(0.02)
        assert len(net.conns) == 1 and not task.done()  # idle, not reconnecting
        await source.subscribe(["BRK-B"])
        await until(lambda: len(net.conns) == 2)
        await until(lambda: subscribes(net.conns[1]))
        assert net.conns[1].sent_json() == [subscribe_frame("brk-b")]  # no stale subscription id
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


@pytest.mark.parametrize("code", [401, 403])
def test_a_rejected_key_ends_listen_with_a_provider_error(code: int) -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await until(lambda: subscribes(net.conns[0]))
        net.conns[0].feed(
            {"messageType": "E", "response": {"code": code, "message": "Not authorized"}}
        )
        with pytest.raises(ProviderError, match="TIINGO_API_KEY") as info:
            await asyncio.wait_for(task, 2)
        assert KEY not in str(info.value) and "Not authorized" in str(info.value)
        assert net.conns[0].closed and len(net.conns) == 1  # no reconnect storm
        await source.close()  # the hub's `close` after a failed `listen`

    asyncio.run(scenario())


def test_an_unreachable_stream_ends_listen_after_max_failures() -> None:
    async def scenario() -> None:
        net = FakeNet(*[OSError("down") for _ in range(10)])
        source = live(net, max_failures=3)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        with pytest.raises(ProviderError, match="3 failed connections"):
            await asyncio.wait_for(task, 2)
        assert len(net.calls) == 3
        await source.close()  # the hub's `close` after a failed `listen`

    asyncio.run(scenario())


def test_a_non_positive_trade_price_is_ignored() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        net.conns[0].feed(trade("aapl", 0.0), trade("aapl", -2.0), trade("aapl", 7.0))
        await until(lambda: len(ticks.items) == 1)
        assert ticks.items[0]["price"] == 7.0
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_other_stream_errors_are_logged_and_the_stream_goes_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        net.conns[0].feed(
            {"messageType": "E", "response": {"code": 400, "message": "bad threshold"}},
            trade("aapl", 7.0),
        )
        await until(lambda: len(ticks.items) == 1)
        await source.close()
        await asyncio.wait_for(task, 2)

    with caplog.at_level(logging.WARNING):
        asyncio.run(scenario())
    assert "400" in caplog.text and "bad threshold" in caplog.text


def test_a_lost_connection_is_reestablished_and_resubscribed_from_scratch() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL", "BRK-B"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        first = net.conns[0]
        await handshake(first)
        await until(lambda: source._sub_id == 4242)
        first.drop()
        await until(lambda: len(net.conns) == 2)
        second = net.conns[1]
        await until(lambda: subscribes(second))
        # The whole subscription again, without the dead connection's subscription id.
        assert second.sent_json() == [subscribe_frame("aapl", "brk-b")]
        second.feed(trade("aapl", 9.0))
        await until(lambda: len(ticks.items) == 1)
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_close_is_idempotent_and_the_source_is_reusable_like_the_hub_does() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.close()  # before anything
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        await source.close()
        await source.close()
        await asyncio.wait_for(task, 2)
        # The hub subscribes again before the next `listen`; nothing of the old state remains.
        await source.subscribe(["BRK-B"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 2)
        second = net.conns[1]
        await until(lambda: subscribes(second))
        assert second.sent_json() == [subscribe_frame("brk-b")]
        second.feed(trade("aapl", 1.0), trade("brk-b", 2.0))
        await until(lambda: len(ticks.items) == 1)
        assert ticks.items[0]["id"] == "BRK-B"  # AAPL was forgotten
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_cancelling_listen_closes_the_connection() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(c.closed for c in net.conns)

    asyncio.run(scenario())


def test_the_live_source_never_logs_the_key(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        net = FakeNet(OSError("refused"))
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        net.conns[0].feed(
            {"messageType": "E", "response": {"code": 400, "message": "invalid syntax"}},
            b"not json",
        )
        await asyncio.sleep(0.02)
        await source.close()
        await asyncio.wait_for(task, 2)

    with caplog.at_level(logging.DEBUG):
        asyncio.run(scenario())
    assert KEY not in caplog.text
