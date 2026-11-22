"""Alpaca provider over hand-built responses (`alpaca_fake.FakeAlpaca`): plans, symbol mapping,
bars (paging, adjustment, sessions, synthesized intervals), quotes, assets search, errors,
request accounting, the registry entry and the live source over a fake WebSocket network. No
network."""

import asyncio
import logging
import types
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from alpaca_fake import Answer, FakeAlpaca, body_of, error
from pydantic import SecretStr, ValidationError
from ws_fake import FakeConn, FakeNet, until

from tickerglass_api.live import normalize_message
from tickerglass_api.metrics import upstream
from tickerglass_api.providers import alpaca
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
    usage_reporting,
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

KEY_ID = "PKTESTKEYID0123456789"
SECRET = "alpaca-test-secret-0123456789abcdef"
NY = ZoneInfo("America/New_York")
# 15:59:59 New York on Tuesday 2026-10-27.
NOW = datetime(2026, 10, 27, 19, 59, 59, tzinfo=UTC)
SPEC = PROVIDERS["alpaca"]
WINDOW = (datetime(2026, 10, 26, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))
DAYS = (datetime(2026, 10, 20, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("ALPACA_"):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


def config(**kwargs: Any) -> alpaca.AlpacaConfig:
    return alpaca.AlpacaConfig(
        key_id=SecretStr(KEY_ID),
        secret_key=SecretStr(SECRET),
        _env_file=None,  # type: ignore[call-arg]
        **kwargs,
    )


def make(
    fake: FakeAlpaca | None = None, now: datetime = NOW, **kwargs: Any
) -> tuple[alpaca.AlpacaProvider, FakeAlpaca]:
    max_pages = kwargs.pop("max_pages", None)
    fake = fake or FakeAlpaca()
    provider = alpaca.AlpacaProvider(
        config(**kwargs), send=fake, clock=lambda: now, max_pages=max_pages
    )
    return provider, fake


class Meter:
    """Collects the requests a call charges beyond the guard's own (`charge_upstream`)."""

    def __init__(self, refuse_after: int | None = None) -> None:
        self.charges: list[int] = []
        self._refuse_after = refuse_after

    def __call__(self, n: int) -> None:
        if self._refuse_after is not None and sum(self.charges) + n > self._refuse_after:
            raise RateLimited("out of budget", 1)
        self.charges.append(n)

    @property
    def total(self) -> int:
        return sum(self.charges)


# -- plans and configuration -------------------------------------------------------------


def test_plan_table() -> None:
    basic, algo = alpaca.PLAN_PROFILES["basic"], alpaca.PLAN_PROFILES["algo_trader_plus"]
    assert (basic.calls_per_min, basic.burst, basic.sip, basic.stream_symbols) == (
        200,
        50,
        False,
        30,
    )
    assert (algo.calls_per_min, algo.sip, algo.stream_symbols) == (10_000, True, None)


def test_capabilities_state_what_alpaca_serves() -> None:
    caps = alpaca.capabilities_for(None)
    assert caps.intervals == {
        "1m",
        "2m",
        "5m",
        "15m",
        "30m",
        "60m",
        "90m",
        "1d",
        "1wk",
        "1mo",
        "3mo",
    }
    assert caps.markets == {"us", "crypto"}
    assert caps.streaming and caps.search and caps.adjusted_close
    assert not caps.extended_quotes and not caps.news and not caps.events
    assert not caps.fundamentals_info and not caps.fundamentals_statements
    assert caps.extended_history
    assert not alpaca.capabilities_for(config(extended_hours=False)).extended_history


def test_costs_and_setting_defaults_follow_the_plan() -> None:
    costs = alpaca.costs_for(None)
    assert (costs.history, costs.symbol_info, costs.search) == (1, 0, 0)
    assert costs.quotes(100) == 1 and costs.quotes(101) == 2
    basic = alpaca.setting_defaults_for(config())
    assert (basic["upstream_rate_per_min"], basic["upstream_burst"]) == (200.0, 50)
    assert "upstream_daily_limit" not in basic
    algo = alpaca.setting_defaults_for(config(plan="algo_trader_plus"))
    assert (algo["upstream_rate_per_min"], algo["upstream_burst"]) == (10_000.0, 500)
    assert alpaca.setting_defaults_for(None) == basic
    assert alpaca.plan_of(config(plan="algo_trader_plus")) == "algo_trader_plus"
    assert alpaca.plan_of(None) == "basic"


def test_basic_plan_always_asks_for_the_iex_feed(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="tickerglass_api.providers.alpaca"):
        provider, fake = make(feed="sip")
    assert "ALPACA_FEED=sip" in caplog.text
    provider.history("AAPL", "1m", *WINDOW, False)
    assert fake.calls[0][1]["feed"] == "iex"


def test_algo_plan_defaults_to_sip_and_honours_an_explicit_feed() -> None:
    provider, fake = make(plan="algo_trader_plus")
    provider.history("AAPL", "1m", *WINDOW, False)
    assert fake.calls[0][1]["feed"] == "sip"
    provider, fake = make(plan="algo_trader_plus", feed="iex")
    provider.history("AAPL", "1m", *WINDOW, False)
    assert fake.calls[0][1]["feed"] == "iex"


def test_registry_entry_and_config_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    assert SPEC.config is alpaca.AlpacaConfig and SPEC.self_paging and SPEC.network
    assert SPEC.make_live is not None and SPEC.probe_symbol == "AAPL"
    assert SPEC.terms is not None and "ALPACA_KEY_ID" in SPEC.terms
    assert missing_config(SPEC) == ["ALPACA_KEY_ID", "ALPACA_SECRET_KEY"]
    with pytest.raises(ProviderNotConfigured, match="ALPACA_KEY_ID, ALPACA_SECRET_KEY"):
        load_config(SPEC)
    monkeypatch.setenv("ALPACA_KEY_ID", KEY_ID)
    monkeypatch.setenv("ALPACA_SECRET_KEY", SECRET)
    loaded = load_config(SPEC)
    assert isinstance(loaded, alpaca.AlpacaConfig) and loaded.plan == "basic"
    fields = {f.name: f for f in config_fields(SPEC, loaded)}
    assert fields["key_id"].secret and fields["secret_key"].secret
    assert fields["key_id"].value is None and fields["secret_key"].value is None
    assert fields["key_id"].required and fields["secret_key"].required
    assert fields["plan"].value == "basic" and not fields["plan"].secret
    assert fields["feed"].value is None
    assert fields["data_base_url"].value == "https://data.alpaca.markets"
    assert fields["crypto_location"].env == "ALPACA_CRYPTO_LOCATION"
    assert SPEC.capabilities(loaded) == alpaca.capabilities_for(loaded)
    assert SPEC.plan(loaded) == "basic"
    # The budget follows the plan unless the user set one.
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name)  # conftest's permissive guard
    defaults = apply_setting_defaults(SPEC, Settings(_env_file=None), loaded)  # type: ignore[call-arg]
    assert (defaults.upstream_rate_per_min, defaults.upstream_burst) == (200.0, 50)
    pinned = apply_setting_defaults(
        SPEC,
        Settings(upstream_rate_per_min=7, _env_file=None),  # type: ignore[call-arg]
        loaded,
    )
    assert pinned.upstream_rate_per_min == 7
    made = SPEC.make(defaults, loaded)
    assert isinstance(made, alpaca.AlpacaProvider)
    assert isinstance(SPEC.make_live(made, loaded), alpaca.AlpacaLiveSource)  # type: ignore[misc]


@pytest.mark.parametrize("field", ["data_base_url", "trading_base_url"])
def test_base_urls_must_be_https_unless_they_are_local(field: str) -> None:
    # The key pair rides in the request headers: plain http to a remote host is refused.
    for bad in ("http://data.example.com", "ftp://x.example", "data.example.com", ""):
        with pytest.raises(ValidationError, match=f"ALPACA_{field.upper()}"):
            config(**{field: bad})
    assert getattr(config(**{field: "https://proxy.example.com/alpaca"}), field)
    assert getattr(config(**{field: "http://127.0.0.1:9999"}), field)
    assert getattr(config(**{field: "http://localhost:9999"}), field)


def test_a_trade_or_snapshot_price_that_is_not_positive_is_ignored() -> None:
    snap = {"latestTrade": {"p": 0.0, "t": "2026-10-27T19:59:58Z"}, "dailyBar": {"c": 0.0}}
    assert alpaca._snapshot_row("AAPL", snap, False, NOW) is None
    # A zero trade falls back to the daily bar's close.
    snap["dailyBar"] = {"c": 12.5, "t": "2026-10-27T04:00:00Z"}
    row = alpaca._snapshot_row("AAPL", snap, False, NOW)
    assert row is not None and row["last"] == 12.5


# -- symbols -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("canonical", "mapped"),
    [
        ("AAPL", ("AAPL", False)),
        ("aapl", ("AAPL", False)),
        ("BRK-B", ("BRK.B", False)),
        ("BF-B", ("BF.B", False)),
        ("BRK.B", ("BRK.B", False)),
        ("BTC-USD", ("BTC/USD", True)),
        ("ETH-USDT", ("ETH/USDT", True)),
        ("ETH-BTC", ("ETH/BTC", True)),
    ],
)
def test_to_provider_maps_canonical_symbols(canonical: str, mapped: tuple[str, bool]) -> None:
    result = alpaca.to_provider(canonical)
    assert result is not None and (result.symbol, result.crypto) == mapped
    assert result.timezone == ("UTC" if mapped[1] else "America/New_York")


@pytest.mark.parametrize(
    "unsupported",
    [
        "^GSPC",
        "EURUSD=X",
        "JPY=X",
        "ES=F",
        "VOD.L",
        "SAP.DE",
        "BTC-EUR",
        "",
        "TOOLONGSYMBOL",
        "A B",
    ],
)
def test_to_provider_refuses_what_alpaca_does_not_serve(unsupported: str) -> None:
    assert alpaca.to_provider(unsupported) is None


def test_from_provider_is_the_inverse() -> None:
    assert alpaca.from_provider("BRK.B") == "BRK-B"
    assert alpaca.from_provider("btc/usd") == "BTC-USD"
    assert alpaca.from_provider("ETH/EUR") is None
    assert alpaca.from_provider("AAPL") == "AAPL"
    for canonical in ("BRK-B", "BTC-USD", "AAPL"):
        mapped = alpaca.to_provider(canonical)
        assert mapped is not None and alpaca.from_provider(mapped.symbol) == canonical


def test_symbol_routing_answers_unsupported_symbols_locally() -> None:
    provider, fake = make()
    routing = as_symbol_routing(provider)
    assert routing is not None
    symbols = ["AAPL", "aapl", "^GSPC", "VOD.L", "EURUSD=X", "BTC-USD", "ES=F"]
    assert routing.billable(symbols) == ["AAPL", "BTC-USD"]
    assert routing.answers_locally("history", "^GSPC") and routing.answers_locally(
        "quotes", "VOD.L"
    )
    assert not routing.answers_locally("history", "AAPL")
    assert routing.answers_locally("events", "AAPL") and routing.answers_locally(
        "fundamentals", "AAPL"
    )
    for call in (
        lambda: provider.history("^GSPC", "1d", *DAYS, False),
        lambda: provider.symbol_info("VOD.L"),
        lambda: provider.quotes(["EURUSD=X", "ES=F"]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()
    assert fake.calls == []  # never asked


# -- history -----------------------------------------------------------------------------


def test_history_frame_and_request_shape() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1m", *WINDOW, False)
    assert list(df.columns) == BAR_COLUMNS
    path, params, headers = fake.calls[0]
    assert path == "/v2/stocks/bars"
    assert params["symbols"] == "AAPL" and params["timeframe"] == "1Min"
    assert params["feed"] == "iex" and params["limit"] == "10000" and params["sort"] == "desc"
    assert params["start"] == "2026-10-26T00:00:00Z" and params["end"] == "2026-10-28T00:00:00Z"
    assert "adjustment" not in params  # intraday bars are raw
    assert headers["APCA-API-KEY-ID"] == KEY_ID and headers["APCA-API-SECRET-KEY"] == SECRET
    assert df["ts"].is_monotonic_increasing and df["ts"].dtype == "int64"
    assert (df["adj_close"] == df["close"]).all()
    assert fake.paths() == ["/v2/stocks/bars"]


@pytest.mark.parametrize(
    ("interval", "timeframe"),
    [
        ("1m", "1Min"),
        ("2m", "2Min"),
        ("5m", "5Min"),
        ("15m", "15Min"),
        ("30m", "30Min"),
        ("60m", "30Min"),  # a stock without pre/post-market: built from 30-minute bars
        ("90m", "30Min"),  # built from 30-minute bars
        ("1d", "1Day"),
        ("1wk", "1Week"),
        ("1mo", "1Month"),
        ("3mo", "3Month"),
    ],
)
def test_intervals_map_to_alpaca_timeframes(interval: str, timeframe: str) -> None:
    provider, fake = make()
    start = datetime(2025, 12, 1, tzinfo=UTC)
    end = datetime(2026, 11, 1, tzinfo=UTC)
    provider.history("AAPL", interval, start, end, False)
    assert fake.calls[0][1]["timeframe"] == timeframe


def test_an_unserved_interval_is_unsupported() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported, match="5d bars"):
        provider.history("AAPL", "5d", *DAYS, False)
    assert fake.calls == []


def test_regular_session_filter_and_prepost() -> None:
    provider, _ = make()
    regular = provider.history("AAPL", "1m", *WINDOW, False)
    full = provider.history("AAPL", "1m", *WINDOW, True)
    assert len(full) == 10 and len(regular) == 8
    local = pd.to_datetime(regular["ts"], unit="s", utc=True).dt.tz_convert(NY)
    minutes = local.dt.hour * 60 + local.dt.minute
    assert minutes.min() == 9 * 60 + 30 and minutes.max() == 15 * 60 + 59
    # Pre/post-market bars are requested only when the app has them enabled.
    provider, _ = make(extended_hours=False)
    assert len(provider.history("AAPL", "1m", *WINDOW, True)) == 8


def test_an_hourly_bar_counts_when_it_overlaps_the_session() -> None:
    frame = pd.DataFrame(
        {
            "ts": [
                int(datetime(2026, 10, 27, h, 0, tzinfo=NY).timestamp()) for h in (8, 9, 10, 15, 16)
            ],
            "open": 1.0,
            "high": 1.0,
            "low": 1.0,
            "close": 1.0,
            "adj_close": 1.0,
            "volume": 1.0,
        }
    )
    kept = alpaca._regular_hours(frame, 60)
    local = pd.to_datetime(kept["ts"], unit="s", utc=True).dt.tz_convert(NY).dt.hour.tolist()
    assert local == [9, 10, 15]  # the 09:00 bar holds 09:30-10:00; 08:00 and 16:00 do not


def test_daily_bars_are_stamped_at_new_york_midnight_with_yahoo_adjustment_semantics() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1d", *DAYS, False)
    assert len(df) == 6
    last = df.iloc[-1]
    assert datetime.fromtimestamp(int(last["ts"]), NY) == datetime(2026, 10, 27, tzinfo=NY)
    # `close` is split-adjusted only, `adj_close` also dividend-adjusted (second request).
    assert last["close"] == 347.25 and last["adj_close"] == pytest.approx(347.25 * 0.99, abs=1e-3)
    adjustments = [params.get("adjustment") for _, params, _ in fake.calls]
    assert adjustments == ["split", "all"]
    # Days before the window are asked for too (the bar of the start day itself).
    assert fake.calls[0][1]["start"] == "2026-10-19T00:00:00Z"


def test_adj_close_falls_back_to_close_when_the_adjusted_pass_fails(
    caplog: pytest.LogCaptureFixture,
) -> None:
    provider, fake = make()
    plain = fake.route

    def route(path: str, params: dict[str, str]) -> Answer:
        if params.get("adjustment") == "all":
            return 502, {}, {"message": "bad gateway"}
        return plain(path, params)

    fake.route = route  # type: ignore[method-assign]
    with caplog.at_level(logging.WARNING, logger="tickerglass_api.providers.alpaca"):
        df = provider.history("AAPL", "1d", *DAYS, False)
    assert len(df) == 6 and (df["adj_close"] == df["close"]).all()
    assert "adjusted prices unavailable" in caplog.text


def test_an_auth_failure_in_the_adjusted_pass_still_surfaces() -> None:
    provider, fake = make()
    plain = fake.route

    def route(path: str, params: dict[str, str]) -> Answer:
        if params.get("adjustment") == "all":
            return error(401, "error_401")
        return plain(path, params)

    fake.route = route  # type: ignore[method-assign]
    with pytest.raises(ProviderNotConfigured):
        provider.history("AAPL", "1d", *DAYS, False)


def test_weekly_monthly_and_quarterly_bars() -> None:
    provider, _ = make()
    weekly = provider.history("AAPL", "1wk", datetime(2026, 9, 20, tzinfo=UTC), DAYS[1], False)
    assert len(weekly) == 6
    assert datetime.fromtimestamp(int(weekly["ts"].iloc[0]), NY) == datetime(2026, 9, 21, tzinfo=NY)
    wide = (datetime(2025, 12, 1, tzinfo=UTC), datetime(2026, 11, 1, tzinfo=UTC))
    monthly = provider.history("AAPL", "1mo", *wide, False)
    assert len(monthly) == 10
    # January is stamped New York midnight in winter time (05:00Z), July in summer time.
    assert datetime.fromtimestamp(int(monthly["ts"].iloc[0]), UTC) == datetime(
        2026, 1, 1, 5, tzinfo=UTC
    )
    assert datetime.fromtimestamp(int(monthly["ts"].iloc[6]), UTC) == datetime(
        2026, 7, 1, 4, tzinfo=UTC
    )
    assert len(provider.history("AAPL", "3mo", *wide, False)) == 4


def test_90_minute_bars_are_built_from_30_minute_bars_by_session() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "90m", *WINDOW, False)
    assert fake.calls[0][1]["timeframe"] == "30Min"
    # Session-anchored buckets: 09:30 and 19:30 (the 15:59 bar) on the 26th, 09:30 on the 27th.
    assert len(df) == 3
    first = df.iloc[0]
    assert first["open"] == 343.0 and first["high"] == 344.6 and first["low"] == 342.9
    assert first["close"] == 343.8 and first["volume"] == 156000
    # A mid-session start still sees the session's first bar: the request starts at local midnight.
    assert fake.calls[0][1]["start"] == "2026-10-25T04:00:00Z"


def test_stock_60_minute_bars_are_session_anchored_unless_extended_hours_are_asked_for() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "60m", *WINDOW, False)
    # Native 1Hour bars are clock-aligned: the 09:00 one would hold pre-market trades. The
    # 30-minute build opens at 09:30 like Yahoo's 60m bars.
    assert fake.calls[0][1]["timeframe"] == "30Min"
    assert len(df) == 3
    first = df.iloc[0]
    assert datetime.fromtimestamp(int(first["ts"]), NY) == datetime(2026, 10, 26, 9, 30, tzinfo=NY)
    assert first["open"] == 343.0 and first["volume"] == 156000
    assert (df["ts"] != int(datetime(2026, 10, 26, 12, tzinfo=UTC).timestamp())).all()
    # With pre/post-market (and the app allowing it) the native hourly bars are used.
    fake.calls.clear()
    full = provider.history("AAPL", "60m", *WINDOW, True)
    assert fake.calls[0][1]["timeframe"] == "1Hour" and len(full) == 10
    # The app disallowing extended hours wins over the request.
    off, off_fake = make(extended_hours=False)
    off.history("AAPL", "60m", *WINDOW, True)
    assert off_fake.calls[0][1]["timeframe"] == "30Min"
    # Crypto trades round the clock: native hourly bars whatever the flag.
    fake.calls.clear()
    provider.history("BTC-USD", "60m", *WINDOW, False)
    assert fake.calls[0][1]["timeframe"] == "1Hour"


def test_bars_with_a_non_positive_price_are_dropped() -> None:
    provider, fake = make()
    rows = list(body_of("bars_1min_aapl")["bars"]["AAPL"])
    rows[1] = {**rows[1], "l": 0.0}
    rows[2] = {**rows[2], "c": -1.0}
    fake.answers["/v2/stocks/bars"] = lambda params: (200, {}, {"bars": {"AAPL": rows}})
    df = provider.history("AAPL", "1m", *WINDOW, True)
    assert len(df) == len(rows) - 2 and (df[["open", "high", "low", "close"]] > 0).all().all()


def test_class_share_symbols_and_crypto_use_alpaca_names_and_endpoints() -> None:
    provider, fake = make()
    provider.history("BRK-B", "1m", *WINDOW, False)
    assert fake.calls[0][1]["symbols"] == "BRK.B"
    fake.calls.clear()
    df = provider.history("BTC-USD", "1m", *WINDOW, False)
    path, params, _ = fake.calls[0]
    assert path == "/v1beta3/crypto/us/bars" and params["symbols"] == "BTC/USD"
    assert "feed" not in params and "adjustment" not in params
    assert len(df) == 10  # no session filter around the clock
    fake.calls.clear()
    daily = provider.history("BTC-USD", "1d", *DAYS, False)
    assert len(fake.calls) == 1  # no adjustment pass for crypto
    # Daily crypto bars sit at UTC midnight.
    assert datetime.fromtimestamp(int(daily["ts"].iloc[-1]), UTC) == datetime(
        2026, 10, 27, tzinfo=UTC
    )
    provider2, fake2 = make(crypto_location="eu-1")
    fake2.answers["/v1beta3/crypto/eu-1/bars"] = lambda params: (200, {}, {"bars": {}})
    provider2.history("BTC-USD", "1m", *WINDOW, False)
    assert fake2.paths()[0] == "/v1beta3/crypto/eu-1/bars"


def test_no_start_asks_from_the_earliest_date_not_the_apis_start_of_day() -> None:
    provider, fake = make()
    provider.history("AAPL", "1d", None, DAYS[1], False)
    assert fake.calls[0][1]["start"] == "2016-01-01T00:00:00Z"
    provider.history("AAPL", "1m", WINDOW[0], None, False)
    assert "end" not in fake.calls[2][1]


def _paged(
    fake: FakeAlpaca, pages: dict[str | None, tuple[list[dict[str, Any]], str | None]]
) -> None:
    def answer(params: dict[str, str]) -> Answer:
        rows, token = pages[params.get("page_token")]
        return 200, {}, {"bars": {params["symbols"]: rows}, "next_page_token": token}

    fake.answers["/v2/stocks/bars"] = answer


def _minute_rows(*minutes: int) -> list[dict[str, Any]]:
    """Newest-first one-minute bars of 2026-10-27 13:xx Z."""
    return [
        {"t": f"2026-10-27T13:{m:02d}:00Z", "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 10}
        for m in sorted(minutes, reverse=True)
    ]


def test_pages_are_followed_newest_first_and_each_further_page_is_charged() -> None:
    provider, fake = make()
    _paged(
        fake,
        {
            None: (_minute_rows(34, 33), "p2"),
            "p2": (_minute_rows(32, 31), "p3"),
            "p3": (_minute_rows(30), None),
        },
    )
    meter = Meter()
    with metering(meter):
        df = provider.history("AAPL", "1m", *WINDOW, False)
    assert len(df) == 5 and df["ts"].is_monotonic_increasing
    assert [p.get("page_token") for _, p, _ in fake.calls] == [None, "p2", "p3"]
    assert meter.charges == [1, 1]  # the guard paid for the first request


def test_a_page_limit_keeps_the_newest_bars() -> None:
    provider, fake = make(max_pages=2)
    _paged(
        fake,
        {
            None: (_minute_rows(34, 33), "p2"),
            "p2": (_minute_rows(32, 31), "p3"),
            "p3": (_minute_rows(30), None),
        },
    )
    df = provider.history("AAPL", "1m", *WINDOW, False)
    assert len(fake.calls) == 2 and len(df) == 4
    assert datetime.fromtimestamp(int(df["ts"].iloc[-1]), UTC).minute == 34  # newest kept


def test_a_refused_page_charge_serves_what_was_fetched() -> None:
    provider, fake = make()
    _paged(
        fake,
        {None: (_minute_rows(34, 33), "p2"), "p2": (_minute_rows(32), None)},
    )
    with metering(Meter(refuse_after=0)):
        df = provider.history("AAPL", "1m", *WINDOW, False)
    assert len(fake.calls) == 1 and len(df) == 2


def test_unknown_symbol_is_found_out_by_the_assets_list_only_when_no_bars_came() -> None:
    provider, fake = make()
    with pytest.raises(SymbolNotFound):
        provider.history("ZZZZ", "1d", *DAYS, False)
    assert "/v2/assets" in fake.paths()
    # A known symbol with no bars in the range is an empty frame, not an error.
    far = datetime(2027, 1, 1, tzinfo=UTC)
    empty = provider.history("AAPL", "1d", far, far.replace(month=2), False)
    assert empty.empty and list(empty.columns) == BAR_COLUMNS


def test_an_unavailable_assets_list_does_not_turn_empty_bars_into_an_error() -> None:
    provider, fake = make()
    fake.answers["/v2/assets"] = lambda params: error(401, "error_401")
    assert provider.history("ZZZZ", "1d", *DAYS, False).empty


# -- errors and accounting ---------------------------------------------------------------


def failing(status: int, name: str | None = None, **head: str) -> FakeAlpaca:
    fake = FakeAlpaca()
    fake.answers["/v2/stocks/bars"] = lambda params: (
        error(status, name) if name else (status, dict(head), {"message": "boom"})
    )
    return fake


def test_rejected_keys_name_the_settings_and_never_leak_them() -> None:
    provider, _ = make(failing(401, "error_401"))
    with pytest.raises(ProviderNotConfigured, match="ALPACA_KEY_ID / ALPACA_SECRET_KEY") as info:
        provider.history("AAPL", "1m", *WINDOW, False)
    assert KEY_ID not in str(info.value) and SECRET not in str(info.value)
    provider, _ = make(failing(403, "error_401"))  # a plain 403 is a rejected key too
    with pytest.raises(ProviderNotConfigured):
        provider.history("AAPL", "1m", *WINDOW, False)


def test_a_plan_gated_feed_is_unsupported() -> None:
    provider, _ = make(failing(403, "error_403_sip"))
    with pytest.raises(ProviderUnsupported, match="SIP"):
        provider.history("AAPL", "1m", *WINDOW, False)


def test_rate_limits_and_outages_map_to_the_provider_errors() -> None:
    provider, _ = make(failing(429, **{"retry-after": "7"}))
    with pytest.raises(RateLimited) as limited:
        provider.history("AAPL", "1m", *WINDOW, False)
    assert limited.value.retry_after == 7 and not limited.value.daily
    provider, _ = make(failing(503))
    with pytest.raises(UpstreamUnavailable):
        provider.history("AAPL", "1m", *WINDOW, False)

    def down(url: str, headers: Mapping[str, str], timeout: float) -> Any:
        raise ConnectionResetError("reset")

    provider = alpaca.AlpacaProvider(config(), send=down)
    with pytest.raises(UpstreamUnavailable):
        provider.history("AAPL", "1m", *WINDOW, False)


def test_other_errors_are_provider_errors_with_the_upstream_message() -> None:
    provider, _ = make(failing(422))
    with pytest.raises(ProviderError, match="boom"):
        provider.history("AAPL", "1m", *WINDOW, False)


def test_rate_limit_headers_are_reported_to_the_guard() -> None:
    reports: list[dict[str, int | None]] = []

    def handler(**kwargs: int | None) -> None:
        reports.append(kwargs)

    provider, _ = make(FakeAlpaca(limit=(200, 150)))
    with usage_reporting(handler):  # type: ignore[arg-type]
        provider.history("AAPL", "1m", *WINDOW, False)
    assert reports == [
        {"minute_used": 50, "minute_left": 150, "daily_used": None, "daily_limit": None}
    ]
    # Absent or malformed headers report nothing.
    reports.clear()
    provider, _ = make(FakeAlpaca())
    with usage_reporting(handler):  # type: ignore[arg-type]
        provider.history("AAPL", "1m", *WINDOW, False)
    assert reports == []


def test_every_request_counts_in_the_upstream_metrics() -> None:
    before = upstream.snapshot().get(("alpaca", "ok"), 0)
    provider, fake = make()
    provider.history("AAPL", "1d", *DAYS, False)  # two requests: split and all
    provider.search("AAPL", 3)  # two assets lists
    after = upstream.snapshot().get(("alpaca", "ok"), 0)
    assert after - before == len(fake.calls) == 4
    rate_before = upstream.snapshot().get(("alpaca", "rate_limited"), 0)
    with pytest.raises(RateLimited):
        make(failing(429))[0].history("AAPL", "1m", *WINDOW, False)
    assert upstream.snapshot().get(("alpaca", "rate_limited"), 0) == rate_before + 1


def test_guarded_provider_refuses_unsupported_things_without_a_request() -> None:
    provider, fake = make()
    guarded = GuardedProvider(
        provider,
        UpstreamGuard(),
        costs=alpaca.costs_for(None),
        capabilities=alpaca.capabilities_for(None),
    )
    for call in (
        lambda: guarded.history("AAPL", "5d", *DAYS, False),
        lambda: guarded.events("AAPL"),
        lambda: guarded.fundamentals("AAPL"),
        lambda: guarded.news("AAPL", 3),
        lambda: guarded.extended_quotes(["AAPL"]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()
    assert fake.calls == []
    assert len(guarded.history("AAPL", "1m", *WINDOW, False)) == 8


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


# -- quotes ------------------------------------------------------------------------------


def test_quote_rows_from_a_snapshot() -> None:
    provider, fake = make()
    rows = provider.quotes(["AAPL", "BRK-B", "ZZZZ"])
    assert [r["symbol"] for r in rows] == ["AAPL", "BRK-B"]  # unknown symbols are omitted
    path, params, _ = fake.calls[0]
    assert path == "/v2/stocks/snapshots" and params == {
        "symbols": "AAPL,BRK.B,ZZZZ",
        "feed": "iex",
    }
    aapl = rows[0]
    assert aapl["last"] == 347.25 and aapl["prevClose"] == 343.91
    assert aapl["change"] == pytest.approx(3.34) and aapl["changePercent"] == pytest.approx(
        0.97118, abs=1e-4
    )
    assert aapl["volume"] == 391880 and aapl["currency"] == "USD"
    assert (aapl["open"], aapl["dayHigh"], aapl["dayLow"]) == (343.165, 347.77, 342.4)
    assert aapl["time"] == int(datetime(2026, 10, 27, 19, 59, 58, tzinfo=UTC).timestamp())
    assert aapl["marketState"] == "REGULAR"
    assert isinstance(rows, QuoteList) and not rows.confirmed  # Alpaca never says "unknown"


@pytest.mark.parametrize(
    ("clock", "state"),
    [
        (datetime(2026, 10, 27, 19, 59, 59, tzinfo=UTC), "REGULAR"),
        (datetime(2026, 10, 27, 21, 0, tzinfo=UTC), "POST"),  # 17:00 New York
        (datetime(2026, 10, 27, 12, 0, tzinfo=UTC), "PRE"),  # 08:00, a trade of today is known
        (datetime(2026, 10, 27, 5, 0, tzinfo=UTC), "CLOSED"),  # 01:00, before pre-market
        (datetime(2026, 10, 28, 15, 0, tzinfo=UTC), "CLOSED"),  # the last trade is yesterday's
    ],
)
def test_market_state_follows_the_new_york_clock_and_the_last_trade_day(
    clock: datetime, state: str
) -> None:
    provider, _ = make(now=clock)
    assert provider.quotes(["AAPL"])[0]["marketState"] == state


def test_a_pre_market_trade_is_measured_against_the_last_close() -> None:
    provider, fake = make()
    snap = body_of("snapshots_stocks")["AAPL"]
    pre = {**snap, "latestTrade": {**snap["latestTrade"], "t": "2026-10-28T12:00:00Z", "p": 350.0}}
    fake.answers["/v2/stocks/snapshots"] = lambda params: (200, {}, {"AAPL": pre})
    row = provider.quotes(["AAPL"])[0]
    # The daily bar is yesterday's: its close is the previous close, and it is no "today" range.
    assert row["prevClose"] == 347.25 and row["change"] == pytest.approx(2.75)
    assert "dayHigh" not in row and row["volume"] is None


def test_a_snapshot_without_a_trade_falls_back_to_the_daily_close_and_empty_ones_are_skipped() -> (
    None
):
    provider, fake = make()
    snap = body_of("snapshots_stocks")["AAPL"]
    fake.answers["/v2/stocks/snapshots"] = lambda params: (
        200,
        {},
        {"AAPL": {k: v for k, v in snap.items() if k != "latestTrade"}, "BRK.B": {}},
    )
    rows = provider.quotes(["AAPL", "BRK-B"])
    assert [r["symbol"] for r in rows] == ["AAPL"] and rows[0]["last"] == 347.25


def test_a_wrapped_snapshots_answer_is_accepted() -> None:
    provider, fake = make()
    fake.answers["/v2/stocks/snapshots"] = lambda params: (
        200,
        {},
        {"snapshots": {"AAPL": body_of("snapshots_stocks")["AAPL"]}},
    )
    assert [r["symbol"] for r in provider.quotes(["AAPL"])] == ["AAPL"]


def test_crypto_quotes_use_their_own_endpoint_and_charge_the_extra_request() -> None:
    provider, fake = make()
    meter = Meter()
    with metering(meter):
        rows = provider.quotes(["AAPL", "BTC-USD"])
    assert fake.paths() == ["/v2/stocks/snapshots", "/v1beta3/crypto/us/snapshots"]
    assert fake.calls[1][1] == {"symbols": "BTC/USD"}
    btc = rows[1]
    assert btc["symbol"] == "BTC-USD" and btc["last"] == 98000.5 and btc["prevClose"] == 97000.0
    assert btc["currency"] == "USD" and btc["marketState"] == "REGULAR"
    # The guard charged ceil(2 / 100) = 1 request; two were sent.
    assert meter.charges == [1]
    meter = Meter()
    with metering(meter):
        make()[0].quotes(["AAPL"])
    assert meter.charges == []


def test_quotes_are_chunked_and_a_failed_chunk_is_a_partial_answer() -> None:
    provider, fake = make()
    symbols = ["AAPL"] + [f"T{i}" for i in range(149)]
    calls: list[int] = []

    def answer(params: dict[str, str]) -> Answer:
        calls.append(len(params["symbols"].split(",")))
        if len(calls) == 1:
            return 200, {}, {"AAPL": body_of("snapshots_stocks")["AAPL"]}
        return 502, {}, {"message": "bad gateway"}

    fake.answers["/v2/stocks/snapshots"] = answer
    meter = Meter()
    with metering(meter), pytest.raises(PartialQuotes) as partial:
        provider.quotes(symbols)
    assert calls == [100, 50]
    assert [q["symbol"] for q in partial.value.quotes] == ["AAPL"]
    assert partial.value.failed == [f"T{i}" for i in range(99, 149)]
    assert meter.charges == []  # two chunks are what the guard charged for 150 symbols
    # When every chunk fails the error itself is raised.
    fake.answers["/v2/stocks/snapshots"] = lambda params: (502, {}, {"message": "bad gateway"})
    with pytest.raises(UpstreamUnavailable):
        provider.quotes(["AAPL"])


def test_an_invalid_symbol_is_bisected_out_of_a_batch() -> None:
    provider, fake = make()

    def answer(params: dict[str, str]) -> Answer:
        keys = params["symbols"].split(",")
        if "BAD" in keys and len(keys) > 1:
            return error(400, "error_400_symbol")
        if keys == ["BAD"]:
            return error(400, "error_400_symbol")
        entries = body_of("snapshots_stocks")
        return 200, {}, {k: entries[k] for k in keys if k in entries}

    fake.answers["/v2/stocks/snapshots"] = answer
    meter = Meter()
    with metering(meter):
        rows = provider.quotes(["AAPL", "BAD", "BRK-B"])
    assert sorted(r["symbol"] for r in rows) == ["AAPL", "BRK-B"]
    assert meter.total == 4  # [AAPL] [BAD BRK.B] [BAD] [BRK.B] after the failed full batch
    assert len(fake.calls) == 5


def test_quotes_of_nothing_servable_raise_unsupported_without_a_request() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["^GSPC"])
    assert provider.quotes([]) == [] and fake.calls == []
    rows = provider.quotes(["^GSPC", "AAPL"])
    assert [r["symbol"] for r in rows] == ["AAPL"]  # the servable ones are still served


def test_a_rate_limited_quote_request_raises_rate_limited() -> None:
    provider, fake = make()
    fake.answers["/v2/stocks/snapshots"] = lambda params: (429, {}, {"message": "slow down"})
    with pytest.raises(RateLimited):
        provider.quotes(["AAPL"])


# -- assets: symbol info and search ------------------------------------------------------


def test_symbol_info_from_the_assets_list() -> None:
    provider, fake = make()
    info = provider.symbol_info("BRK-B")
    assert info["symbol"] == "BRK-B" and info["name"].startswith("Berkshire Hathaway")
    assert info["exchange"] == "NYSE" and info["type"] == "equity" and info["currency"] == "USD"
    assert info["timezone"] == "America/New_York" and info["session"] == "0930-1600"
    assert info["hasIntraday"] is True
    btc = provider.symbol_info("BTC-USD")
    assert btc["type"] == "cryptocurrency" and btc["timezone"] == "UTC"
    assert btc["session"] == "0000-2359" and btc["currency"] == "USD"
    assert fake.calls[0][1] == {"status": "active", "asset_class": "us_equity"}
    assert fake.calls[1][1] == {"status": "active", "asset_class": "crypto"}
    for missing in ("ZZZZ", "OLD", "ETH-USDC"):  # unknown, inactive, no such pair
        with pytest.raises(SymbolNotFound):
            provider.symbol_info(missing)


def test_search_ranks_exact_then_prefix_then_name_and_covers_crypto() -> None:
    provider, _ = make()
    # Exact symbol first, then the one whose name mentions it.
    assert [r["symbol"] for r in provider.search("AAPL", 5)] == ["AAPL", "AAPD"]
    assert [r["symbol"] for r in provider.search("AAP", 5)] == ["AAPD", "AAPL"]
    assert [r["symbol"] for r in provider.search("apple", 5)] == ["AAPL", "PINE"]
    assert [r["symbol"] for r in provider.search("BRK", 5)] == ["BRK-A", "BRK-B"]
    assert [r["symbol"] for r in provider.search("BRK-B", 5)] == ["BRK-B"]
    assert [r["symbol"] for r in provider.search("BRK.B", 5)] == ["BRK-B"]
    crypto = provider.search("btc", 5)
    assert [r["symbol"] for r in crypto] == ["BTC-USD", "BTC-USDT"]
    assert crypto[0]["type"] == "cryptocurrency" and crypto[0]["typeDisplay"] == "Crypto"
    assert provider.search("AAP", 1) == [provider.search("AAP", 5)[0]]
    assert provider.search("  ", 5) == [] and provider.search("nosuchthing", 5) == []
    row = provider.search("SPY", 5)[0]
    assert row == {
        "symbol": "SPY",
        "name": "SPDR S&P 500 ETF Trust",
        "exchange": "ARCA",
        "type": "equity",
        "typeDisplay": "US equity",
    }


def test_assets_are_cached_for_a_day_and_each_load_is_charged() -> None:
    now = [1000.0]
    provider, fake = make()
    meter = Meter()
    real = alpaca.time
    alpaca.time = types.SimpleNamespace(monotonic=lambda: now[0])  # type: ignore[assignment]
    try:
        with metering(meter):
            provider.search("AAPL", 3)
            provider.symbol_info("AAPL")
            provider.search("BTC", 3)
            assert fake.paths().count("/v2/assets") == 2 and meter.charges == [1, 1]
            now[0] += alpaca.ASSETS_TTL_S - 1
            provider.search("AAPL", 3)
            assert fake.paths().count("/v2/assets") == 2
            now[0] += 2
            provider.search("AAPL", 3)
            assert fake.paths().count("/v2/assets") == 4 and meter.total == 4
    finally:
        alpaca.time = real


def test_search_survives_a_failing_crypto_list_but_not_a_failing_stock_list() -> None:
    provider, fake = make()
    plain = fake.route

    def route(path: str, params: dict[str, str]) -> Answer:
        if path == "/v2/assets" and params["asset_class"] == "crypto":
            return 502, {}, {"message": "down"}
        return plain(path, params)

    fake.route = route  # type: ignore[method-assign]
    assert [r["symbol"] for r in provider.search("AAPL", 3)] == ["AAPL", "AAPD"]
    fake.answers["/v2/assets"] = lambda params: error(401, "error_401")
    fresh, _ = make(fake)
    with pytest.raises(ProviderNotConfigured):
        fresh.search("AAPL", 3)


# -- live --------------------------------------------------------------------------------

STREAM = "wss://stream.test"
CONNECTED = [{"T": "success", "msg": "connected"}]
AUTHENTICATED = [{"T": "success", "msg": "authenticated"}]


def live(net: FakeNet, max_failures: int | None = 6, **kwargs: Any) -> alpaca.AlpacaLiveSource:
    return alpaca.AlpacaLiveSource(
        config(**kwargs),
        stream_url=STREAM,
        connect=net,
        backoff_factory=lambda: Backoff(initial_s=0.001, max_s=0.002, jitter=0),
        max_failures=max_failures,
    )


def has_sent(conn: FakeConn, action: str, n: int = 1) -> bool:
    return sum(1 for m in conn.sent_json() if m.get("action") == action) >= n


async def handshake(conn: FakeConn, subscribes: int = 1) -> None:
    """The server side of a login: `connected`, then `authenticated` once the auth arrived."""
    conn.feed(CONNECTED)
    await until(lambda: has_sent(conn, "auth"))
    conn.feed(AUTHENTICATED)
    if subscribes:
        await until(lambda: has_sent(conn, "subscribe", subscribes))


def trade(symbol: str, price: float, when: str = "2026-10-27T19:59:58.5Z") -> dict[str, Any]:
    return {"T": "t", "S": symbol, "i": 1, "x": "V", "p": price, "s": 100, "c": ["@"], "t": when}


class Ticks:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    async def __call__(self, tick: dict[str, Any]) -> None:
        self.items.append(tick)


def test_live_authenticates_subscribes_and_emits_hub_ticks() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL", "BRK-B", "^GSPC"])  # the index is not streamable
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        assert net.urls() == [f"{STREAM}/v2/iex"]
        conn = net.conns[0]
        await handshake(conn)
        assert conn.sent_json() == [
            {"action": "auth", "key": KEY_ID, "secret": SECRET},
            {
                "action": "subscribe",
                "trades": ["AAPL", "BRK.B"],
                "dailyBars": ["AAPL", "BRK.B"],
            },
        ]
        conn.feed(
            [{"T": "subscription", "trades": ["AAPL", "BRK.B"], "dailyBars": ["AAPL", "BRK.B"]}],
            [
                {
                    "T": "d",
                    "S": "AAPL",
                    "o": 343.0,
                    "h": 347.77,
                    "l": 342.4,
                    "c": 347.0,
                    "v": 391880,
                },
                trade("AAPL", 348.0),
                trade("BRK.B", 512.4, "2026-10-27T12:00:00Z"),
                trade("ZZZ", 1.0),  # nobody asked for it
            ],
        )
        await until(lambda: len(ticks.items) == 2)
        when = datetime(2026, 10, 27, 19, 59, 58, 500000, tzinfo=UTC)
        assert ticks.items[0] == {
            "id": "AAPL",
            "price": 348.0,
            "time": int(when.timestamp() * 1000),
            "market_hours": 1,
            "day_volume": 391880.0,
            "day_high": 348.0,
            "day_low": 342.4,
        }
        # The class share keeps its canonical name; 08:00 New York is pre-market; no day bar yet.
        assert ticks.items[1]["id"] == "BRK-B" and ticks.items[1]["market_hours"] == 0
        assert "day_volume" not in ticks.items[1]
        for tick in ticks.items:  # the hub's own normalizer accepts them
            assert normalize_message(tick) is not None
        await source.close()
        await asyncio.wait_for(task, 2)
        assert conn.closed

    asyncio.run(scenario())


def test_subscribing_while_connected_and_unsubscribing_send_frames() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        conn = net.conns[0]
        await handshake(conn)
        await source.subscribe(["BRK-B", "AAPL"])
        await until(lambda: has_sent(conn, "subscribe", 2))
        assert conn.sent_json()[-1] == {
            "action": "subscribe",
            "trades": ["BRK.B"],
            "dailyBars": ["BRK.B"],
        }
        await source.unsubscribe(["AAPL"])
        assert conn.sent_json()[-1] == {
            "action": "unsubscribe",
            "trades": ["AAPL"],
            "dailyBars": ["AAPL"],
        }
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_the_basic_plan_streams_30_symbols_and_the_rest_wait_for_a_free_slot() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        symbols = [f"S{i:02d}" for i in range(33)]
        await source.subscribe(symbols)
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        conn = net.conns[0]
        await handshake(conn)
        subscribed = conn.sent_json()[1]["trades"]
        assert subscribed == symbols[:30]
        # A stream slot frees up: the first symbol past the limit moves up.
        await source.unsubscribe([symbols[0]])
        await until(lambda: has_sent(conn, "subscribe", 2))
        assert conn.sent_json()[-1]["trades"] == [symbols[30]]
        assert conn.sent_json()[-2] == {
            "action": "unsubscribe",
            "trades": [symbols[0]],
            "dailyBars": [symbols[0]],
        }
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_the_algo_plan_has_no_symbol_limit_and_streams_sip() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net, plan="algo_trader_plus")
        symbols = [f"S{i:02d}" for i in range(45)]
        await source.subscribe(symbols)
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        assert net.urls() == [f"{STREAM}/v2/sip"]
        await handshake(net.conns[0])
        assert net.conns[0].sent_json()[1]["trades"] == symbols
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_a_symbol_limit_error_is_logged_once_and_does_not_end_the_stream(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        conn = net.conns[0]
        await handshake(conn)
        error405 = {"T": "error", "code": 405, "msg": "symbol limit exceeded"}
        conn.feed([error405], [error405], [trade("AAPL", 1.0)])
        await until(lambda: len(ticks.items) == 1)
        assert not task.done()
        await source.close()
        await asyncio.wait_for(task, 2)

    with caplog.at_level(logging.WARNING, logger="tickerglass_api.providers.alpaca"):
        asyncio.run(scenario())
    assert caplog.text.count("symbol limit reached") == 1


@pytest.mark.parametrize(
    ("code", "text"),
    [(402, "authentication failed"), (406, "connection limit"), (409, "subscription")],
)
def test_fatal_stream_errors_end_listen_with_a_provider_error(code: int, text: str) -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        net.conns[0].feed([{"T": "error", "code": code, "msg": "no"}])
        with pytest.raises(ProviderError, match=text) as info:
            await asyncio.wait_for(task, 2)
        assert SECRET not in str(info.value)
        assert net.conns[0].closed and len(net.conns) == 1  # no reconnect storm
        await source.close()  # the hub's `close` after a failed `listen`

    asyncio.run(scenario())


def test_one_connection_failing_for_good_leaves_the_other_streaming() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL", "BTC-USD"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 2)
        stocks, crypto = net.conns
        await handshake(stocks)
        await handshake(crypto)
        # The crypto stream is refused (say, no crypto entitlement): that connection ends.
        crypto.feed([{"T": "error", "code": 409, "msg": "no"}])
        await until(lambda: crypto.closed)
        stocks.feed([trade("AAPL", 7.0)])
        await until(lambda: len(ticks.items) == 1)
        assert not task.done() and not stocks.closed
        assert len(net.conns) == 2  # the dead connection is not retried
        # A symbol subscribed on the dead connection later changes nothing and does not break.
        await source.subscribe(["ETH-USD"])
        stocks.feed([trade("AAPL", 8.0)])
        await until(lambda: len(ticks.items) == 2)
        assert not task.done() and len(net.conns) == 2
        # The stocks one failing too leaves nothing to stream: now `listen` ends.
        stocks.feed([{"T": "error", "code": 402, "msg": "no"}])
        with pytest.raises(ProviderError, match="authentication failed"):
            await asyncio.wait_for(task, 2)
        await source.close()

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


def test_an_outage_of_one_connection_restarts_it_while_the_other_works() -> None:
    async def scenario() -> None:
        stocks = FakeConn()
        # The stocks stream connects first; crypto then fails twice (its max) and is restarted.
        net = FakeNet(stocks, OSError("down"), OSError("down"), FakeConn())
        source = live(net, max_failures=2)
        await source.subscribe(["AAPL", "BTC-USD"])
        task = asyncio.create_task(source.listen(Ticks()))
        await handshake(stocks)
        await until(lambda: len(net.calls) == 4)  # the restarted crypto connection
        assert not task.done()
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_a_lost_connection_is_reestablished_and_resubscribed() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL", "BRK-B"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        first = net.conns[0]
        await handshake(first)
        first.drop()
        await until(lambda: len(net.conns) == 2)
        second = net.conns[1]
        await handshake(second)
        assert second.sent_json() == first.sent_json()  # auth and the whole subscription again
        second.feed([trade("AAPL", 9.0)])
        await until(lambda: len(ticks.items) == 1)
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_crypto_has_its_own_connection_opened_only_when_a_crypto_symbol_is_subscribed() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL"])
        ticks = Ticks()
        task = asyncio.create_task(source.listen(ticks))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        assert net.urls() == [f"{STREAM}/v2/iex"]  # no crypto connection yet
        await source.subscribe(["BTC-USD", "ETH-USD"])
        await until(lambda: len(net.conns) == 2)
        assert net.urls()[1] == f"{STREAM}/v1beta3/crypto/us"
        crypto = net.conns[1]
        await handshake(crypto)
        assert crypto.sent_json()[1] == {
            "action": "subscribe",
            "trades": ["BTC/USD", "ETH/USD"],
            "dailyBars": ["BTC/USD", "ETH/USD"],
        }
        crypto.feed([trade("BTC/USD", 98000.5, "2026-10-27T12:00:00Z")])
        await until(lambda: len(ticks.items) == 1)
        # Crypto trades round the clock: always "regular".
        assert ticks.items[0]["id"] == "BTC-USD" and ticks.items[0]["market_hours"] == 1
        await source.close()
        await asyncio.wait_for(task, 2)
        assert all(c.closed for c in net.conns)

    asyncio.run(scenario())


def test_only_crypto_subscribed_opens_only_the_crypto_connection() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["BTC-USD"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await asyncio.sleep(0.02)
        assert net.urls() == [f"{STREAM}/v1beta3/crypto/us"]
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
        await handshake(second)
        assert second.sent_json()[1]["trades"] == ["BRK.B"]
        second.feed([trade("AAPL", 1.0), trade("BRK.B", 2.0)])
        await until(lambda: len(ticks.items) == 1)
        assert ticks.items[0]["id"] == "BRK-B"  # AAPL was forgotten
        await source.close()
        await asyncio.wait_for(task, 2)

    asyncio.run(scenario())


def test_cancelling_listen_closes_every_connection() -> None:
    async def scenario() -> None:
        net = FakeNet()
        source = live(net)
        await source.subscribe(["AAPL", "BTC-USD"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert all(c.closed for c in net.conns)

    asyncio.run(scenario())


def test_the_live_source_never_logs_the_secret(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        net = FakeNet(OSError("refused"))
        source = live(net)
        await source.subscribe(["AAPL"])
        task = asyncio.create_task(source.listen(Ticks()))
        await until(lambda: len(net.conns) == 1)
        await handshake(net.conns[0])
        net.conns[0].feed([{"T": "error", "code": 400, "msg": "invalid syntax"}], b"not json")
        await asyncio.sleep(0.02)
        await source.close()
        await asyncio.wait_for(task, 2)

    with caplog.at_level(logging.DEBUG):
        asyncio.run(scenario())
    assert SECRET not in caplog.text and KEY_ID not in caplog.text
