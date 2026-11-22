"""Massive provider over hand-built responses (`massive_fake.FakeMassive`): plans, symbol
mapping, bars and paging, quotes, errors and the guard around it. No network."""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from massive_fake import FakeMassive, answer_of, body_of, error
from pydantic import SecretStr

from tickerglass_api.metrics import upstream
from tickerglass_api.providers import massive
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
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
from tickerglass_api.providers.registry import PROVIDERS, load_config
from tickerglass_api.settings import Settings

KEY = "massive-test-key-0123456789"
# A Wednesday, 08:00 New York time (before the open).
NOW = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
OPEN_NOW = datetime(2026, 10, 28, 15, 0, tzinfo=UTC)  # 11:00 New York
SPEC = PROVIDERS["massive"]
AAPL_1D = "/v2/aggs/ticker/AAPL/range/1/day/2026-10-18/2026-10-27"
WINDOW = (datetime(2026, 10, 20, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))
INTRADAY_WINDOW = (datetime(2026, 10, 26, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("MASSIVE_"):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


def config(**kwargs: Any) -> massive.MassiveConfig:
    return massive.MassiveConfig(api_key=SecretStr(KEY), _env_file=None, **kwargs)  # type: ignore[call-arg]


def make(
    fake: FakeMassive | None = None, now: datetime = NOW, plan: str = "starter", **kwargs: Any
) -> tuple[massive.MassiveProvider, FakeMassive]:
    fake = fake or FakeMassive()
    return massive.MassiveProvider(config(plan=plan, **kwargs), send=fake, clock=lambda: now), fake


def utc(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


# -- plans -------------------------------------------------------------------------------


def test_plan_table() -> None:
    basic, starter, developer, advanced = (
        massive.PLAN_PROFILES[p] for p in ("basic", "starter", "developer", "advanced")
    )
    assert (basic.calls_per_min, basic.history_years) == (5, 2)
    assert not basic.intraday and not basic.snapshot
    assert (starter.calls_per_min, starter.history_years, starter.delay_min) == (None, 5, 15)
    assert starter.intraday and starter.snapshot
    assert (developer.history_years, developer.delay_min) == (10, 15)
    assert (advanced.history_years, advanced.delay_min, advanced.quote_ttl_s) == (None, 0, 15)


def test_basic_capabilities_are_daily_only() -> None:
    caps = SPEC.capabilities(config(plan="basic"))
    assert caps.intervals == {"1d", "1wk", "1mo", "3mo"}
    assert not caps.extended_history and not caps.streaming and not caps.extended_quotes
    assert caps.search and caps.fundamentals_info and not caps.fundamentals_statements
    assert not caps.news and not caps.events and not caps.adjusted_close
    assert caps.markets == {"us", "fx", "crypto"}


def test_paid_capabilities_add_intraday() -> None:
    caps = SPEC.capabilities(config(plan="starter"))
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
    assert caps.extended_history and not caps.streaming


def test_without_config_the_basic_plan_applies() -> None:
    assert massive.effective_profile(None) is massive.PLAN_PROFILES["basic"]
    assert SPEC.plan(None) == "basic"
    assert SPEC.capabilities(None).intervals == {"1d", "1wk", "1mo", "3mo"}


def test_costs_price_basic_quotes_per_symbol() -> None:
    basic, starter = SPEC.costs(config(plan="basic")), SPEC.costs(config(plan="starter"))
    # Priced per symbol (like Twelve Data), so the guard splits a long list to its burst.
    assert (basic.quote_batch, basic.quote_per_request, basic.quote_per_symbol) == (100, 0, 1)
    assert basic.quotes(3) == 3 and basic.quotes(10) == 10 and basic.quotes(101) == 101
    assert (starter.quote_per_request, starter.quote_per_symbol) == (1, 0)
    assert starter.quotes(3) == 1 and starter.quotes(101) == 2
    assert basic.history == basic.symbol_info == basic.search == 1
    assert basic.events == basic.news == 0


def test_setting_defaults() -> None:
    basic = SPEC.setting_defaults(config(plan="basic"))
    assert (basic["upstream_rate_per_min"], basic["upstream_burst"]) == (5.0, 5)
    assert "upstream_daily_limit" not in basic
    paid = SPEC.setting_defaults(config(plan="advanced"))
    assert "upstream_rate_per_min" not in paid  # unlimited: the global budget applies
    assert paid["quote_ttl_s"] == 15
    for defaults in (basic, paid):
        assert defaults.keys() <= Settings.model_fields.keys()


def test_registry_entry(monkeypatch: pytest.MonkeyPatch) -> None:
    assert SPEC.id == "massive" and "formerly Polygon.io" in SPEC.name
    assert SPEC.probe_symbol == "AAPL" and SPEC.network and SPEC.self_paging
    with pytest.raises(ProviderNotConfigured, match="MASSIVE_API_KEY is not set"):
        load_config(SPEC)
    monkeypatch.setenv("MASSIVE_API_KEY", KEY)
    monkeypatch.setenv("MASSIVE_PLAN", "developer")
    monkeypatch.setenv("MASSIVE_BASE_URL", "")  # docker-compose passes unset variables as ""
    loaded = load_config(SPEC)
    assert isinstance(loaded, massive.MassiveConfig)
    assert (loaded.plan, loaded.base_url) == ("developer", "https://api.massive.com")
    assert SPEC.plan(loaded) == "developer"
    assert isinstance(SPEC.make(Settings(), loaded), massive.MassiveProvider)


# -- symbols -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("symbol", "ticker", "market"),
    [
        ("AAPL", "AAPL", "us"),
        ("brk-b", "BRK.B", "us"),
        ("BTC-USD", "X:BTCUSD", "crypto"),
        ("ETH-BTC", "X:ETHBTC", "crypto"),
        ("EURUSD=X", "C:EURUSD", "fx"),
        ("JPY=X", "C:USDJPY", "fx"),
    ],
)
def test_to_provider(symbol: str, ticker: str, market: str) -> None:
    mapped = massive.to_provider(symbol)
    assert mapped is not None and (mapped.ticker, mapped.market) == (ticker, market)


@pytest.mark.parametrize("symbol", ["^GSPC", "ES=F", "VOD.L", "7203.T", "", "A B", "EURUSD=Y"])
def test_to_provider_has_no_name_for(symbol: str) -> None:
    assert massive.to_provider(symbol) is None


def test_from_provider() -> None:
    f = massive.from_provider
    assert f("BRK.B", market="stocks", locale="us") == "BRK-B"
    assert f("X:BTCUSD") == "BTC-USD" and f("X:ETHUSDT") == "ETH-USDT"
    assert f("C:EURUSD") == "EURUSD=X" and f("C:USDJPY") == "JPY=X"
    assert f("I:SPX", market="indices") is None
    assert f("AAPL", market="otc", locale="us") is None
    assert f("AAPL", market="stocks", locale="gb") is None
    assert f("C:AAPEUR") is None and f("") is None


def test_unsupported_symbols_are_refused_without_a_request() -> None:
    provider, fake = make()
    for symbol, what in (("^GSPC", "index"), ("ES=F", "futures"), ("VOD.L", "non-US")):
        with pytest.raises(ProviderUnsupported, match=what):
            provider.history(symbol, "1d", *WINDOW, False)
        with pytest.raises(ProviderUnsupported):
            provider.symbol_info(symbol)
    assert fake.calls == []


def test_symbol_routing() -> None:
    provider, _ = make()
    routing = as_symbol_routing(provider)
    assert routing is not None
    assert routing.billable(["aapl", "AAPL", "^GSPC", "VOD.L", "BTC-USD"]) == ["AAPL", "BTC-USD"]
    assert routing.answers_locally("history", "^GSPC")
    assert routing.answers_locally("fundamentals", "BTC-USD")
    assert not routing.answers_locally("fundamentals", "AAPL")
    assert not routing.answers_locally("history", "BTC-USD")


# -- transport ---------------------------------------------------------------------------


def test_key_travels_in_the_bearer_header_only() -> None:
    provider, fake = make()
    provider.history("AAPL", "1d", *WINDOW, False)
    provider.quotes(["AAPL"])
    assert fake.calls
    for _, params, headers in fake.calls:
        assert headers["Authorization"] == f"Bearer {KEY}"
        assert KEY not in "".join(params.values())
    assert all(KEY not in url and "apiKey" not in url for url in fake.urls)


def test_requests_are_counted_for_the_massive_label() -> None:
    before = upstream.snapshot().get(("massive", "ok"), 0)
    provider, fake = make()
    provider.history("AAPL", "1d", *WINDOW, False)
    assert upstream.snapshot().get(("massive", "ok"), 0) - before == len(fake.calls) == 1


def test_a_custom_base_url_is_used() -> None:
    provider, fake = make(base_url="https://api.polygon.io")
    provider.history("AAPL", "1d", *WINDOW, False)
    assert fake.urls[0].startswith("https://api.polygon.io/v2/aggs/")


@pytest.mark.parametrize(
    "base_url",
    ["http://api.massive.com", "ftp://api.massive.com", "api.massive.com", "https://", ""],
)
def test_a_base_url_that_is_not_https_is_refused(base_url: str) -> None:
    with pytest.raises(ValueError, match=r"MASSIVE_BASE_URL must be an https:// URL"):
        config(base_url=base_url)


@pytest.mark.parametrize(
    "base_url",
    ["http://localhost:8080", "http://127.0.0.1:9000/v1", "http://[::1]:9000", "HTTPS://x.test"],
)
def test_https_or_a_local_http_base_url_is_accepted(base_url: str) -> None:
    assert config(base_url=base_url).base_url == base_url


def test_an_insecure_base_url_from_the_environment_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MASSIVE_API_KEY", KEY)
    monkeypatch.setenv("MASSIVE_BASE_URL", "http://api.massive.com")
    with pytest.raises(ValueError, match="https"):
        load_config(SPEC)


# -- history -----------------------------------------------------------------------------


def test_daily_history() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1d", *WINDOW, False)
    assert list(df.columns) == BAR_COLUMNS
    assert df["ts"].tolist() == [
        1792468800,
        1792555200,
        1792641600,
        1792728000,
        1792987200,
        1793073600,
    ]  # ascending, New York midnight (EDT)
    last = df.iloc[-1]
    assert (last["open"], last["high"], last["low"], last["close"]) == (262.1, 265.2, 261.5, 264.0)
    assert last["adj_close"] == last["close"] and last["volume"] == 51234567
    path, params, _ = fake.calls[0]
    assert path == AAPL_1D
    assert params == {"adjusted": "true", "sort": "desc", "limit": "50000"}


def test_class_shares_use_the_dotted_ticker() -> None:
    provider, fake = make()
    provider.history("BRK-B", "1d", *WINDOW, False)
    assert fake.paths() == ["/v2/aggs/ticker/BRK.B/range/1/day/2026-10-18/2026-10-27"]


def test_range_filters_start_and_end() -> None:
    provider, _ = make()
    df = provider.history("AAPL", "1d", utc(2026, 10, 22, 12), utc(2026, 10, 27, 3), False)
    assert df["ts"].tolist() == [1792728000, 1792987200]  # 23 and 26 October
    far = datetime(2027, 1, 1, tzinfo=UTC)
    assert provider.history("AAPL", "1d", far, far.replace(day=9), False).empty


def test_weekly_monthly_and_quarterly_bars() -> None:
    provider, fake = make()
    assert not provider.history("AAPL", "1wk", *WINDOW, False).empty
    assert "/range/1/week/" in fake.paths()[0]
    month = provider.history("AAPL", "1mo", utc(2025, 12, 1), utc(2026, 11, 1), False)
    assert len(month) == 10 and "/range/1/month/" in fake.paths()[1]
    quarter = provider.history("AAPL", "3mo", utc(2025, 12, 1), utc(2026, 11, 1), False)
    assert len(quarter) == 4  # Q1, Q2, Q3 and the October bar of Q4
    assert quarter["open"].tolist() == [101, 104, 107, 110]
    assert quarter["volume"].tolist() == [3000, 3000, 3000, 1000]


def test_weekly_bars_that_start_on_a_sunday_are_stamped_on_the_monday() -> None:
    provider, fake = make()
    ny = ZoneInfo("America/New_York")

    def ms(*day: int) -> int:
        return int(datetime(*day, tzinfo=ny).timestamp() * 1000)

    row = {"v": 1, "o": 2, "h": 3, "l": 1, "c": 2}
    results = [
        {**row, "t": ms(2026, 10, 25)},  # a Sunday start
        {**row, "t": ms(2026, 10, 19)},  # a Monday start stays
        {**row, "t": ms(2026, 10, 12) - 4 * 3600 * 1000},  # Monday at UTC midnight stays
    ]
    path = "/v2/aggs/ticker/AAPL/range/1/week/2026-10-04/2026-11-02"
    fake.answers[path] = lambda params: (200, {}, {"status": "OK", "results": results})
    df = provider.history("AAPL", "1wk", utc(2026, 10, 12), utc(2026, 11, 3), False)
    mondays = [datetime(2026, 10, d, tzinfo=ny) for d in (12, 19, 26)]
    assert df["ts"].tolist() == [int(m.timestamp()) for m in mondays]
    # Daily bars on a Sunday are not moved.
    sunday = massive._frame([{**row, "t": ms(2026, 10, 25)}], "America/New_York", True)
    assert sunday["ts"].tolist() == [int(datetime(2026, 10, 25, tzinfo=ny).timestamp())]


def test_start_none_means_the_earliest_the_plan_serves() -> None:
    provider, fake = make(plan="advanced")
    provider.history("AAPL", "1d", None, None, False)
    assert fake.paths()[0].startswith("/v2/aggs/ticker/AAPL/range/1/day/1999-12-30/2026-10-29")
    provider, fake = make(plan="basic")
    provider.history("AAPL", "1d", None, None, False)
    low = fake.paths()[0].split("/")[-2]
    assert "2024-10-30" <= low <= "2024-11-01"  # two years before NOW, a few days inside


def test_basic_plan_clips_history_to_its_horizon() -> None:
    provider, fake = make(plan="basic")
    provider.history("AAPL", "1d", utc(2020, 1, 1), utc(2026, 10, 28), False)
    assert "2024-10-30" <= fake.paths()[0].split("/")[-2] <= "2024-11-01"
    fake.calls.clear()
    assert provider.history("AAPL", "1d", utc(2019, 1, 1), utc(2022, 1, 1), False).empty
    assert fake.calls == []  # wholly before what the plan serves


@pytest.mark.parametrize("interval", ["1d", "1wk", "1mo"])
def test_the_span_margin_never_pushes_a_request_before_the_horizon(interval: str) -> None:
    provider, fake = make(plan="basic")
    horizon = NOW - timedelta(days=365.25 * 2)
    # `start` sits just inside the horizon: the margin must not reach back past it.
    provider.history("AAPL", interval, horizon + timedelta(days=1), utc(2026, 10, 28), False)
    assert fake.paths()[0].split("/")[-2] >= (horizon + timedelta(days=2)).strftime("%Y-%m-%d")
    # Without a clip the margin still applies (a week bar starts before `start`).
    paid, paid_fake = make(plan="advanced")
    paid.history("AAPL", "1wk", utc(2026, 10, 14), utc(2026, 10, 28), False)
    assert paid_fake.paths()[0].split("/")[-2] == "2026-10-06"  # a week before the 14th (NY)


def test_basic_plan_refuses_intraday_without_a_request() -> None:
    provider, fake = make(plan="basic")
    for interval in ("1m", "2m", "5m", "15m", "30m", "60m", "90m"):
        with pytest.raises(ProviderUnsupported, match=interval):
            provider.history("AAPL", interval, *INTRADAY_WINDOW, False)
    with pytest.raises(ProviderUnsupported):
        provider.history("AAPL", "5d", *WINDOW, False)
    assert fake.calls == []
    guarded = GuardedProvider(
        provider, UpstreamGuard(), capabilities=SPEC.capabilities(config(plan="basic"))
    )
    with pytest.raises(ProviderUnsupported):
        guarded.history("AAPL", "1m", *INTRADAY_WINDOW, False)
    assert fake.calls == []


def test_intraday_history_keeps_the_regular_session() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "1m", *INTRADAY_WINDOW, False)
    assert len(df) == 9  # 12 bars less 08:00 pre-market and 16:00, 18:00 after hours
    assert df["ts"].iloc[0] == 1793021400 and df["ts"].iloc[-1] == 1793131140
    assert "/range/1/minute/" in fake.paths()[0]
    from_ms, to_ms = fake.paths()[0].split("/")[-2:]
    assert (int(from_ms), int(to_ms)) == (1792972800000, 1793145600000)  # the window in ms


def test_extended_hours_bars_when_asked() -> None:
    provider, _ = make()
    df = provider.history("AAPL", "1m", *INTRADAY_WINDOW, True)
    assert len(df) == 12
    assert 1793102400 in df["ts"].tolist()  # 08:00 New York pre-market


@pytest.mark.parametrize(("interval", "path_part"), [("5m", "5/minute"), ("15m", "15/minute")])
def test_native_minute_multipliers(interval: str, path_part: str) -> None:
    provider, fake = make()
    assert not provider.history("AAPL", interval, *INTRADAY_WINDOW, False).empty
    assert f"/range/{path_part}/" in fake.paths()[0]


def test_two_minute_bars_are_built_from_one_minute_ones() -> None:
    provider, fake = make()
    df = provider.history("AAPL", "2m", *INTRADAY_WINDOW, False)
    assert "/range/1/minute/" in fake.paths()[0]
    assert len(df) < 9 and df["ts"].iloc[0] == 1793021400  # 09:30 and 09:31 are one bar
    assert df["volume"].iloc[0] == 20000 + 19000


@pytest.mark.parametrize("interval", ["60m", "90m"])
def test_hour_bars_are_built_from_half_hour_ones_anchored_on_the_open(interval: str) -> None:
    provider, fake = make()
    df = provider.history("AAPL", interval, *INTRADAY_WINDOW, False)
    assert "/range/30/minute/" in fake.paths()[0]
    # 26 October: one bucket from 09:30; 27 October: the open's bucket and the 15:30 one.
    assert df["ts"].tolist() == [1793021400, 1793107800, 1793107800 + 6 * 3600]


def test_pages_follow_next_url_with_the_same_header() -> None:
    provider, fake = make()
    first = {
        "status": "OK",
        "results": [
            {"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1792987200000},
            {"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000},
        ],
        "next_url": "https://api.massive.com" + AAPL_1D + "?cursor=YWJj%3D&apiKey=LEAK",
    }
    second = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1792468800000}],
    }

    def answer(params: dict[str, str]) -> tuple[int, dict[str, str], Any]:
        return 200, {}, second if "cursor" in params else first

    fake.answers[AAPL_1D] = answer
    charges: list[int] = []
    with metering(charges.append):
        df = provider.history("AAPL", "1d", *WINDOW, False)
    assert df["ts"].tolist() == [1792468800, 1792987200, 1793073600]
    assert len(fake.calls) == 2
    assert fake.calls[1][1] == {"cursor": "YWJj="}  # the key of the URL is dropped
    assert all(h["Authorization"] == f"Bearer {KEY}" for _, _, h in fake.calls)
    assert all("LEAK" not in url for url in fake.urls)
    assert charges == [1]  # the second page is a call more


@pytest.mark.parametrize(
    "next_url",
    [
        "https://evil.example" + AAPL_1D + "?cursor=x",
        "http://api.massive.com" + AAPL_1D,  # another scheme is another origin
        "https://api.massive.com:8443" + AAPL_1D,  # another port
        "https://user:pw@api.massive.com" + AAPL_1D,  # credentials in the link
        "https://api.massive.com@evil.example" + AAPL_1D,  # the host is what follows the "@"
        "https://api.massive.com:bad" + AAPL_1D,  # an unusable port
    ],
)
def test_next_url_of_another_origin_is_not_followed(
    next_url: str, caplog: pytest.LogCaptureFixture
) -> None:
    provider, fake = make()
    body = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000}],
        "next_url": next_url,
    }
    fake.answers[AAPL_1D] = lambda params: (200, {}, body)
    df = provider.history("AAPL", "1d", *WINDOW, False)
    assert df["ts"].tolist() == [1793073600]  # the page already fetched is served
    assert len(fake.calls) == 1  # and the link is never requested
    assert "not followed" in caplog.text and "pw" not in caplog.text


@pytest.mark.parametrize(
    "next_url",
    [
        "HTTPS://API.Massive.COM" + AAPL_1D + "?cursor=x",  # case does not matter
        "https://api.massive.com:443" + AAPL_1D + "?cursor=x",  # the default port is the same
    ],
)
def test_next_url_of_the_same_origin_is_followed(next_url: str) -> None:
    provider, fake = make()
    first = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000}],
        "next_url": next_url,
    }
    last = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1792987200000}],
    }
    fake.answers[AAPL_1D] = lambda params: (200, {}, last if "cursor" in params else first)
    df = provider.history("AAPL", "1d", *WINDOW, False)
    assert df["ts"].tolist() == [1792987200, 1793073600] and len(fake.calls) == 2


def test_a_later_page_that_fails_keeps_the_newer_pages(caplog: pytest.LogCaptureFixture) -> None:
    first = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000}],
        "next_url": "https://api.massive.com" + AAPL_1D + "?cursor=x",
    }
    for failure in (
        (429, {"retry-after": "9"}, {}),
        (503, {}, {}),
        (400, {}, error("ERROR", "bad cursor")),
    ):
        provider, fake = make()
        fake.answers[AAPL_1D] = lambda params, f=failure: (
            f if "cursor" in params else (200, {}, first)
        )
        df = provider.history("AAPL", "1d", *WINDOW, False)
        assert df["ts"].tolist() == [1793073600] and len(fake.calls) == 2
    assert "aggregates page 2 failed" in caplog.text
    # The first page failing is still an error.
    provider, fake = make()
    fake.answers[AAPL_1D] = lambda params: (429, {}, {})
    with pytest.raises(RateLimited):
        provider.history("AAPL", "1d", *WINDOW, False)


def test_a_page_the_budget_cannot_pay_ends_paging_with_the_newest_bars() -> None:
    provider, fake = make()
    body = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000}],
        "next_url": "https://api.massive.com" + AAPL_1D + "?cursor=x",
    }
    fake.answers[AAPL_1D] = lambda params: (200, {}, body)

    def refuse(requests: int) -> None:
        raise RateLimited("budget", 5)

    with metering(refuse):
        df = provider.history("AAPL", "1d", *WINDOW, False)
    assert df["ts"].tolist() == [1793073600] and len(fake.calls) == 1


def test_paging_stops_at_the_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(massive, "MAX_PAGES", 3)
    provider, fake = make()
    fake.answers[AAPL_1D] = lambda params: (
        200,
        {},
        {
            "status": "OK",
            "results": [
                {"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000 - len(fake.calls)}
            ],
            "next_url": "https://api.massive.com" + AAPL_1D + f"?cursor={len(fake.calls)}",
        },
    )
    provider.history("AAPL", "1d", *WINDOW, False)
    assert len(fake.calls) == 3


def test_an_unknown_symbol_is_told_apart_by_the_reference_data() -> None:
    provider, fake = make()
    with pytest.raises(SymbolNotFound):
        provider.history("ZZZZNOTREAL", "1d", *WINDOW, False)
    assert fake.paths()[-1] == "/v3/reference/tickers/ZZZZNOTREAL"
    with pytest.raises(SymbolNotFound):
        provider.symbol_info("ZZZZNOTREAL")


def test_an_empty_range_of_a_known_symbol_is_empty_and_checked_once() -> None:
    provider, fake = make()
    fake.answers[AAPL_1D] = lambda params: answer_of("aggs_empty")
    assert provider.history("AAPL", "1d", *WINDOW, False).empty
    assert fake.paths() == [AAPL_1D, "/v3/reference/tickers/AAPL"]
    assert provider.history("AAPL", "1d", *WINDOW, False).empty
    assert fake.paths()[2:] == [AAPL_1D]  # the symbol is known now


def test_an_empty_range_stands_when_the_check_cannot_be_paid() -> None:
    provider, fake = make()
    fake.answers[AAPL_1D] = lambda params: answer_of("aggs_empty")

    def refuse(requests: int) -> None:
        raise RateLimited("budget", 5)

    def outage(requests: int) -> None:
        raise UpstreamUnavailable("breaker open")  # the guard's unavailable breaker

    for refusal in (refuse, outage):
        with metering(refusal):
            df = provider.history("AAPL", "1d", *WINDOW, False)
        assert df.empty and list(df.columns) == BAR_COLUMNS
        assert fake.paths() == [AAPL_1D] * len(fake.calls)  # the reference call was not sent


def test_a_404_of_the_aggregates_is_an_unknown_symbol() -> None:
    provider, fake = make()
    fake.answers[AAPL_1D] = lambda params: (404, {}, error("NOT_FOUND", "nope"))
    with pytest.raises(SymbolNotFound):
        provider.history("AAPL", "1d", *WINDOW, False)


def test_a_row_without_prices_is_dropped_and_a_missing_column_is_an_error() -> None:
    provider, fake = make()
    rows = [
        {"v": 1, "o": 2, "h": 3, "l": 1, "c": None, "t": 1792987200000},
        {"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000},
    ]
    fake.answers[AAPL_1D] = lambda params: (200, {}, {"status": "OK", "results": rows})
    assert provider.history("AAPL", "1d", *WINDOW, False)["ts"].tolist() == [1793073600]
    fake.answers[AAPL_1D] = lambda params: (200, {}, {"status": "OK", "results": [{"t": 1}]})
    with pytest.raises(ProviderError, match="lacks"):
        provider.history("AAPL", "1d", *WINDOW, False)
    fake.answers[AAPL_1D] = lambda params: (200, {}, {"status": "OK", "results": "oops"})
    with pytest.raises(ProviderError, match="unexpected"):
        provider.history("AAPL", "1d", *WINDOW, False)


def test_a_delayed_status_is_data() -> None:
    provider, fake = make()
    body = {**body_of("aggs_1d_aapl"), "status": "DELAYED"}
    fake.answers[AAPL_1D] = lambda params: (200, {}, body)
    assert len(provider.history("AAPL", "1d", *WINDOW, False)) == 6


# -- errors ------------------------------------------------------------------------------


def test_error_mapping() -> None:
    provider, fake = make()
    fake.answers[AAPL_1D] = lambda params: answer_of("error_401")
    with pytest.raises(ProviderNotConfigured, match="MASSIVE_API_KEY"):
        provider.history("AAPL", "1d", *WINDOW, False)
    fake.answers[AAPL_1D] = lambda params: answer_of("error_403")
    with pytest.raises(ProviderUnsupported, match="plan"):
        provider.history("AAPL", "1d", *WINDOW, False)
    fake.answers[AAPL_1D] = lambda params: (
        403,
        {},
        error("NOT_AUTHORIZED", "Your API key is not valid"),
    )
    with pytest.raises(ProviderNotConfigured):
        provider.history("AAPL", "1d", *WINDOW, False)
    fake.answers[AAPL_1D] = lambda params: (200, {}, error("NOT_AUTHORIZED", "upgrade your plan"))
    with pytest.raises(ProviderUnsupported):
        provider.history("AAPL", "1d", *WINDOW, False)
    fake.answers[AAPL_1D] = lambda params: (400, {}, error("ERROR", "bad request"))
    with pytest.raises(ProviderError, match="bad request"):
        provider.history("AAPL", "1d", *WINDOW, False)
    fake.answers[AAPL_1D] = lambda params: (503, {}, {})
    with pytest.raises(UpstreamUnavailable):
        provider.history("AAPL", "1d", *WINDOW, False)


def test_rate_limit_carries_retry_after() -> None:
    provider, fake = make(plan="basic")
    fake.answers[AAPL_1D] = lambda params: answer_of("error_429")
    with pytest.raises(RateLimited) as caught:
        provider.history("AAPL", "1d", *WINDOW, False)
    assert caught.value.retry_after == 23 and not caught.value.daily


# -- symbol info, search, fundamentals ---------------------------------------------------


def test_symbol_info() -> None:
    provider, fake = make()
    info = provider.symbol_info("AAPL")
    assert fake.paths() == ["/v3/reference/tickers/AAPL"]
    assert info["symbol"] == "AAPL" and info["name"] == "Apple Inc."
    assert (info["exchange"], info["type"], info["currency"]) == ("XNAS", "equity", "USD")
    assert (info["timezone"], info["session"]) == ("America/New_York", "0930-1600")
    assert (info["priceHint"], info["minTick"], info["hasIntraday"]) == (2, 0.01, True)
    assert make(plan="basic")[0].symbol_info("AAPL")["hasIntraday"] is False


def test_symbol_info_of_other_markets() -> None:
    provider, fake = make()
    brk = provider.symbol_info("BRK-B")
    assert brk["symbol"] == "BRK-B" and fake.paths() == ["/v3/reference/tickers/BRK.B"]
    btc = provider.symbol_info("BTC-USD")
    assert (btc["type"], btc["timezone"], btc["session"]) == ("cryptocurrency", "UTC", "0000-2359")
    assert btc["currency"] == "USD" and fake.paths()[-1] == "/v3/reference/tickers/X:BTCUSD"
    fx = provider.symbol_info("EURUSD=X")
    assert (fx["type"], fx["priceHint"], fx["minTick"]) == ("currency", 4, 0.0001)


def test_search_ranks_exact_then_prefix_and_drops_what_cannot_be_served() -> None:
    provider, fake = make()
    rows = provider.search("aapl", 5)
    assert [r["symbol"] for r in rows] == ["AAPL", "AAPLX", "AAPL-USD", "AAPD"]
    assert [r["type"] for r in rows] == ["equity", "mutualfund", "cryptocurrency", "etf"]
    assert rows[0]["exchange"] == "XNAS" and rows[0]["name"] == "Apple Inc."
    path, params, _ = fake.calls[0]
    assert path == "/v3/reference/tickers"
    assert params == {"search": "aapl", "active": "true", "limit": "15"}
    assert len(provider.search("AAPL", 2)) == 2
    assert provider.search("nomatch", 5) == []


def test_fundamentals_info() -> None:
    provider, fake = make()
    data = provider.fundamentals("AAPL")
    info = data["info"]
    assert fake.paths() == ["/v3/reference/tickers/AAPL"]
    assert set(info) <= set(massive.FUNDAMENTALS_INFO_KEYS)
    assert info["longName"] == "Apple Inc." and info["quoteType"] == "EQUITY"
    assert (info["currency"], info["exchange"]) == ("USD", "XNAS")
    assert info["marketCap"] == 3.9e12 and info["sharesOutstanding"] == 14.75e9
    assert info["industry"] == "Electronic Computers"
    assert info["fullTimeEmployees"] == 164000 and info["website"] == "https://www.apple.com"
    assert info["longBusinessSummary"].startswith("Apple designs")
    fake.calls.clear()
    assert provider.fundamentals("BTC-USD") == {"info": {}} and fake.calls == []
    with pytest.raises(SymbolNotFound):
        provider.fundamentals("ZZZZNOTREAL")


def test_unsupported_features() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported):
        provider.extended_quotes(["AAPL"])
    with pytest.raises(ProviderUnsupported):
        provider.events("AAPL")
    with pytest.raises(ProviderUnsupported):
        provider.news("AAPL", 5)
    assert fake.calls == []


# -- quotes ------------------------------------------------------------------------------


def test_snapshot_quotes_on_a_paid_plan() -> None:
    provider, fake = make()
    rows = provider.quotes(["AAPL", "MSFT", "NVDA", "ZZZZ"])
    assert isinstance(rows, QuoteList) and not rows.confirmed
    assert fake.paths() == ["/v2/snapshot/locale/us/markets/stocks/tickers"]
    assert fake.calls[0][1] == {"tickers": "AAPL,MSFT,NVDA,ZZZZ"}
    by_symbol = {r["symbol"]: r for r in rows}
    assert set(by_symbol) == {"AAPL", "MSFT"}  # NVDA has nothing to price, ZZZZ is unknown
    aapl = by_symbol["AAPL"]
    assert (aapl["last"], aapl["prevClose"], aapl["change"]) == (264.05, 262.1, 1.95)
    assert aapl["changePercent"] == pytest.approx(0.744, abs=0.001)
    assert (aapl["volume"], aapl["time"], aapl["currency"]) == (51234567, 1793131190, "USD")
    assert (aapl["open"], aapl["dayHigh"], aapl["dayLow"]) == (262.1, 265.2, 261.5)
    assert aapl["marketState"] == "CLOSED"  # 08:00 New York
    msft = by_symbol["MSFT"]  # nothing traded yet: the previous close stands in
    assert (msft["last"], msft["prevClose"], msft["change"], msft["volume"]) == (
        484.0,
        484.0,
        0,
        None,
    )


def test_snapshot_market_state_follows_the_session_clock() -> None:
    open_rows = make(now=OPEN_NOW)[0].quotes(["AAPL"])
    assert open_rows[0]["marketState"] == "REGULAR"
    saturday = datetime(2026, 10, 31, 15, 0, tzinfo=UTC)
    assert make(now=saturday)[0].quotes(["AAPL"])[0]["marketState"] == "CLOSED"


def test_snapshot_quotes_are_chunked() -> None:
    provider, fake = make()
    symbols = [f"S{i}" for i in range(250)]
    provider.quotes(symbols)
    assert [len(c[1]["tickers"].split(",")) for c in fake.calls] == [100, 100, 50]


def test_crypto_quotes_use_their_own_snapshot_and_cost_a_call_more() -> None:
    provider, fake = make()
    charges: list[int] = []
    with metering(charges.append):
        rows = provider.quotes(["AAPL", "BTC-USD"])
    assert sorted(fake.paths()) == [
        "/v2/snapshot/locale/global/markets/crypto/tickers",
        "/v2/snapshot/locale/us/markets/stocks/tickers",
    ]
    assert charges == [1]  # the guard priced one batch; two markets are two calls
    btc = next(r for r in rows if r["symbol"] == "BTC-USD")
    assert (btc["last"], btc["prevClose"], btc["currency"]) == (100005, 98000, None)
    assert btc["time"] == 1793131190 and btc["marketState"] == "REGULAR"  # ms timestamp


def test_a_refused_asset_class_does_not_hide_the_others() -> None:
    provider, fake = make()
    fake.answers["/v2/snapshot/locale/global/markets/crypto/tickers"] = lambda p: answer_of(
        "error_403"
    )
    assert [r["symbol"] for r in provider.quotes(["AAPL", "BTC-USD"])] == ["AAPL"]
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["BTC-USD"])


def test_quotes_of_unsupported_symbols_are_not_sent() -> None:
    provider, fake = make()
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["^GSPC", "VOD.L"])
    assert fake.calls == []
    assert [r["symbol"] for r in provider.quotes(["^GSPC", "AAPL"])] == ["AAPL"]
    assert len(fake.calls) == 1 and fake.calls[0][1] == {"tickers": "AAPL"}
    assert provider.quotes([]) == []


def test_basic_quotes_come_from_the_last_two_daily_bars() -> None:
    provider, fake = make(plan="basic")
    rows = provider.quotes(["AAPL", "ZZZZNOTREAL", "BRK-B"])
    assert len(fake.calls) == 3  # one call per symbol: that is what the cost model says
    path, params, _ = fake.calls[0]
    assert path == "/v2/aggs/ticker/AAPL/range/1/day/2026-10-14/2026-10-29"
    assert params == {"adjusted": "true", "sort": "desc", "limit": "2"}
    assert [r["symbol"] for r in rows] == ["AAPL", "BRK-B"]
    aapl = rows[0]
    assert (aapl["last"], aapl["prevClose"], aapl["marketState"]) == (264.0, 262.1, "CLOSED")
    assert aapl["change"] == pytest.approx(1.9) and aapl["changePercent"] == pytest.approx(
        0.7249, abs=1e-3
    )
    assert (aapl["volume"], aapl["time"]) == (51234567, 1793073600)
    assert SPEC.costs(config(plan="basic")).quotes(3) == 3


class _Clock:
    """Monotonic clock for the guard whose `sleep` only advances time."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.now += seconds


def _basic_guarded(
    fake: FakeMassive, clock: _Clock, *, max_wait_s: float = 0
) -> tuple[GuardedProvider, UpstreamGuard]:
    """The basic plan as the app wires it: 5 calls per minute, burst 5."""
    cfg = config(plan="basic")
    guard = UpstreamGuard(
        rate_per_min=5, burst=5, max_wait_s=max_wait_s, clock=clock, sleep=clock.sleep
    )
    provider = massive.MassiveProvider(cfg, send=fake, clock=lambda: NOW)
    guarded = GuardedProvider(
        provider, guard, costs=SPEC.costs(cfg), capabilities=SPEC.capabilities(cfg)
    )
    return guarded, guard


def test_basic_quotes_of_a_long_list_never_exceed_the_burst() -> None:
    fake = FakeMassive()
    guarded, _ = _basic_guarded(fake, _Clock())
    symbols = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOG", "META", "TSLA", "AMD", "INTC", "IBM"]
    rows = guarded.quotes(symbols)
    # One chunk of five calls fits the burst of 5; the second chunk finds the budget empty
    # and is refused before anything is sent: the first chunk's rows are served, not lost.
    assert len(fake.calls) == 5
    assert [r["symbol"] for r in rows] == symbols[:5]
    assert isinstance(rows, QuoteList) and not rows.confirmed


def test_basic_quotes_of_a_long_list_wait_for_the_budget_when_they_may() -> None:
    fake = FakeMassive()
    clock = _Clock()
    guarded, _ = _basic_guarded(fake, clock, max_wait_s=120)
    symbols = [f"S{i}" for i in range(10)]
    rows = guarded.quotes(symbols)
    assert len(fake.calls) == 10 and len(rows) == 10
    assert clock.now == 1000.0 + 60  # five tokens refill in a minute
    assert rows.confirmed is False  # a per-symbol quote never confirms an absence


def test_basic_quotes_keep_the_rows_priced_before_a_rate_limit() -> None:
    provider, fake = make(plan="basic")
    fake.answers["/v2/aggs/ticker/NVDA/range/1/day/2026-10-14/2026-10-29"] = lambda p: answer_of(
        "error_429"
    )
    rows = provider.quotes(["AAPL", "MSFT", "NVDA", "AMZN"])
    assert [r["symbol"] for r in rows] == ["AAPL", "MSFT"]
    assert isinstance(rows, QuoteList) and not rows.confirmed
    assert len(fake.calls) == 3  # AMZN was not asked after the limit
    # With nothing priced yet the limit is the caller's to see.
    with pytest.raises(RateLimited) as caught:
        provider.quotes(["NVDA"])
    assert caught.value.retry_after == 23


def test_basic_quotes_through_the_guard_keep_the_rows_before_a_rate_limit() -> None:
    fake = FakeMassive()
    fake.answers["/v2/aggs/ticker/NVDA/range/1/day/2026-10-14/2026-10-29"] = lambda p: answer_of(
        "error_429"
    )
    guarded, guard = _basic_guarded(fake, _Clock())
    rows = guarded.quotes(["AAPL", "MSFT", "NVDA", "AMZN"])
    assert [r["symbol"] for r in rows] == ["AAPL", "MSFT"]
    # The 429 was reported to the guard: its tokens are drained (one was left), so the next
    # call is refused locally instead of reaching Massive again at once.
    assert guard.snapshot()["tokens"] == 0
    sent = len(fake.calls)
    with pytest.raises(RateLimited):
        guarded.quotes(["AMZN"])
    assert len(fake.calls) == sent


def test_a_later_page_rate_limit_drains_the_guard_too() -> None:
    fake = FakeMassive()
    first = {
        "status": "OK",
        "results": [{"v": 1, "o": 2, "h": 3, "l": 1, "c": 2, "t": 1793073600000}],
        "next_url": "https://api.massive.com" + AAPL_1D + "?cursor=x",
    }
    fake.answers[AAPL_1D] = lambda params: (
        answer_of("error_429") if "cursor" in params else (200, {}, first)
    )
    guarded, guard = _basic_guarded(fake, _Clock())
    df = guarded.history("AAPL", "1d", *WINDOW, False)
    assert df["ts"].tolist() == [1793073600] and len(fake.calls) == 2
    assert guard.snapshot()["tokens"] == 0  # three were left after the two charged calls
    with pytest.raises(RateLimited):
        guarded.history("AAPL", "1d", *WINDOW, False)
    assert len(fake.calls) == 2


def test_basic_quotes_of_a_refused_symbol() -> None:
    provider, fake = make(plan="basic")
    fake.answers["/v2/aggs/ticker/X:BTCUSD/range/1/day/2026-10-14/2026-10-29"] = lambda p: (
        answer_of("error_403")
    )
    assert [r["symbol"] for r in provider.quotes(["AAPL", "BTC-USD"])] == ["AAPL"]
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["BTC-USD"])


def test_a_malformed_snapshot_is_an_error() -> None:
    provider, fake = make()
    fake.answers["/v2/snapshot/locale/us/markets/stocks/tickers"] = lambda p: (
        200,
        {},
        {"status": "OK", "tickers": "oops"},
    )
    with pytest.raises(ProviderError, match="unexpected"):
        provider.quotes(["AAPL"])


def test_timestamps_of_any_unit_normalize_to_seconds() -> None:
    f = massive._epoch_s
    assert f(1793131190) == f(1793131190000) == f(1793131190000000) == f(1793131190000000000)
    assert f(1793131190000) == 1793131190 and f(0) is None and f(None) is None
