"""Stooq provider over recorded-shape CSV (`stooq_fake.FakeStooq`): symbol mapping, bars,
quotes, body sniffing, key redaction and the text path of `JsonHttp`. No network."""

import logging
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.error import URLError
from zoneinfo import ZoneInfo

import pytest
from pydantic import SecretStr
from stooq_fake import KEY, FakeStooq, fixture

from tickerglass_api.metrics import upstream
from tickerglass_api.providers import stooq
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
    metering,
)
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.http import HttpRateLimited, HttpStatusError, JsonHttp
from tickerglass_api.providers.registry import PROVIDERS, apply_setting_defaults, load_config
from tickerglass_api.settings import Settings

NY = ZoneInfo("America/New_York")
LONDON = ZoneInfo("Europe/London")
# 12:00:20 UTC on a Wednesday: 11h59m40s to midnight UTC.
NOW = datetime(2026, 10, 28, 12, 0, 20, tzinfo=UTC)
SPEC = PROVIDERS["stooq"]
KEY_PAGE_HINT = "https://stooq.com/q/d/?s=aapl.us&get_apikey"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("STOOQ_"):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


def config(**kwargs: Any) -> stooq.StooqConfig:
    return stooq.StooqConfig(api_key=SecretStr(KEY), _env_file=None, **kwargs)  # type: ignore[call-arg]


def make(fake: FakeStooq | None = None) -> tuple[stooq.StooqProvider, FakeStooq]:
    fake = fake or FakeStooq()
    return stooq.StooqProvider(config(), send=fake, clock=lambda: NOW), fake


def ny(day: str) -> datetime:
    return datetime.fromisoformat(day).replace(tzinfo=NY)


def text(body: str, status: int = 200, headers: Mapping[str, str] | None = None) -> Any:
    return lambda params: (status, dict(headers or {}), body.encode())


# -- config, spec ------------------------------------------------------------------------


def test_missing_key_is_not_configured() -> None:
    with pytest.raises(ProviderNotConfigured, match="STOOQ_API_KEY is not set"):
        load_config(SPEC)


def test_config_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STOOQ_API_KEY", KEY)
    cfg = load_config(SPEC)
    assert isinstance(cfg, stooq.StooqConfig)
    assert cfg.api_key.get_secret_value() == KEY and cfg.base_url == "https://stooq.com"
    assert KEY not in repr(cfg)  # a SecretStr


def test_spec_capabilities_costs_and_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    assert SPEC.network and "personal use" in (SPEC.terms or "")
    assert not SPEC.self_paging and SPEC.make_live is None
    caps = SPEC.capabilities(None)
    assert caps.intervals == {"1d", "1wk", "1mo"}
    assert not (caps.search or caps.news or caps.streaming or caps.adjusted_close)
    assert not (caps.extended_history or caps.extended_quotes or caps.events)
    assert not (caps.fundamentals_info or caps.fundamentals_statements)
    costs = SPEC.costs(None)
    assert (costs.history, costs.symbol_info, costs.search) == (1, 1, 0)
    assert (costs.quote_batch, costs.quote_per_request, costs.quote_per_symbol) == (50, 1, 0)
    assert costs.quotes(51) == 2
    defaults = SPEC.setting_defaults(None)
    assert defaults["upstream_rate_per_min"] == 10 and defaults["upstream_burst"] == 5
    assert defaults["upstream_daily_limit"] == 300
    # Every default names a real setting (apply_setting_defaults would raise otherwise).
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name, raising=False)  # conftest's permissive guard
    applied = apply_setting_defaults(SPEC, Settings(_env_file=None), None)  # type: ignore[call-arg]
    assert applied.upstream_rate_per_min == 10 and applied.upstream_daily_limit == 300


@pytest.mark.parametrize(
    "base_url", ["http://stooq.com", "ftp://stooq.com", "stooq.com", "https://", ""]
)
def test_a_base_url_that_is_not_https_is_refused(base_url: str) -> None:
    with pytest.raises(ValueError, match=r"STOOQ_BASE_URL must be an https:// URL"):
        config(base_url=base_url)


@pytest.mark.parametrize(
    "base_url",
    ["http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:9000", "https://x.test"],
)
def test_https_or_a_local_http_base_url_is_accepted(base_url: str) -> None:
    assert config(base_url=base_url).base_url == base_url


def test_an_insecure_base_url_from_the_environment_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("STOOQ_API_KEY", KEY)
    monkeypatch.setenv("STOOQ_BASE_URL", "http://stooq.com")
    with pytest.raises(ValueError, match="https"):
        load_config(SPEC)


def test_registry_builds_the_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STOOQ_API_KEY", KEY)
    provider = SPEC.make(Settings(_env_file=None), load_config(SPEC))  # type: ignore[call-arg]
    assert isinstance(provider, stooq.StooqProvider)


# -- symbol mapping ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("canonical", "symbol", "market", "tz"),
    [
        ("AAPL", "aapl.us", "us", "America/New_York"),
        ("aapl", "aapl.us", "us", "America/New_York"),
        ("BRK-B", "brk-b.us", "us", "America/New_York"),
        ("VOD.L", "vod.uk", "intl", "Europe/London"),
        ("SAP.DE", "sap.de", "intl", "Europe/Berlin"),
        ("7203.T", "7203.jp", "intl", "Asia/Tokyo"),
        ("^GSPC", "^spx", "index", "America/New_York"),
        ("^DJI", "^dji", "index", "America/New_York"),
        ("EURUSD=X", "eurusd", "fx", "UTC"),
        ("JPY=X", "usdjpy", "fx", "UTC"),
        ("BTC-USD", "btcusd", "crypto", "UTC"),
    ],
)
def test_to_provider(canonical: str, symbol: str, market: str, tz: str) -> None:
    mapped = stooq.to_provider(canonical)
    assert mapped is not None
    assert (mapped.symbol, mapped.market, mapped.timezone) == (symbol, market, tz)


@pytest.mark.parametrize(
    "canonical",
    [
        *["", "CL=F", "^VIX", "0700.HK", "AIR.PA", "ABC.XYZ", "USD=X", "EURGBPX=X", "A B", "AB$"],
        # crypto pairs Stooq does not serve (only -USD, -EUR and -GBP are), never US tickers
        *["BTC-USDT", "ETH-BTC", "SOL-USDC", "BTC-JPY", "BTC-CHF", "ETH-ETH"],
        # fiat pairs without "=X" (the canonical name is EURUSD=X)
        *["EURUSD", "usdjpy", "GBPCHF"],
    ],
)
def test_unmappable_symbols(canonical: str) -> None:
    assert stooq.to_provider(canonical) is None


def test_symbols_that_only_look_like_pairs_stay_us_tickers() -> None:
    for ticker in ("BRK-B", "BF-B", "EURN", "USDX", "EURUSDX"):
        mapped = stooq.to_provider(ticker)
        assert mapped is not None and mapped.market == "us", ticker


@pytest.mark.parametrize("canonical", ["BTC-USDT", "ETH-BTC", "SOL-USDC", "BTC-JPY", "EURUSD"])
def test_pair_shaped_symbols_stooq_lacks_cost_no_request(canonical: str) -> None:
    p, fake = make()
    assert p.answers_locally("history", canonical) and p.answers_locally("quotes", canonical)
    assert p.billable([canonical, "AAPL"]) == ["AAPL"]
    for call in (
        lambda: p.history(canonical, "1d", None, None, False),
        lambda: p.symbol_info(canonical),
        lambda: p.quotes([canonical]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()
    assert fake.calls == []


@pytest.mark.parametrize(
    "canonical",
    ["AAPL", "BRK-B", "VOD.L", "SAP.DE", "7203.T", "^GSPC", "^DJI", "EURUSD=X", "JPY=X", "BTC-USD"],
)
def test_symbol_map_round_trips(canonical: str) -> None:
    mapped = stooq.to_provider(canonical)
    assert mapped is not None
    assert stooq.from_provider(mapped.symbol) == canonical


@pytest.mark.parametrize("symbol", ["", "foo.zz", "^nope", "abc"])
def test_from_provider_unknown(symbol: str) -> None:
    assert stooq.from_provider(symbol) is None


def test_unmappable_symbols_are_unsupported_free_and_never_sent() -> None:
    p, fake = make()
    for symbol in ("CL=F", "^VIX", "AIR.PA"):
        with pytest.raises(ProviderUnsupported):
            p.history(symbol, "1d", None, None, False)
        with pytest.raises(ProviderUnsupported):
            p.symbol_info(symbol)
        assert p.answers_locally("history", symbol)
    with pytest.raises(ProviderUnsupported):
        p.quotes(["CL=F", "^VIX"])
    assert p.billable(["aapl", "AAPL", "CL=F", "VOD.L"]) == ["AAPL", "VOD.L"]
    assert not p.answers_locally("history", "AAPL")
    assert fake.calls == []


# -- history -----------------------------------------------------------------------------


def test_daily_bars_and_request_parameters() -> None:
    p, fake = make()
    df = p.history("AAPL", "1d", ny("2026-10-20"), datetime(2026, 10, 28, tzinfo=UTC), False)
    assert list(df.columns) == BAR_COLUMNS
    assert len(df) == 6 and df["ts"].is_monotonic_increasing
    first = df.iloc[0]
    assert (first["open"], first["high"], first["low"], first["close"]) == (
        255.88,
        264.38,
        255.63,
        263.43,
    )
    assert first["volume"] == 67000000
    assert (df["adj_close"] == df["close"]).all()  # split-adjusted only: close stands in
    path, params, headers = fake.calls[0]
    assert path == "/q/d/l/"
    assert params == {
        "s": "aapl.us",
        "i": "d",
        "d1": "20261020",
        "d2": "20261027",  # 2026-10-28 00:00 UTC is still the 27th in New York
        "apikey": KEY,
    }
    assert headers["Accept"].startswith("text/csv")
    assert headers["User-Agent"].startswith("TickerGlass/")


def test_daily_bars_are_exchange_local_midnight() -> None:
    p, _ = make()
    df = p.history("AAPL", "1d", None, None, False)
    for t in df["ts"]:
        local = datetime.fromtimestamp(int(t), NY)
        assert (local.hour, local.minute, local.second) == (0, 0, 0)
    uk = p.history("VOD.L", "1d", None, None, False)
    assert datetime.fromtimestamp(int(uk["ts"].iloc[0]), LONDON).hour == 0


def test_range_is_half_open() -> None:
    p, _ = make()
    df = p.history("AAPL", "1d", ny("2026-10-21"), ny("2026-10-23"), False)
    days = [datetime.fromtimestamp(int(t), NY).day for t in df["ts"]]
    assert days == [21, 22]


def test_full_history_sends_no_dates_and_open_ended_ranges_fill_in() -> None:
    p, fake = make()
    p.history("AAPL", "1d", None, None, False)
    assert "d1" not in fake.calls[0][1] and "d2" not in fake.calls[0][1]
    p.history("AAPL", "1d", ny("2026-10-21"), None, False)
    assert fake.calls[1][1]["d1"] == "20261021" and fake.calls[1][1]["d2"] == "20261029"  # tomorrow
    p.history("AAPL", "1d", None, ny("2026-10-22"), False)
    assert fake.calls[2][1]["d1"] == "19700101" and fake.calls[2][1]["d2"] == "20261022"


def test_weekly_and_monthly_bars() -> None:
    p, fake = make()
    assert len(p.history("AAPL", "1wk", None, None, False)) == 5
    assert len(p.history("AAPL", "1mo", None, None, False)) == 10
    assert [c[1]["i"] for c in fake.calls] == ["w", "m"]


def test_weekly_and_monthly_bars_are_stamped_on_the_start_of_their_period() -> None:
    p, _ = make()
    # Stooq dates a bar on the period's last trading day (a Friday, the month's last day).
    weeks = p.history("AAPL", "1wk", None, None, False)
    stamps = [datetime.fromtimestamp(int(t), NY) for t in weeks["ts"]]
    assert [(d.month, d.day, d.weekday(), d.hour) for d in stamps[:2]] == [
        (9, 21, 0, 0),  # 2026-09-25 is in the week of Monday 21 September
        (9, 28, 0, 0),
    ]
    assert all(d.weekday() == 0 and d.hour == 0 for d in stamps)
    months = p.history("AAPL", "1mo", None, None, False)
    stamps = [datetime.fromtimestamp(int(t), NY) for t in months["ts"]]
    assert [(d.month, d.day, d.hour) for d in stamps[:3]] == [(1, 1, 0), (2, 1, 0), (3, 1, 0)]
    assert all(d.day == 1 and d.hour == 0 for d in stamps)
    # Daily bars keep their own date.
    daily = p.history("AAPL", "1d", None, None, False)
    assert datetime.fromtimestamp(int(daily["ts"].iloc[0]), NY).day == 20


def test_weekly_bars_dated_mid_week_or_on_a_sunday_get_their_monday() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text(
        "Date,Open,High,Low,Close,Volume\n"
        "2026-10-08,1,2,0.5,1.5,10\n"  # Thursday: the Friday was a holiday
        "2026-10-18,1,2,0.5,1.5,10\n"  # a Sunday: its week began Monday the 12th
    )
    p, _ = make(fake)
    df = p.history("AAPL", "1wk", None, None, False)
    days = [datetime.fromtimestamp(int(t), NY).day for t in df["ts"]]
    assert days == [5, 12]


def test_other_intervals_are_unsupported_and_not_sent() -> None:
    p, fake = make()
    for interval in ("1m", "5m", "60m", "5d", "3mo"):
        with pytest.raises(ProviderUnsupported, match="Stooq"):
            p.history("AAPL", interval, None, None, False)
    assert fake.calls == []


def test_index_without_a_volume_column_has_zero_volume() -> None:
    p, _ = make()
    df = p.history("^GSPC", "1d", None, None, False)
    assert len(df) == 2 and (df["volume"] == 0).all()


def test_empty_range_of_a_symbol_that_served_bars_is_empty_without_a_probe() -> None:
    p, fake = make()
    p.history("AAPL", "1d", None, None, False)  # now known
    far = datetime(2026, 12, 1, tzinfo=UTC)
    df = p.history("AAPL", "1d", far, far.replace(day=5), False)
    assert df.empty and list(df.columns) == BAR_COLUMNS
    assert len(fake.calls) == 2


def test_empty_range_of_a_fresh_symbol_is_probed_once_then_remembered() -> None:
    p, fake = make()
    far = datetime(2026, 12, 1, tzinfo=UTC)
    assert p.history("AAPL", "1d", far, far.replace(day=5), False).empty
    assert [c[1]["i"] for c in fake.calls] == ["d", "m"]  # the probe is the monthly history
    assert "d1" not in fake.calls[1][1]
    assert p.history("AAPL", "1d", far, far.replace(day=6), False).empty
    assert len(fake.calls) == 3  # known now: no second probe


def test_probe_is_charged_to_the_guard() -> None:
    p, _ = make()
    charged: list[int] = []
    far = datetime(2026, 12, 1, tzinfo=UTC)
    with metering(charged.append):
        p.history("AAPL", "1d", far, far.replace(day=5), False)
    assert charged == [1]


def test_probe_the_guard_refuses_gives_the_benefit_of_the_doubt() -> None:
    p, fake = make()

    def refuse(n: int) -> None:
        raise RateLimited("budget", 30)

    with metering(refuse):
        df = p.history("ZZZZ", "1d", ny("2026-10-01"), ny("2026-10-02"), False)
    assert df.empty and len(fake.calls) == 1


def test_unknown_symbol_is_not_found() -> None:
    p, fake = make()
    with pytest.raises(SymbolNotFound):
        p.history("ZZZZNOTREAL", "1d", None, None, False)  # whole history empty: no probe
    assert len(fake.calls) == 1
    with pytest.raises(SymbolNotFound):
        p.history("ZZZZNOTREAL", "1d", ny("2026-10-01"), ny("2026-10-20"), False)
    assert [c[1]["i"] for c in fake.calls[1:]] == ["d", "m"]  # range empty, then the probe
    with pytest.raises(SymbolNotFound):
        p.symbol_info("ZZZZNOTREAL")


def test_header_only_and_unparsable_rows_are_empty() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("Date,Open,High,Low,Close,Volume\n")
    p, _ = make(fake)
    assert p.history("AAPL", "1d", None, None, False).empty
    fake.answers["/q/d/l/"] = text(
        "Date,Open,High,Low,Close,Volume\n2026-10-20,N/D,N/D,N/D,N/D,0\nbad,1,2,0.5,1,0\n"
    )
    assert p.history("AAPL", "1d", None, None, False).empty


def test_csv_without_the_expected_columns_is_an_error_that_does_not_echo_the_body() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("hello,world\n1,2\n")
    p, _ = make(fake)
    with pytest.raises(ProviderError, match="not the expected CSV") as exc:
        p.history("AAPL", "1d", None, None, False)
    assert "hello" not in str(exc.value)


# -- symbol info, search, unsupported ----------------------------------------------------


def test_symbol_info_from_the_mapping() -> None:
    p, fake = make()
    info = p.symbol_info("aapl")
    assert info["symbol"] == "AAPL" and info["type"] == "equity" and info["currency"] == "USD"
    assert (info["timezone"], info["session"]) == ("America/New_York", "0930-1600")
    assert info["hasIntraday"] is False and info["priceHint"] == 2
    assert [c[1]["i"] for c in fake.calls] == ["m"]
    p.symbol_info("AAPL")
    assert len(fake.calls) == 1  # known: answered from the mapping
    uk = p.symbol_info("VOD.L")
    assert uk["timezone"] == "Europe/London" and uk["currency"] == "GBp"
    index = p.symbol_info("^GSPC")
    assert index["type"] == "index" and index["currency"] is None


def test_symbol_info_of_fx_and_crypto() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("Date,Open,High,Low,Close\n2026-10-20,1.1,1.2,1.0,1.15\n")
    p, _ = make(fake)
    fx = p.symbol_info("EURUSD=X")
    assert fx["type"] == "currency" and fx["priceHint"] == 4 and fx["timezone"] == "UTC"
    assert fx["session"] == "0000-2359" and fx["currency"] == "USD"
    assert p.symbol_info("BTC-USD")["type"] == "cryptocurrency"


def test_search_is_empty_and_the_rest_is_unsupported() -> None:
    p, fake = make()
    assert p.search("apple", 5) == []
    with pytest.raises(ProviderUnsupported):
        p.events("AAPL")
    with pytest.raises(ProviderUnsupported):
        p.news("AAPL", 5)
    with pytest.raises(ProviderUnsupported):
        p.fundamentals("AAPL")
    with pytest.raises(ProviderUnsupported):
        p.extended_quotes(["AAPL"])
    assert all(p.answers_locally(op, "AAPL") for op in ("events", "fundamentals", "news"))
    assert fake.calls == []


def test_the_guard_refuses_what_the_capabilities_exclude() -> None:
    p, fake = make()
    guarded = GuardedProvider(p, UpstreamGuard(), capabilities=SPEC.capabilities(None))
    with pytest.raises(ProviderUnsupported):
        guarded.history("AAPL", "5m", None, None, False)
    with pytest.raises(ProviderUnsupported):
        guarded.search("apple", 5)
    assert fake.calls == []


# -- quotes ------------------------------------------------------------------------------


def test_quotes_batch() -> None:
    p, fake = make()
    rows = p.quotes(["AAPL", "VOD.L", "ZZZZNOTREAL", "CL=F", "aapl"])
    assert isinstance(rows, QuoteList) and rows.confirmed
    assert [r["symbol"] for r in rows] == ["AAPL", "VOD.L"]
    aapl = rows[0]
    assert aapl["last"] == 267.26 and aapl["volume"] == 44000000 and aapl["currency"] == "USD"
    assert aapl["open"] == 264.88 and aapl["dayHigh"] == 269.12 and aapl["dayLow"] == 264.65
    assert aapl["prevClose"] is None and aapl["change"] is None
    # 22:00:09 Warsaw time (CET after the 25 October change): 21:00:09 UTC.
    assert aapl["time"] == int(datetime(2026, 10, 27, 21, 0, 9, tzinfo=UTC).timestamp())
    assert rows[1]["currency"] == "GBp"
    assert len(fake.calls) == 1
    path, params, _ = fake.calls[0]
    assert path == "/q/l/" and params["f"] == "sd2t2ohlcv" and params["e"] == "csv"
    assert params["s"] == "aapl.us vod.uk zzzznotreal.us" and params["apikey"] == KEY
    assert "s=aapl.us+vod.uk+zzzznotreal.us" in fake.urls[0]  # symbols joined by "+"


def test_quote_rows_carry_a_market_state_from_the_exchange_clock() -> None:
    fake = FakeStooq()
    # 11:00 and 12:00 New York time on Wednesday the 28th: the quotes are from today.
    fake.answers["/q/l/"] = text(
        "Symbol,Date,Time,Open,High,Low,Close,Volume\n"
        "AAPL.US,2026-10-28,17:00:00,1,2,0.5,1.5,100\n"
        "VOD.UK,2026-10-28,17:00:00,1,2,0.5,1.5,100\n"
        "BTCUSD,2026-10-28,17:00:00,1,2,0.5,1.5,100\n"
        "EURUSD,2026-10-28,17:00:00,1,2,0.5,1.5,100\n"
    )

    def states(now: datetime) -> dict[str, Any]:
        p = stooq.StooqProvider(config(), send=fake, clock=lambda: now)
        return {
            r["symbol"]: r["marketState"]
            for r in p.quotes(["AAPL", "VOD.L", "BTC-USD", "EURUSD=X"])
        }

    open_ny = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)  # 11:00 New York, 15:00 London
    assert states(open_ny) == {
        "AAPL": "REGULAR",
        "VOD.L": "REGULAR",
        "BTC-USD": "REGULAR",
        "EURUSD=X": "REGULAR",
    }
    # 17:00 London: past its 16:30 close, while New York trades.
    assert states(datetime(2026, 10, 28, 17, 0, tzinfo=UTC))["VOD.L"] == "CLOSED"
    assert states(datetime(2026, 10, 28, 17, 0, tzinfo=UTC))["AAPL"] == "REGULAR"
    # Before the open, and on a weekend: closed; fx and crypto never close.
    early = states(datetime(2026, 10, 28, 12, 0, tzinfo=UTC))
    assert early["AAPL"] == "CLOSED" and early["BTC-USD"] == "REGULAR"
    saturday = states(datetime(2026, 10, 31, 15, 0, tzinfo=UTC))
    assert saturday["AAPL"] == "CLOSED" and saturday["EURUSD=X"] == "REGULAR"


def test_a_quote_of_an_earlier_day_is_closed_even_inside_the_session_hours() -> None:
    p, _ = make()  # the fixture's quotes are dated the 27th
    rows = p.quotes(["AAPL"])
    assert rows[0]["marketState"] == "CLOSED"  # 08:00 New York: before the open anyway
    p = stooq.StooqProvider(
        config(), send=FakeStooq(), clock=lambda: datetime(2026, 10, 28, 15, 0, tzinfo=UTC)
    )
    assert p.quotes(["AAPL"])[0]["marketState"] == "CLOSED"  # a holiday today: nothing new


def test_fallback_quote_rows_have_a_market_state_too() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text("<html><body>nope</body></html>")
    p, _ = make(fake)
    assert {r["marketState"] for r in p.quotes(["AAPL", "VOD.L"])} == {"CLOSED"}


def test_quotes_for_symbols_the_csv_omits_are_not_confirmed() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text(
        "Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-10-27,22:00:09,1,2,0.5,1.5,100\n"
    )
    p, _ = make(fake)
    rows = p.quotes(["AAPL", "MSFT"])
    assert [r["symbol"] for r in rows] == ["AAPL"] and not rows.confirmed


def test_quotes_are_batched_by_50() -> None:
    p, fake = make()
    p.quotes([f"S{i}" for i in range(120)])
    assert [len(c[1]["s"].split()) for c in fake.calls] == [50, 50, 20]


def test_quotes_two_canonical_names_for_one_listing() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text(
        "Symbol,Date,Time,Open,High,Low,Close,Volume\nUSDJPY,2026-10-27,22:00:09,1,2,0.5,150.5,0\n"
    )
    p, _ = make(fake)
    rows = p.quotes(["JPY=X", "USDJPY=X"])
    assert sorted(r["symbol"] for r in rows) == ["JPY=X", "USDJPY=X"]
    assert len(fake.calls) == 1 and fake.calls[0][1]["s"] == "usdjpy"


def test_quotes_fall_back_to_the_last_two_daily_bars() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text("<html><body>nope</body></html>")  # key refused here (unverified)
    p, _ = make(fake)
    charged: list[int] = []
    with metering(charged.append):
        rows = p.quotes(["AAPL", "VOD.L"])
    by_symbol = {r["symbol"]: r for r in rows}
    aapl = by_symbol["AAPL"]
    assert aapl["last"] == 267.26 and aapl["prevClose"] == 262.82
    assert aapl["change"] == pytest.approx(4.44)
    assert aapl["changePercent"] == pytest.approx(4.44 / 262.82 * 100)
    assert aapl["dayHigh"] == 269.12 and aapl["volume"] == 44000000
    assert by_symbol["VOD.L"]["prevClose"] == 101.3
    # The call was charged one request, which the failed /q/l/ used: each of the two
    # daily-bars requests is charged on top (three requests were sent, three charged).
    assert charged == [1, 1]
    assert [c[0] for c in fake.calls] == ["/q/l/", "/q/d/l/", "/q/d/l/"]


def test_quote_fallback_on_an_unexpected_header() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text("foo,bar\n1,2\n")
    p, _ = make(fake)
    assert [r["symbol"] for r in p.quotes(["AAPL"])] == ["AAPL"]


def test_quote_fallback_stops_when_the_guard_refuses() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text("foo,bar\n")
    p, _ = make(fake)
    allowed = [True]

    def refuse_the_second(n: int) -> None:
        if not allowed:
            raise RateLimited("budget", 30)
        allowed.pop()

    with metering(refuse_the_second):
        rows = p.quotes(["AAPL", "VOD.L"])
    assert [r["symbol"] for r in rows] == ["AAPL"] and not rows.confirmed
    assert [c[0] for c in fake.calls] == ["/q/l/", "/q/d/l/"]  # nothing sent past the refusal

    # A guard that refuses the very first fallback request: nothing is sent for it.
    fake.calls.clear()
    p, _ = make(fake)

    def refuse(n: int) -> None:
        raise RateLimited("budget", 30)

    with metering(refuse):
        rows = p.quotes(["AAPL", "VOD.L"])
    assert list(rows) == [] and not rows.confirmed
    assert [c[0] for c in fake.calls] == ["/q/l/"]


def test_a_failed_quote_endpoint_is_remembered_and_retried_after_hours() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text("<html><body>nope</body></html>")
    now = [NOW]
    p = stooq.StooqProvider(config(), send=fake, clock=lambda: now[0])
    assert [r["symbol"] for r in p.quotes(["AAPL"])] == ["AAPL"]
    assert [c[0] for c in fake.calls] == ["/q/l/", "/q/d/l/"]
    fake.calls.clear()
    # Remembered: straight to the daily bars. The call's own charge pays for the first of
    # them, so a second symbol is the only extra charge.
    charged: list[int] = []
    with metering(charged.append):
        rows = p.quotes(["AAPL", "VOD.L"])
    assert [r["symbol"] for r in rows] == ["AAPL", "VOD.L"]
    assert [c[0] for c in fake.calls] == ["/q/d/l/", "/q/d/l/"] and charged == [1]
    # Past the retry window `/q/l/` is asked again.
    fake.calls.clear()
    now[0] = NOW + stooq.QUOTE_ENDPOINT_RETRY + timedelta(minutes=1)
    p.quotes(["AAPL"])
    assert [c[0] for c in fake.calls] == ["/q/l/", "/q/d/l/"]


def test_a_working_quote_endpoint_is_not_marked_failed() -> None:
    p, fake = make()
    p.quotes(["AAPL"])
    p.quotes(["VOD.L"])
    assert [c[0] for c in fake.calls] == ["/q/l/", "/q/l/"]


def test_a_refused_key_is_not_remembered_as_a_failed_quote_endpoint() -> None:
    p, fake = make(FakeStooq(key="another"))
    for _ in range(2):
        with pytest.raises(ProviderNotConfigured):
            p.quotes(["AAPL"])
    assert [c[0] for c in fake.calls] == ["/q/l/", "/q/d/l/", "/q/l/", "/q/d/l/"]


def test_quote_fallback_charges_every_request_through_a_real_guard() -> None:
    fake = FakeStooq()
    fake.answers["/q/l/"] = text("<html><body>nope</body></html>")
    p, _ = make(fake)
    guard = UpstreamGuard(rate_per_min=1, burst=5, max_wait_s=0)
    guarded = GuardedProvider(
        p, guard, costs=SPEC.costs(None), capabilities=SPEC.capabilities(None)
    )
    symbols = ["AAPL", "VOD.L", "MSFT", "IBM", "KO", "PEP"]
    rows = guarded.quotes(symbols)
    # Burst 5: the call's charge (1) plus four daily-bars requests; a fifth would need a
    # sixth token. /q/l/ plus 4 requests were sent (5 tokens), and no more.
    assert len(fake.calls) == 5 and [c[0] for c in fake.calls][0] == "/q/l/"
    assert len(rows) <= 4 and not rows.confirmed
    assert guard.snapshot()["tokens"] < 1


def test_quotes_with_a_wrong_key_say_so() -> None:
    p, _ = make(FakeStooq(key="another"))
    with pytest.raises(ProviderNotConfigured, match="key missing or expired"):
        p.quotes(["AAPL"])


# -- body sniffing and errors ------------------------------------------------------------


def test_daily_limit_text_is_a_daily_rate_limit_until_midnight_utc() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = lambda params: (200, {}, fixture("limit.txt"))
    p, _ = make(fake)
    with pytest.raises(RateLimited) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert exc.value.daily and exc.value.retry_after == 11 * 3600 + 59 * 60 + 40


def test_daily_limit_text_in_a_429_or_an_html_page_is_still_daily() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("Exceeded the daily hits limit", 429)
    p, _ = make(fake)
    with pytest.raises(RateLimited) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert exc.value.daily
    fake.answers["/q/d/l/"] = text("<html><body>Exceeded the daily hits limit.</body></html>")
    with pytest.raises(RateLimited) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert exc.value.daily


def test_a_plain_429_is_a_per_minute_limit_with_the_retry_after() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("slow down", 429, {"Retry-After": "17"})
    p, _ = make(fake)
    with pytest.raises(HttpRateLimited) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert not exc.value.daily and exc.value.retry_after == 17


def test_html_instead_of_csv_means_the_key_is_missing_or_expired() -> None:
    p, _ = make(FakeStooq(key="expired"))
    with pytest.raises(ProviderNotConfigured) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert KEY_PAGE_HINT in str(exc.value) and "STOOQ_API_KEY" in str(exc.value)
    with pytest.raises(ProviderNotConfigured):
        p.symbol_info("AAPL")


@pytest.mark.parametrize("status", [401, 403])
def test_auth_statuses_mean_the_key_is_rejected(status: int) -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("denied", status)
    p, _ = make(fake)
    with pytest.raises(ProviderNotConfigured, match="key missing or expired"):
        p.history("AAPL", "1d", None, None, False)


def test_404_is_no_data_and_other_statuses_are_errors() -> None:
    fake = FakeStooq()
    fake.answers["/q/d/l/"] = text("gone", 404)
    p, _ = make(fake)
    with pytest.raises(SymbolNotFound):
        p.history("AAPL", "1d", None, None, False)
    fake.answers["/q/d/l/"] = text("teapot", 418)
    with pytest.raises(HttpStatusError) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert exc.value.status == 418 and exc.value.body == "teapot"
    fake.answers["/q/d/l/"] = text("oops", 503)
    with pytest.raises(UpstreamUnavailable):
        p.history("AAPL", "1d", None, None, False)


def test_network_failure_is_unavailable() -> None:
    def send(url: str, headers: Mapping[str, str], timeout: float) -> Any:
        raise URLError(f"cannot reach {url}")

    p = stooq.StooqProvider(config(), send=send)
    with pytest.raises(UpstreamUnavailable) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert KEY not in str(exc.value) and "apikey" not in str(exc.value)


# -- the key stays out of messages, logs and metrics --------------------------------------


def test_redact() -> None:
    url = "https://stooq.com/q/d/l/?s=aapl.us&apikey=abcd1234&i=d"
    assert stooq.redact(url) == "https://stooq.com/q/d/l/?s=aapl.us&apikey=***&i=d"
    assert stooq.redact("APIKEY=zz&x=1") == "APIKEY=***&x=1"
    assert stooq.redact("key is abcd1234 here", "abcd1234") == "key is *** here"
    assert stooq.redact("tiny", "ti") == "tiny"  # too short to be a secret worth masking


def test_no_error_message_or_log_line_carries_the_key(caplog: pytest.LogCaptureFixture) -> None:
    scenarios: dict[str, Any] = {
        "limit": text("Exceeded the daily hits limit"),
        "html": text(f"<html>apikey={KEY}</html>"),
        "429": text(f"slow down {KEY}", 429),
        "500": text(f"error apikey={KEY}", 500),
        "418": text(f"apikey={KEY}", 418),
        "csv": text(f"apikey={KEY},x\n1,2\n"),
        "nodata": text("No data"),
    }
    leaks: list[str] = []
    with caplog.at_level(logging.DEBUG):
        for name, answer in scenarios.items():
            fake = FakeStooq()
            fake.answers["/q/d/l/"] = answer
            p, _ = make(fake)
            with pytest.raises(ProviderError) as exc:
                p.history("AAPL", "1d", None, None, False)
            if KEY in str(exc.value) or "apikey=" in str(exc.value):
                leaks.append(f"{name}: {exc.value}")
            for arg in exc.value.args:
                if KEY in str(arg):
                    leaks.append(f"{name} args: {arg}")
            body = getattr(exc.value, "body", None)
            assert body is None or isinstance(body, str)
            for shown in (body or "", repr(exc.value), repr(exc.value.args)):
                if KEY in shown or "apikey=" in shown.replace("apikey=***", ""):
                    leaks.append(f"{name} body/repr: {shown}")
    assert leaks == []
    assert KEY not in caplog.text


def test_an_error_body_that_echoes_the_request_url_is_redacted() -> None:
    fake = FakeStooq()
    echo = f"bad request: https://stooq.com/q/d/l/?s=aapl.us&i=d&apikey={KEY} and {KEY}"
    fake.answers["/q/d/l/"] = text(echo, 418)
    p, _ = make(fake)
    with pytest.raises(HttpStatusError) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert exc.value.status == 418
    assert KEY not in (exc.value.body or "") and "apikey=***" in exc.value.body
    assert KEY not in str(exc.value) and KEY not in repr(exc.value)
    fake.answers["/q/d/l/"] = text(echo, 429)  # a plain 429 carries a body too
    with pytest.raises(HttpRateLimited) as limited:
        p.history("AAPL", "1d", None, None, False)
    assert KEY not in (limited.value.body or "") and KEY not in repr(limited.value)


def test_errors_raised_by_send_are_scrubbed() -> None:
    def send(url: str, headers: Mapping[str, str], timeout: float) -> Any:
        raise ProviderError(f"boom {url}")

    p = stooq.StooqProvider(config(), send=send)
    with pytest.raises(ProviderError) as exc:
        p.history("AAPL", "1d", None, None, False)
    assert "apikey=***" in str(exc.value) and KEY not in str(exc.value)


def test_metrics_count_by_provider_id_only() -> None:
    before = upstream.snapshot()
    p, fake = make()
    p.history("AAPL", "1d", None, None, False)
    fake.answers["/q/d/l/"] = text("oops", 503)
    with pytest.raises(UpstreamUnavailable):
        p.history("AAPL", "1d", None, None, False)
    after = upstream.snapshot()
    delta = {k: v - before.get(k, 0) for k, v in after.items() if v != before.get(k, 0)}
    assert delta == {("stooq", "ok"): 1, ("stooq", "unavailable"): 1}
    for provider, outcome in after:
        assert KEY not in provider and KEY not in outcome


def test_a_200_answer_whose_body_is_an_error_is_not_counted_ok() -> None:
    def counted(answer: Any) -> dict[tuple[str, str], int]:
        before = upstream.snapshot()
        fake = FakeStooq()
        fake.answers["/q/d/l/"] = answer
        p, _ = make(fake)
        with pytest.raises(ProviderError):
            p.history("AAPL", "1d", None, None, False)
        after = upstream.snapshot()
        return {k: v - before.get(k, 0) for k, v in after.items() if v != before.get(k, 0)}

    assert counted(lambda params: (200, {}, fixture("limit.txt"))) == {("stooq", "rate_limited"): 1}
    assert counted(lambda params: (200, {}, fixture("key_page.html"))) == {("stooq", "error"): 1}
    assert counted(text("<meta charset=utf-8><title>Stooq</title>")) == {("stooq", "error"): 1}
    # Data, and "No data" (a valid answer about an unknown symbol), stay ok.
    before = upstream.snapshot()
    p, fake = make()
    p.history("AAPL", "1d", None, None, False)
    fake.answers["/q/d/l/"] = lambda params: (200, {}, fixture("no_data.txt"))
    with pytest.raises(SymbolNotFound):
        p.history("AAPL", "1d", None, None, False)
    after = upstream.snapshot()
    assert after[("stooq", "ok")] - before.get(("stooq", "ok"), 0) == 2


def test_quotes_with_a_bogus_key_say_so_even_when_the_quote_page_is_a_404_fragment() -> None:
    # What stooq.com answers `/q/l/` with a key it does not know: a 404 page that is not a
    # whole HTML document, so it used to read as "no such symbol" and hide the key problem.
    page = (
        "<meta charset=utf-8><title>Stooq</title><center><p>The page you requested does not "
        "exist<br>or has been moved</center>"
    )
    fake = FakeStooq(key="another")
    fake.answers["/q/l/"] = text(page, 404)
    p, _ = make(fake)
    with pytest.raises(ProviderNotConfigured, match="key missing or expired"):
        p.quotes(["AAPL"])
    # With the right key a 404 for the quote endpoint falls back to the daily bars.
    fake = FakeStooq()
    fake.answers["/q/l/"] = text(page, 404)
    p, _ = make(fake)
    rows = p.quotes(["AAPL"])
    assert [r["symbol"] for r in rows] == ["AAPL"]


# -- JsonHttp.get_text -------------------------------------------------------------------


def test_get_text_classify_recounts_a_2xx_answer_before_it_is_counted() -> None:
    def classify(body: str) -> str | None:
        return "error" if body.startswith("<") else None

    before = upstream.snapshot()
    send = Send((200, {}, b"<html>"), (200, {}, b"a,b\n"), (500, {}, b"<html>"))
    http = JsonHttp("https://h.test", send=send, provider="cl")
    assert http.get_text("/a", {}, classify=classify) == "<html>"  # still returned
    assert http.get_text("/a", {}, classify=classify) == "a,b\n"
    with pytest.raises(UpstreamUnavailable):  # a failing status keeps its own outcome
        http.get_text("/a", {}, classify=classify)
    after = upstream.snapshot()
    delta = {k: v - before.get(k, 0) for k, v in after.items() if k[0] == "cl"}
    assert delta == {("cl", "error"): 1, ("cl", "ok"): 1, ("cl", "unavailable"): 1}


class Send:
    def __init__(self, *replies: tuple[int, Mapping[str, str], bytes] | Exception) -> None:
        self.replies = list(replies)
        self.calls: list[tuple[str, Mapping[str, str], float]] = []

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, Mapping[str, str], bytes]:
        self.calls.append((url, headers, timeout))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def test_get_text_returns_the_decoded_body_and_keeps_json_get_unchanged() -> None:
    send = Send(
        (200, {}, b"\xef\xbb\xbfa,b\n1,2\n"),
        (200, {}, b'{"x": 1}'),
    )
    http = JsonHttp("https://h.test/", send=send, headers={"X-A": "1"}, timeout_s=3)
    assert http.get_text("/csv", {"k": "v w"}) == "a,b\n1,2\n"
    url, headers, timeout = send.calls[0]
    assert url == "https://h.test/csv?k=v+w" and timeout == 3 and headers["X-A"] == "1"
    assert headers["Accept"].startswith("text/csv")
    assert http.get("/j", {}) == {"x": 1}
    assert send.calls[1][1]["Accept"] == "application/json"  # the JSON client is as before


def test_get_text_maps_errors_like_get_and_never_names_the_query() -> None:
    long = b"x" * 2000
    send = Send(
        (429, {"retry-after": "9"}, b"slow"),
        (503, {}, b"down"),
        (418, {}, long),
        URLError("nope"),
    )
    http = JsonHttp("https://h.test", send=send)
    with pytest.raises(HttpRateLimited) as limited:
        http.get_text("/p", {"apikey": "SECRET"})
    assert limited.value.retry_after == 9 and limited.value.body == "slow"
    with pytest.raises(UpstreamUnavailable) as down:
        http.get_text("/p", {"apikey": "SECRET"})
    with pytest.raises(HttpStatusError) as status:
        http.get_text("/p", {"apikey": "SECRET"})
    assert status.value.status == 418 and len(status.value.body) == 500
    with pytest.raises(UpstreamUnavailable) as network:
        http.get_text("/p", {"apikey": "SECRET"})
    for exc in (limited.value, down.value, status.value, network.value):
        assert "SECRET" not in str(exc) and "apikey" not in str(exc)
    assert str(down.value) == "h.test/p: HTTP 503"


def test_get_text_counts_requests_by_provider() -> None:
    before = upstream.snapshot()
    http = JsonHttp("https://h.test", send=Send((200, {}, b"ok"), (500, {}, b"")), provider="tx")
    http.get_text("/a", {})
    with pytest.raises(UpstreamUnavailable):
        http.get_text("/a", {})
    after = upstream.snapshot()
    assert after[("tx", "ok")] - before.get(("tx", "ok"), 0) == 1
    assert after[("tx", "unavailable")] - before.get(("tx", "unavailable"), 0) == 1


def test_get_text_calls_the_header_handler() -> None:
    seen: list[Mapping[str, str]] = []
    http = JsonHttp(
        "https://h.test", send=Send((200, {"X-Left": "5"}, b"ok")), on_headers=seen.append
    )
    http.get_text("/a", {})
    assert seen == [{"x-left": "5"}]
