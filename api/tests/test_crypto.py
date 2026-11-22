"""Crypto provider over the exchange fakes (`crypto_fake`): configuration and registry entry,
symbols, markets, bars (native and synthesized intervals, paging, Kraken's 720-bar window), quotes,
search, errors, request accounting. The live sources are in test_crypto_live.py. No network."""

import types
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from crypto_fake import (
    Answer,
    FakeBinance,
    FakeCoinbase,
    FakeExchange,
    FakeKraken,
    fixture,
)
from pydantic import ValidationError

from tickerglass_api.metrics import upstream
from tickerglass_api.providers import crypto
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
from tickerglass_api.providers.crypto.base import (
    INTERVALS,
    Market,
    Ticker,
    align_start,
    canonical_symbol,
    decimals,
    parse_symbol,
    plan_interval,
)
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.registry import (
    PROVIDERS,
    apply_setting_defaults,
    config_fields,
    is_configured,
    load_config,
)
from tickerglass_api.settings import Settings

NOW = datetime(2026, 10, 28, tzinfo=UTC)
SPEC = PROVIDERS["crypto"]
FAKES: dict[str, type[FakeExchange]] = {
    "kraken": FakeKraken,
    "coinbase": FakeCoinbase,
    "binance": FakeBinance,
}
#: A pair each exchange lists (Binance has no USD market).
SYMBOL = {"kraken": "BTC-USD", "coinbase": "BTC-USD", "binance": "BTC-USDT"}
EXCHANGES = sorted(FAKES)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in list(__import__("os").environ):
        if name.startswith("CRYPTO_"):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)  # no .env of the developer


def config(exchange: str = "kraken", **kwargs: Any) -> crypto.CryptoConfig:
    return crypto.CryptoConfig(
        exchange=exchange,  # type: ignore[arg-type]
        _env_file=None,  # type: ignore[call-arg]
        **kwargs,
    )


def make(
    exchange: str = "kraken",
    fake: FakeExchange | None = None,
    now: datetime = NOW,
    **kwargs: Any,
) -> tuple[crypto.CryptoProvider, Any]:
    max_pages = kwargs.pop("max_pages", None)
    fake = fake or FAKES[exchange](now)
    provider = crypto.CryptoProvider(
        config(exchange, **kwargs), send=fake, clock=lambda: now, max_pages=max_pages
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


def minutes_ago(n: int) -> datetime:
    return NOW - timedelta(minutes=n)


def utc(ts: int) -> datetime:
    return datetime.fromtimestamp(ts, UTC)


# -- configuration, plans and registry ---------------------------------------------------


def test_registry_entry_and_config_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    assert SPEC.config is crypto.CryptoConfig and SPEC.self_paging and SPEC.network
    assert SPEC.make_live is not None and SPEC.probe_symbol == "BTC-USD"
    assert SPEC.terms is not None and "CRYPTO_EXCHANGE" in SPEC.terms
    assert is_configured(SPEC)  # public data: nothing is required
    loaded = load_config(SPEC)
    assert isinstance(loaded, crypto.CryptoConfig) and loaded.exchange == "kraken"
    fields = {f.name: f for f in config_fields(SPEC, loaded)}
    assert fields["exchange"].value == "kraken" and fields["exchange"].env == "CRYPTO_EXCHANGE"
    assert not any(f.secret or f.required for f in fields.values())
    assert fields["base_url"].value is None and fields["stream_url"].value is None
    assert SPEC.plan(loaded) is None
    monkeypatch.setenv("CRYPTO_EXCHANGE", "binance")
    chosen = load_config(SPEC)
    assert isinstance(chosen, crypto.CryptoConfig) and chosen.exchange == "binance"
    assert {f.name: f for f in config_fields(SPEC, chosen)}["exchange"].set
    made = SPEC.make(Settings(_env_file=None), chosen)  # type: ignore[call-arg]
    assert isinstance(made, crypto.CryptoProvider) and made.exchange.id == "binance"
    live = SPEC.make_live(made, chosen)  # type: ignore[misc]
    assert isinstance(live, crypto.CryptoLiveSource)


def test_an_unknown_exchange_is_a_validation_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CRYPTO_EXCHANGE", "ftx")
    with pytest.raises(ValueError, match="exchange"):
        load_config(SPEC)
    assert not is_configured(SPEC)


@pytest.mark.parametrize(
    ("exchange", "per_min", "batch"),
    [("kraken", 50.0, 40), ("coinbase", 300.0, 50), ("binance", 300.0, 20)],
)
def test_budget_and_costs_follow_the_exchange(
    monkeypatch: pytest.MonkeyPatch, exchange: str, per_min: float, batch: int
) -> None:
    for name in ("UPSTREAM_RATE_PER_MIN", "UPSTREAM_BURST"):
        monkeypatch.delenv(name, raising=False)  # conftest's permissive guard
    cfg = config(exchange)
    defaults = apply_setting_defaults(SPEC, Settings(_env_file=None), cfg)  # type: ignore[call-arg]
    assert (defaults.upstream_rate_per_min, defaults.upstream_burst) == (per_min, 10)
    pinned = apply_setting_defaults(
        SPEC,
        Settings(upstream_rate_per_min=7, _env_file=None),  # type: ignore[call-arg]
        cfg,
    )
    assert pinned.upstream_rate_per_min == 7
    costs = SPEC.costs(cfg)
    assert costs.quote_batch == batch and costs.history == 1
    assert (costs.symbol_info, costs.search, costs.events) == (
        0,
        0,
        0,
    )  # the list is charged inside
    assert costs.quotes(batch) == 1 and costs.quotes(batch + 1) == 2


def test_capabilities_state_what_the_exchanges_serve() -> None:
    caps = SPEC.capabilities(None)
    assert caps == crypto.capabilities_for(config("binance"))  # the same on every exchange
    assert caps.intervals == INTERVALS and "5d" not in caps.intervals
    assert caps.markets == {"crypto"} and caps.streaming and caps.search
    assert not (caps.extended_history or caps.extended_quotes or caps.adjusted_close)
    assert not (caps.events or caps.news or caps.fundamentals_info or caps.fundamentals_statements)


NATIVE = {"1m", "5m", "15m", "30m", "60m", "1d"}
SYNTH_FROM_DAILY = {"2m": "1m", "90m": "30m", "1wk": "1d", "1mo": "1d", "3mo": "1d"}


@pytest.mark.parametrize(
    ("exchange", "native", "synth"),
    [
        ("kraken", NATIVE, SYNTH_FROM_DAILY),
        ("coinbase", NATIVE, SYNTH_FROM_DAILY),
        # Binance has weekly and monthly bars itself (Mondays, the first of the month).
        ("binance", NATIVE | {"1wk", "1mo"}, {"2m": "1m", "90m": "30m", "3mo": "1mo"}),
    ],
)
def test_every_interval_is_native_or_built_from_a_finer_one(
    exchange: str, native: set[str], synth: dict[str, str]
) -> None:
    table = crypto.EXCHANGES[exchange].native
    assert set(table) == native
    for interval in INTERVALS:
        plan = plan_interval(table, interval)
        assert plan is not None, interval
        source, built = plan
        if interval in native:
            assert (source, built) == (interval, None)
        else:
            assert built is not None and source == synth[interval], interval
    assert plan_interval(table, "5d") is None


# -- symbols -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("symbol", "pair"),
    [
        ("BTC-USD", ("BTC", "USD")),
        ("btc-usd", ("BTC", "USD")),
        ("ETH-USDT", ("ETH", "USDT")),
        ("ETH-BTC", ("ETH", "BTC")),
        ("ETH/BTC", ("ETH", "BTC")),
        ("XBT-USD", ("BTC", "USD")),
        ("XDG-USD", ("DOGE", "USD")),
        ("1INCH-USD", ("1INCH", "USD")),
    ],
)
def test_parse_symbol_reads_crypto_pairs(symbol: str, pair: tuple[str, str]) -> None:
    assert parse_symbol(symbol) == pair
    assert canonical_symbol(symbol) == f"{pair[0]}-{pair[1]}"


@pytest.mark.parametrize(
    "symbol",
    ["AAPL", "BRK-B", "BF-B", "VOD.L", "^GSPC", "EURUSD=X", "GC=F", "", "BTC", "A-B-USD", "ES-123"],
)
def test_parse_symbol_refuses_what_is_no_pair(symbol: str) -> None:
    assert parse_symbol(symbol) is None and canonical_symbol(symbol) is None


def test_decimals_of_a_price_step() -> None:
    assert [decimals(s) for s in (0.01, 0.1, 1.0, 0.0000001, 1e-06, None, 0)] == [
        2,
        1,
        0,
        7,
        6,
        2,
        2,
    ]


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_symbol_routing_answers_what_is_no_pair_locally(exchange: str) -> None:
    provider, fake = make(exchange)
    routing = as_symbol_routing(provider)
    assert routing is not None
    assert routing.billable(["btc-usd", "BTC-USD", "AAPL", "^GSPC", "eth-btc"]) == [
        "BTC-USD",
        "ETH-BTC",
    ]
    for op in ("history", "symbol_info"):
        assert routing.answers_locally(op, "AAPL") and routing.answers_locally(op, "VOD.L")
        assert not routing.answers_locally(op, "BTC-USD")  # the list is not loaded yet
    for op in ("events", "fundamentals", "news"):
        assert routing.answers_locally(op, "BTC-USD")
    assert fake.calls == []


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_unlisted_pairs_are_answered_locally_once_the_markets_are_cached(exchange: str) -> None:
    provider, fake = make(exchange)
    assert provider.search(SYMBOL[exchange], 1)
    assert provider.answers_locally("history", "ZZZZ-USD")
    assert not provider.answers_locally("history", SYMBOL[exchange])
    with pytest.raises(SymbolNotFound):
        provider.history("ZZZZ-USD", "1d", *(minutes_ago(3000), NOW), False)
    assert fake.count(fake.calls[0][0]) == 1 and len(fake.calls) == 1  # only the markets load


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_guarded_provider_refuses_unsupported_things_without_a_request(exchange: str) -> None:
    provider, fake = make(exchange)
    guarded = GuardedProvider(
        provider,
        UpstreamGuard(),
        costs=crypto.costs_for(config(exchange)),
        capabilities=crypto.capabilities_for(None),
    )
    window = (minutes_ago(3000), NOW)
    for call in (
        lambda: guarded.history("BTC-USD", "5d", *window, False),
        lambda: guarded.history("AAPL", "1d", *window, False),
        lambda: guarded.symbol_info("AAPL"),
        lambda: guarded.events("BTC-USD"),
        lambda: guarded.fundamentals("BTC-USD"),
        lambda: guarded.news("BTC-USD", 3),
        lambda: guarded.extended_quotes(["BTC-USD"]),
        lambda: guarded.quotes(["AAPL", "^GSPC"]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()
    assert fake.calls == []
    assert len(guarded.history(SYMBOL[exchange], "1d", *window, False)) == 2


def test_not_offered_features_raise_unsupported() -> None:
    provider, fake = make()
    for call in (
        lambda: provider.events("BTC-USD"),
        lambda: provider.news("BTC-USD", 3),
        lambda: provider.fundamentals("BTC-USD"),
        lambda: provider.extended_quotes(["BTC-USD"]),
    ):
        with pytest.raises(ProviderUnsupported):
            call()
    assert fake.calls == []


# -- markets, symbol info and search -----------------------------------------------------


def test_kraken_markets_read_asset_pairs_with_the_xbt_and_xdg_aliases() -> None:
    provider, fake = make("kraken")
    markets = provider._markets()
    assert set(markets) == {"BTC-USD", "ETH-USD", "ETH-BTC", "DOGE-USD", "BTC-USDT", "ADA-USD"}
    btc = markets["BTC-USD"]
    assert (btc.id, btc.base, btc.quote, btc.tick) == ("XBTUSD", "BTC", "USD", 0.1)
    assert btc.aliases == ("XXBTZUSD", "XBTUSD")  # the answer key and the request name
    assert markets["DOGE-USD"].id == "XDGUSD" and markets["ETH-BTC"].id == "ETHXBT"
    assert fake.paths() == ["/0/public/AssetPairs"]


def test_coinbase_markets_skip_delisted_products() -> None:
    provider, fake = make("coinbase")
    markets = provider._markets()
    assert set(markets) == {"BTC-USD", "ETH-USD", "ETH-BTC", "BTC-USDT"}  # DAI-USD is delisted
    assert markets["BTC-USD"].name == "Bitcoin / US Dollar" and markets["BTC-USD"].tick == 0.01
    assert fake.calls == [("/api/v3/brokerage/market/products", {"product_type": "SPOT"})]


def test_binance_markets_skip_what_is_not_trading() -> None:
    provider, fake = make("binance")
    markets = provider._markets()
    assert set(markets) == {"ETH-BTC", "BTC-USDT", "ETH-USDT", "BTC-USDC"}  # LUNAUSDT: BREAK
    assert markets["ETH-BTC"].id == "ETHBTC" and markets["ETH-BTC"].tick == 0.00001
    assert fake.paths() == ["/api/v3/exchangeInfo"]


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_symbol_info(exchange: str) -> None:
    provider, _ = make(exchange)
    info = provider.symbol_info("eth-btc")
    assert info["symbol"] == "ETH-BTC" and info["exchange"] == provider.exchange.name
    assert info["type"] == "cryptocurrency" and info["currency"] == "BTC"
    assert (info["timezone"], info["session"], info["hasIntraday"]) == ("UTC", "0000-2359", True)
    assert info["priceHint"] in (5, 6) and info["minTick"] == 10.0 ** -info["priceHint"]
    with pytest.raises(SymbolNotFound):
        provider.symbol_info("ZZZZ-USD")
    with pytest.raises(ProviderUnsupported):
        provider.symbol_info("AAPL")


def test_kraken_symbol_info_accepts_its_own_names() -> None:
    provider, _ = make("kraken")
    assert provider.symbol_info("XBT-USD")["symbol"] == "XBT-USD"
    assert provider.symbol_info("XDG-USD")["name"] == "DOGE / USD"


def test_search_ranks_exact_then_prefix_then_name_and_prefers_dollar_quotes() -> None:
    provider, _ = make("coinbase")
    assert [r["symbol"] for r in provider.search("btc", 10)] == [
        "BTC-USD",
        "BTC-USDT",
        "ETH-BTC",  # only "Bitcoin" in the name
    ]
    assert provider.search("btc-usdt", 1)[0] == {
        "symbol": "BTC-USDT",
        "name": "Bitcoin / Tether",
        "exchange": "Coinbase",
        "type": "cryptocurrency",
        "typeDisplay": "Crypto",
    }
    assert [r["symbol"] for r in provider.search("BTCUSD", 3)][:1] == ["BTC-USD"]
    assert [r["symbol"] for r in provider.search("ethereum", 5)] == ["ETH-USD", "ETH-BTC"]
    assert provider.search("btc", 1) == provider.search("btc", 10)[:1]
    assert provider.search("", 5) == [] and provider.search("btc", 0) == []
    assert provider.search("nothing-like-this", 5) == []


def test_kraken_search_understands_xbt() -> None:
    provider, _ = make("kraken")
    assert provider.search("xbt", 3)[0]["symbol"] == "BTC-USD"
    assert provider.search("XBT-USD", 3)[0]["symbol"] == "BTC-USD"


def test_markets_are_cached_for_a_day_and_each_load_is_charged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = [1000.0]
    monkeypatch.setattr(crypto, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    provider, fake = make()
    meter = Meter()
    with metering(meter):
        provider.search("BTC", 3)
        provider.symbol_info("BTC-USD")
        assert fake.count("/0/public/AssetPairs") == 1 and meter.charges == [1]
        now[0] += crypto.MARKETS_TTL_S - 1
        provider.search("BTC", 3)
        assert fake.count("/0/public/AssetPairs") == 1
        now[0] += 2
        provider.search("BTC", 3)
        assert fake.count("/0/public/AssetPairs") == 2 and meter.total == 2


def test_a_failing_markets_refresh_keeps_serving_the_old_list(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    now = [1000.0]
    monkeypatch.setattr(crypto, "time", types.SimpleNamespace(monotonic=lambda: now[0]))
    provider, fake = make()
    assert provider.search("BTC", 3)
    fake.answers["/0/public/AssetPairs"] = lambda params: (503, {}, {})
    now[0] += crypto.MARKETS_TTL_S + 1
    with caplog.at_level("WARNING", logger="tickerglass_api.providers.crypto"):
        assert provider.search("BTC", 3)  # stale but served
    assert "keeping the old list" in caplog.text
    assert fake.count("/0/public/AssetPairs") == 2
    provider.search("BTC", 3)  # the retry waits a while
    assert fake.count("/0/public/AssetPairs") == 2
    now[0] += crypto.MARKETS_RETRY_S + 1
    provider.search("BTC", 3)
    assert fake.count("/0/public/AssetPairs") == 3
    # Without an old list the failure surfaces.
    fresh, _ = make(fake=fake)
    with pytest.raises(UpstreamUnavailable):
        fresh.search("BTC", 3)


# -- history -----------------------------------------------------------------------------


def history(
    provider: crypto.CryptoProvider,
    symbol: str,
    interval: str,
    start: datetime | None,
    end: datetime | None = NOW,
) -> pd.DataFrame:
    return provider.history(symbol, interval, start, end, False)


@pytest.mark.parametrize("exchange", EXCHANGES)
@pytest.mark.parametrize("interval", sorted(INTERVALS))
def test_every_interval_returns_aligned_bars(exchange: str, interval: str) -> None:
    provider, _ = make(exchange)
    start = {
        "1m": minutes_ago(600),
        "2m": minutes_ago(600),
        "5m": minutes_ago(2000),
        "15m": minutes_ago(6000),
        "30m": minutes_ago(12000),
        "60m": minutes_ago(24000),
        "90m": minutes_ago(24000),
    }.get(interval, NOW - timedelta(days=400))
    df = history(provider, SYMBOL[exchange], interval, start)
    assert list(df.columns) == BAR_COLUMNS and not df.empty
    assert df["ts"].dtype == "int64" and df["ts"].is_monotonic_increasing
    assert df["ts"].is_unique and (df["adj_close"] == df["close"]).all()
    assert (df["high"] >= df["low"]).all() and (df["volume"] > 0).all()
    ts = df["ts"]
    assert ts.iloc[0] >= start.timestamp() and ts.iloc[-1] < NOW.timestamp()
    seconds = {"1m": 60, "2m": 120, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "90m": 5400}
    if interval in seconds:
        assert (ts % seconds[interval] == 0).all()
    if interval == "1d":
        assert (ts % 86400 == 0).all()
    if interval == "1wk":
        assert (utc_series(ts).dt.weekday == 0).all() and (ts % 86400 == 0).all()
    if interval in ("1mo", "3mo"):
        days = utc_series(ts)
        assert (days.dt.day == 1).all() and (ts % 86400 == 0).all()
    if interval == "3mo":
        assert set(utc_series(ts).dt.month) <= {1, 4, 7, 10}


def utc_series(ts: pd.Series) -> pd.Series:
    return pd.Series(pd.to_datetime(ts, unit="s", utc=True))


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_history_of_a_range_without_bars_is_empty(exchange: str) -> None:
    provider, _ = make(exchange)
    far = NOW + timedelta(days=30)
    df = history(provider, SYMBOL[exchange], "1d", far, far + timedelta(days=5))
    assert df.empty and list(df.columns) == BAR_COLUMNS


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_unknown_and_unsupported_symbols(exchange: str) -> None:
    provider, fake = make(exchange)
    with pytest.raises(SymbolNotFound):
        history(provider, "ZZZZ-USD", "1d", minutes_ago(3000))
    with pytest.raises(ProviderUnsupported):
        history(provider, "AAPL", "1d", minutes_ago(3000))
    with pytest.raises(ProviderUnsupported):
        history(provider, SYMBOL[exchange], "5d", minutes_ago(3000))
    assert len(fake.calls) == 1  # the markets load; no bars were asked for


def test_kraken_request_and_fixture_rows() -> None:
    now = utc(1794940000)
    provider, fake = make("kraken", now=now)
    fake.answers["/0/public/OHLC"] = lambda params: (200, {}, fixture("kraken_ohlc_1h"))
    df = history(provider, "BTC-USD", "60m", utc(1794924000), None)
    assert fake.calls[1] == (
        "/0/public/OHLC",
        {"pair": "XBTUSD", "interval": "60", "since": "1794923999"},
    )
    assert df["ts"].tolist() == [1794924000, 1794927600, 1794931200, 1794934800, 1794938400]
    first = df.iloc[0]
    assert (first["open"], first["high"], first["low"], first["close"]) == (
        65081.2,
        65378.7,
        64736.1,
        64954.2,
    )
    assert first["volume"] == 191.55892845 and first["adj_close"] == first["close"]
    # The bar still forming (the last row) is served; `end` cuts it off.
    assert len(history(provider, "BTC-USD", "60m", utc(1794924000), utc(1794938400))) == 4


def test_kraken_since_is_left_out_without_a_start_and_aliases_resolve() -> None:
    provider, fake = make("kraken")
    history(provider, "XBT-USD", "1d", None)
    assert fake.calls[1][1] == {"pair": "XBTUSD", "interval": "1440"}
    history(provider, "DOGE-USD", "5m", minutes_ago(100))
    assert fake.calls[2][1]["pair"] == "XDGUSD" and fake.calls[2][1]["interval"] == "5"


def test_kraken_keeps_720_bars_per_interval_and_never_pages() -> None:
    provider, fake = make("kraken")
    meter = Meter()
    with metering(meter):
        daily = history(provider, "BTC-USD", "1d", None, None)
        minutes = history(provider, "BTC-USD", "1m", None, None)
        hourly = history(provider, "BTC-USD", "60m", NOW - timedelta(days=500), None)
    assert len(daily) == 720 and daily["ts"].iloc[0] == int((NOW - timedelta(days=719)).timestamp())
    assert len(minutes) == 720 and len(hourly) == 720  # 12 hours, 30 days
    assert fake.count("/0/public/OHLC") == 3 and meter.charges == [1]  # the markets load only
    # Weeks and months are built from the 720 daily bars (about two years).
    weeks = history(provider, "BTC-USD", "1wk", None, None)
    assert 100 <= len(weeks) <= 104
    assert 23 <= len(history(provider, "BTC-USD", "1mo", None, None)) <= 25


def test_coinbase_pages_back_in_windows_of_300_bars_and_charges_each_further_one() -> None:
    provider, fake = make("coinbase")
    provider._markets()
    meter = Meter()
    with metering(meter):
        df = history(provider, "BTC-USD", "1m", minutes_ago(1000))
    pages = [p for path, p in fake.calls if path.endswith("/candles")]
    assert len(pages) == 4 and meter.charges == [1, 1, 1]
    assert all(p["granularity"] == "ONE_MINUTE" for p in pages)
    assert [int(p["end"]) for p in pages] == [
        int(NOW.timestamp()) - 300 * 60 * i for i in range(4)
    ]  # each page ends where the newer one began
    assert all(int(p["end"]) - int(p["start"]) <= 300 * 60 for p in pages)
    assert int(pages[-1]["start"]) == int(minutes_ago(1000).timestamp())  # bounded by `start`
    assert len(df) == 1000 and df["ts"].is_unique  # the overlapping candles are deduplicated


def test_coinbase_without_a_start_walks_back_to_the_first_candle() -> None:
    provider, fake = make(
        "coinbase", fake=FakeCoinbase(NOW, listed_since=NOW - timedelta(days=700))
    )
    df = history(provider, "BTC-USD", "1d", None)
    assert len(df) == 700 and df["ts"].iloc[0] == int((NOW - timedelta(days=700)).timestamp())
    # 300 + 300 + 100 bars, then the empty window before the listing ends the walk.
    assert fake.count("/api/v3/brokerage/market/products/BTC-USD/candles") == 4


def test_coinbase_page_limit_keeps_the_newest_bars() -> None:
    provider, fake = make("coinbase", max_pages=2)
    df = history(provider, "BTC-USD", "1m", minutes_ago(1000))
    assert fake.count("/api/v3/brokerage/market/products/BTC-USD/candles") == 2
    assert len(df) == 600 and df["ts"].iloc[-1] == int(minutes_ago(1).timestamp())


@pytest.mark.parametrize("exchange", ["coinbase", "binance"])
def test_a_refused_page_charge_serves_what_was_fetched(exchange: str) -> None:
    provider, fake = make(exchange)
    provider._markets()
    with metering(Meter(refuse_after=0)):
        df = history(provider, SYMBOL[exchange], "1m", minutes_ago(2500))
    candles = [p for p in fake.paths() if p.endswith(("/candles", "/klines"))]
    assert len(candles) == 1 and 0 < len(df) <= 1000
    assert df["ts"].iloc[-1] == int(minutes_ago(1).timestamp())  # the newest part


def test_binance_pages_back_with_end_time_only() -> None:
    provider, fake = make("binance")
    provider._markets()
    meter = Meter()
    with metering(meter):
        df = history(provider, "BTC-USDT", "1m", minutes_ago(2500))
    pages = [p for path, p in fake.calls if path == "/api/v3/klines"]
    assert len(pages) == 3 and meter.charges == [1, 1] and len(df) == 2500
    assert all(p["symbol"] == "BTCUSDT" and p["interval"] == "1m" for p in pages)
    assert all("startTime" not in p for p in pages)  # with one, Binance would answer forwards
    assert [p["limit"] for p in pages] == ["1000", "1000", "502"]
    assert pages[0]["endTime"] == str(int(NOW.timestamp() * 1000) - 1)
    oldest = int(minutes_ago(1000).timestamp()) * 1000  # the next page ends before it
    assert pages[1]["endTime"] == str(oldest - 1)
    assert df["ts"].is_unique and df["ts"].iloc[0] == int(minutes_ago(2500).timestamp())


@pytest.mark.parametrize("exchange", ["coinbase", "binance"])
def test_a_300_bar_range_costs_one_request_and_a_deep_one_stops_at_max_pages(
    exchange: str,
) -> None:
    # Paging stops at `start`: the 9 requests a first chart load costs on Coinbase and Binance
    # are the bar service's backfill of the whole lookback (730 days of hourly bars), cut short
    # by `max_pages` (burst - 1), not paging past what was asked for.
    provider, fake = make(exchange, max_pages=9)
    provider._markets()
    symbol = SYMBOL[exchange]
    df = history(provider, symbol, "60m", NOW - timedelta(hours=300))
    paths = [p for p in fake.paths() if p.endswith(("/candles", "/klines"))]
    assert len(paths) == 1 and len(df) == 300
    fake.calls.clear()
    history(provider, symbol, "60m", NOW - timedelta(days=729))
    paths = [p for p in fake.paths() if p.endswith(("/candles", "/klines"))]
    assert len(paths) == 9


def test_binance_without_a_start_stops_at_the_first_bar() -> None:
    provider, fake = make("binance", fake=FakeBinance(NOW, listed_since=minutes_ago(1500)))
    df = history(provider, "BTC-USDT", "1m", None)
    assert len(df) == 1500 and fake.count("/api/v3/klines") == 2  # a full page, then a short one


def test_binance_weekly_monthly_and_quarterly_bars_use_its_own_intervals() -> None:
    provider, fake = make("binance")
    start = NOW - timedelta(days=400)
    weekly = history(provider, "BTC-USDT", "1wk", start)
    monthly = history(provider, "BTC-USDT", "1mo", start)
    quarterly = history(provider, "BTC-USDT", "3mo", start)
    kinds = [p["interval"] for path, p in fake.calls if path == "/api/v3/klines"]
    assert kinds == ["1w", "1M", "1M"]  # 3mo is built from the monthly bars
    assert (utc_series(weekly["ts"]).dt.weekday == 0).all()
    assert len(quarterly) < len(monthly) and set(utc_series(quarterly["ts"]).dt.month) <= {
        1,
        4,
        7,
        10,
    }


@pytest.mark.parametrize("exchange", ["kraken", "coinbase"])
def test_weeks_months_and_quarters_are_built_from_daily_bars(exchange: str) -> None:
    provider, fake = make(exchange)
    start = NOW - timedelta(days=200)
    daily = history(provider, "BTC-USD", "1d", start)
    weekly = history(provider, "BTC-USD", "1wk", start)
    monthly = history(provider, "BTC-USD", "1mo", start)
    # Monday weeks: a bucket sums its seven daily bars (the volumes are 10 each).
    inner = weekly.iloc[1:-1]  # the ends may be partial weeks
    assert (inner["volume"] == 70).all() and (utc_series(weekly["ts"]).dt.weekday == 0).all()
    assert weekly["high"].max() == daily["high"].max()
    assert (
        monthly["volume"].iloc[1]
        == 10 * pd.Timestamp(utc(int(monthly["ts"].iloc[1]))).days_in_month
    )
    kinds = {
        p.get("interval") or p.get("granularity")
        for path, p in fake.calls
        if "OHLC" in path or "candles" in path
    }
    assert kinds <= {"1440", "ONE_DAY"}


def test_a_synthesized_bucket_is_built_from_all_its_source_bars() -> None:
    provider, _ = make("coinbase")
    start = datetime(2026, 10, 27, 0, 50, tzinfo=UTC)  # inside the 00:00 - 01:30 bucket
    df = history(provider, "BTC-USD", "90m", start, datetime(2026, 10, 27, 6, tzinfo=UTC))
    assert utc(int(df["ts"].iloc[0])) == datetime(2026, 10, 27, 1, 30, tzinfo=UTC)
    assert (df["volume"] == 30).all()  # three 30-minute bars each
    two = history(provider, "BTC-USD", "2m", start, datetime(2026, 10, 27, 1, tzinfo=UTC))
    assert utc(int(two["ts"].iloc[0])) == datetime(2026, 10, 27, 0, 50, tzinfo=UTC)
    assert (two["volume"] == 20).all()


def test_align_start() -> None:
    moment = datetime(2026, 10, 28, 13, 37, 12, tzinfo=UTC)  # a Wednesday
    assert align_start(moment, "epoch", 90) == datetime(2026, 10, 28, 13, 30, tzinfo=UTC)
    assert align_start(moment, "epoch", 2) == datetime(2026, 10, 28, 13, 36, tzinfo=UTC)
    assert align_start(moment, "week", 1) == datetime(2026, 10, 26, tzinfo=UTC)
    assert align_start(moment, "quarter", 1) == datetime(2026, 10, 1, tzinfo=UTC)
    assert align_start(datetime(2026, 8, 31, 23, tzinfo=UTC), "quarter", 3) == datetime(
        2026, 7, 1, tzinfo=UTC
    )


def test_the_clock_bounds_a_future_end() -> None:
    provider, fake = make("coinbase")
    history(provider, "BTC-USD", "60m", NOW - timedelta(hours=5), NOW + timedelta(days=9))
    candles = [p for path, p in fake.calls if path.endswith("/candles")]
    assert int(candles[0]["end"]) == int(NOW.timestamp())


# -- errors ------------------------------------------------------------------------------


def failing(exchange: str, status: int, body: Any = None, **head: str) -> FakeExchange:
    fake = FAKES[exchange](NOW)
    answer: Answer = (status, dict(head), body if body is not None else {"message": "boom"})
    for path in ("/0/public/OHLC", "/api/v3/klines"):
        fake.answers[path] = lambda params: answer
    fake.answers[f"/api/v3/brokerage/market/products/{SYMBOL['coinbase']}/candles"] = (
        lambda params: answer
    )
    return fake


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_rate_limits_and_outages_map_to_the_provider_errors(exchange: str) -> None:
    provider, _ = make(exchange, fake=failing(exchange, 429, **{"retry-after": "7"}))
    with pytest.raises(RateLimited) as limited:
        history(provider, SYMBOL[exchange], "1d", minutes_ago(3000))
    assert limited.value.retry_after == 7 and not limited.value.daily
    provider, _ = make(exchange, fake=failing(exchange, 503))
    with pytest.raises(UpstreamUnavailable):
        history(provider, SYMBOL[exchange], "1d", minutes_ago(3000))

    def down(url: str, headers: Mapping[str, str], timeout: float) -> Any:
        raise ConnectionResetError("reset")

    broken = crypto.CryptoProvider(config(exchange), send=down)
    with pytest.raises(UpstreamUnavailable):
        broken.search("BTC", 3)


@pytest.mark.parametrize("status", [401, 403, 451])
@pytest.mark.parametrize("exchange", EXCHANGES)
def test_a_refusing_network_names_the_settings(exchange: str, status: int) -> None:
    provider, _ = make(exchange, fake=failing(exchange, status))
    with pytest.raises(ProviderNotConfigured, match="CRYPTO_EXCHANGE") as info:
        history(provider, SYMBOL[exchange], "1d", minutes_ago(3000))
    assert "CRYPTO_BASE_URL" in str(info.value)


def test_kraken_reports_its_errors_inside_a_200_answer() -> None:
    def answer(errors: list[str]) -> FakeKraken:
        fake = FakeKraken(NOW)
        fake.answers["/0/public/OHLC"] = lambda params: (200, {}, {"error": errors, "result": {}})
        return fake

    def attempt(errors: list[str]) -> None:
        history(make("kraken", fake=answer(errors))[0], "BTC-USD", "1d", minutes_ago(3000))

    with pytest.raises(SymbolNotFound):
        attempt(["EQuery:Unknown asset pair"])
    with pytest.raises(RateLimited) as limited:
        attempt(["EAPI:Rate limit exceeded"])
    assert limited.value.retry_after == 60
    with pytest.raises(RateLimited):
        attempt(["EService:Throttled: 1794940000"])
    with pytest.raises(UpstreamUnavailable):
        attempt(["EService:Unavailable"])
    with pytest.raises(ProviderError, match="EGeneral:Invalid arguments") as other:
        attempt(["EGeneral:Invalid arguments"])
    assert not isinstance(other.value, (RateLimited, UpstreamUnavailable, SymbolNotFound))
    fake = FakeKraken(NOW)
    fake.answers["/0/public/OHLC"] = lambda params: (200, {}, ["not", "an", "object"])
    with pytest.raises(ProviderError, match="unexpected payload"):
        history(make("kraken", fake=fake)[0], "BTC-USD", "1d", minutes_ago(3000))


def test_coinbase_and_binance_symbol_errors() -> None:
    coinbase = FakeCoinbase(NOW)
    coinbase.answers["/api/v3/brokerage/market/products/BTC-USD/candles"] = lambda params: (
        400,
        {},
        fixture("coinbase_error_product"),
    )
    with pytest.raises(SymbolNotFound):
        history(make("coinbase", fake=coinbase)[0], "BTC-USD", "1d", minutes_ago(3000))
    coinbase.answers["/api/v3/brokerage/market/products/BTC-USD/candles"] = lambda params: (
        400,
        {},
        {"message": "granularity is invalid"},
    )
    with pytest.raises(ProviderError, match="granularity is invalid") as bad:
        history(make("coinbase", fake=coinbase)[0], "BTC-USD", "1d", minutes_ago(3000))
    assert not isinstance(bad.value, SymbolNotFound)
    binance = FakeBinance(NOW)
    binance.answers["/api/v3/klines"] = lambda params: (400, {}, fixture("binance_error_symbol"))
    with pytest.raises(SymbolNotFound):
        history(make("binance", fake=binance)[0], "BTC-USDT", "1d", minutes_ago(3000))


def test_a_binance_ip_ban_is_a_rate_limit_until_the_ban_ends(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "tickerglass_api.providers.crypto.binance.time",
        types.SimpleNamespace(time=lambda: 1794940000.0),
    )
    banned = {
        "code": -1003,
        "msg": "Way too many requests; IP banned until 1794940180000. Please use WebSocket",
    }
    provider, _ = make("binance", fake=failing("binance", 418, banned))
    with pytest.raises(RateLimited) as limited:
        history(provider, "BTC-USDT", "1d", minutes_ago(3000))
    assert limited.value.retry_after == 180
    provider, _ = make("binance", fake=failing("binance", 418, {"msg": "banned"}))
    with pytest.raises(RateLimited) as unknown:
        history(provider, "BTC-USDT", "1d", minutes_ago(3000))
    assert unknown.value.retry_after == 120


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_every_request_counts_in_the_upstream_metrics(exchange: str) -> None:
    before = upstream.snapshot().get(("crypto", "ok"), 0)
    provider, fake = make(exchange)
    history(provider, SYMBOL[exchange], "1d", minutes_ago(3000))
    provider.quotes([SYMBOL[exchange]])
    after = upstream.snapshot().get(("crypto", "ok"), 0)
    assert after - before == len(fake.calls) == 3  # markets, bars, quotes
    rate_before = upstream.snapshot().get(("crypto", "rate_limited"), 0)
    with pytest.raises(RateLimited):
        history(make(exchange, fake=failing(exchange, 429))[0], SYMBOL[exchange], "1d", None)
    assert upstream.snapshot().get(("crypto", "rate_limited"), 0) == rate_before + 1


def test_endpoints_can_be_overridden() -> None:
    fake = FakeKraken(NOW)
    fake.answers["/kraken/0/public/AssetPairs"] = lambda params: (
        200,
        {},
        fixture("kraken_assetpairs"),
    )
    provider = crypto.CryptoProvider(
        config("kraken", base_url="https://mirror.test/kraken/"), send=fake
    )
    provider.search("BTC", 1)
    assert fake.urls == ["https://mirror.test/kraken/0/public/AssetPairs"]
    with pytest.raises(ValueError, match="http"):
        crypto.CryptoProvider(config("kraken", base_url="ftp://nope"), send=fake)


def test_endpoint_overrides_must_be_secure_unless_they_are_local() -> None:
    for bad in ("http://mirror.test", "mirror.test", "ftp://x.test"):
        with pytest.raises(ValidationError, match="CRYPTO_BASE_URL"):
            config(base_url=bad)
    for bad in ("ws://proxy.test/ws", "https://proxy.test/ws", "proxy.test"):
        with pytest.raises(ValidationError, match="CRYPTO_STREAM_URL"):
            config(stream_url=bad)
    assert config(base_url="https://mirror.test", stream_url="wss://proxy.test/ws")
    assert config(base_url="http://127.0.0.1:9", stream_url="ws://localhost:9/ws")
    assert config().base_url is None and config().stream_url is None


def test_bars_with_a_non_positive_price_are_dropped() -> None:
    from tickerglass_api.providers.crypto.base import bars_frame

    frame = bars_frame(
        [
            (60, 1.0, 2.0, 0.5, 1.5, 3.0),
            (120, 1.0, 2.0, 0.0, 1.5, 3.0),  # a zero low
            (180, -1.0, 2.0, 0.5, 1.5, 3.0),
            (240, 1.0, 2.0, 0.5, 1.5, 0.0),  # no volume is fine
        ]
    )
    assert frame["ts"].tolist() == [60, 240]
    assert bars_frame([(60, 0.0, 0.0, 0.0, 0.0, 1.0)]).empty


def test_quotes_with_a_non_positive_last_price_are_left_out() -> None:
    provider, fake = make("binance")
    rows = [dict(r) for r in fixture("binance_ticker24h")[:2]]
    rows[0]["lastPrice"] = "0.00000000"
    fake.answers["/api/v3/ticker/24hr"] = lambda params: (200, {}, rows)
    answer = provider.quotes(["BTC-USDT", "ETH-USDT"])
    assert [r["symbol"] for r in answer] == ["ETH-USDT"]
    assert isinstance(answer, QuoteList) and not answer.confirmed


# -- quotes ------------------------------------------------------------------------------


def test_kraken_quotes_measure_from_the_utc_open_and_cover_24_hours() -> None:
    provider, fake = make("kraken")
    rows = provider.quotes(["BTC-USD", "ETH-USD", "ZZZZ-USD"])
    assert fake.calls[1] == ("/0/public/Ticker", {"pair": "XBTUSD,ETHUSD"})  # only listed pairs
    by = {r["symbol"]: r for r in rows}
    assert set(by) == {"BTC-USD", "ETH-USD"}
    btc = by["BTC-USD"]
    assert btc["last"] == 63785.8 and btc["prevClose"] == btc["open"] == 64813.7
    assert btc["change"] == pytest.approx(63785.8 - 64813.7)
    assert btc["changePercent"] == pytest.approx(-1.5859, abs=1e-4)
    assert (btc["dayHigh"], btc["dayLow"], btc["volume"]) == (65471.3, 63272.3, 4492)  # 24 hours
    assert btc["currency"] == "USD" and btc["marketState"] == "REGULAR"
    assert btc["time"] == int(NOW.timestamp())
    assert isinstance(rows, QuoteList) and rows.confirmed  # the unlisted pair provably is absent


def test_coinbase_quotes_batch_product_ids_in_one_request() -> None:
    provider, fake = make("coinbase")
    rows = provider.quotes(["BTC-USD", "ETH-USD", "ZZZZ-USD"])
    assert fake.urls[1].endswith("/market/products?product_ids=BTC-USD&product_ids=ETH-USD")
    assert len(fake.calls) == 2 and "?" not in fake.calls[1][0]  # the query is not a path
    btc = {r["symbol"]: r for r in rows}["BTC-USD"]
    assert btc["last"] == 63876.7 and btc["volume"] == 12620
    # The 24-hour reference follows from the percentage change.
    assert btc["open"] == pytest.approx(63876.7 / (1 - 0.0152777043377346))
    assert btc["changePercent"] == pytest.approx(-1.52777043377346)
    assert (btc["dayHigh"], btc["dayLow"]) == (65476.38, 63256.75)
    assert isinstance(rows, QuoteList) and rows.confirmed


def test_binance_quotes_ask_for_a_json_list_of_symbols() -> None:
    provider, fake = make("binance")
    rows = provider.quotes(["BTC-USDT", "ETH-USDT", "BTC-USD"])
    assert fake.calls[1] == ("/api/v3/ticker/24hr", {"symbols": '["BTCUSDT","ETHUSDT"]'})
    btc = {r["symbol"]: r for r in rows}["BTC-USDT"]
    assert btc["last"] == 64027.83 and btc["prevClose"] == 64921.33
    assert btc["change"] == pytest.approx(-893.5) and btc["currency"] == "USDT"
    assert btc["time"] == 1794939912  # the exchange's own stamp
    assert (btc["dayHigh"], btc["dayLow"], btc["volume"]) == (65534.94, 63336.0, 28665)
    assert isinstance(rows, QuoteList) and rows.confirmed


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_quotes_leave_out_what_is_no_pair_and_are_then_not_confirmed(exchange: str) -> None:
    provider, fake = make(exchange)
    rows = provider.quotes([SYMBOL[exchange].lower(), "AAPL", SYMBOL[exchange]])
    assert [r["symbol"] for r in rows] == [SYMBOL[exchange]]  # lower case and duplicate merged
    assert isinstance(rows, QuoteList) and not rows.confirmed
    assert len(fake.calls) == 2


@pytest.mark.parametrize("exchange", EXCHANGES)
def test_quotes_of_nothing_servable_raise_unsupported_without_a_request(exchange: str) -> None:
    provider, fake = make(exchange)
    with pytest.raises(ProviderUnsupported):
        provider.quotes(["AAPL", "^GSPC", "BRK-B"])
    assert provider.quotes([]) == [] and fake.calls == []


def test_quotes_of_unlisted_pairs_are_empty_and_confirmed() -> None:
    provider, fake = make("coinbase")
    rows = provider.quotes(["ZZZZ-USD"])
    assert rows == [] and isinstance(rows, QuoteList) and rows.confirmed
    assert fake.paths() == ["/api/v3/brokerage/market/products"]  # no ticker request


def test_kraken_spellings_of_one_pair_share_a_request_and_each_get_a_row() -> None:
    provider, fake = make("kraken")
    rows = provider.quotes(["XBT-USD", "BTC-USD"])
    assert fake.calls[1][1] == {"pair": "XBTUSD"}
    assert [r["symbol"] for r in rows] == ["XBT-USD", "BTC-USD"]
    assert rows[0]["last"] == rows[1]["last"]


def test_a_pair_the_exchange_lists_but_does_not_answer_is_not_confirmed_absent() -> None:
    provider, fake = make("binance")
    fake.answers["/api/v3/ticker/24hr"] = lambda params: (200, {}, fixture("binance_ticker24h")[:1])
    rows = provider.quotes(["BTC-USDT", "ETH-USDT"])
    assert [r["symbol"] for r in rows] == ["BTC-USDT"]
    assert isinstance(rows, QuoteList) and not rows.confirmed


def test_quotes_are_chunked_and_a_failed_chunk_is_a_partial_answer() -> None:
    provider, fake = make("binance")
    provider.exchange.quote_batch = 1  # type: ignore[misc]

    def answer(params: dict[str, str]) -> Answer:
        if "ETHUSDT" in params["symbols"]:
            return 503, {}, {}
        return 200, {}, fixture("binance_ticker24h")[:1]

    fake.answers["/api/v3/ticker/24hr"] = answer
    meter = Meter()
    with metering(meter), pytest.raises(PartialQuotes) as partial:
        provider.quotes(["BTC-USDT", "ETH-USDT"])
    assert [r["symbol"] for r in partial.value.quotes] == ["BTC-USDT"]
    assert partial.value.failed == ["ETH-USDT"]
    # The guard priced one request (a batch of 20); the markets load and the second chunk are
    # beyond what it paid for.
    assert meter.charges == [1, 1]
    fake.answers["/api/v3/ticker/24hr"] = lambda params: (503, {}, {})
    with pytest.raises(UpstreamUnavailable):
        provider.quotes(["BTC-USDT", "ETH-USDT"])


def test_chunks_the_guard_already_paid_for_are_not_charged_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The guard charges ceil(symbols / batch) requests for a quote call: with a batch of 1 and
    # two symbols that is two, and both chunks are covered (only the markets load is extra).
    monkeypatch.setattr(crypto.Binance, "quote_batch", 1)
    provider, fake = make("binance")
    fake.answers["/api/v3/ticker/24hr"] = lambda params: (
        200,
        {},
        [r for r in fixture("binance_ticker24h") if r["symbol"] in params["symbols"]],
    )
    meter = Meter()
    with metering(meter):
        rows = provider.quotes(["BTC-USDT", "ETH-USDT"])
    assert [r["symbol"] for r in rows] == ["BTC-USDT", "ETH-USDT"]
    assert meter.charges == [1]
    ticker_calls = [p for p in fake.paths() if p == "/api/v3/ticker/24hr"]
    assert len(ticker_calls) == 2


def test_a_refused_extra_chunk_charge_keeps_the_rows_already_fetched() -> None:
    provider, fake = make("binance")
    provider._markets()  # loaded and charged outside the metered call
    provider.exchange.quote_batch = 1  # type: ignore[misc]
    fake.answers["/api/v3/ticker/24hr"] = lambda params: (
        200,
        {},
        [r for r in fixture("binance_ticker24h") if r["symbol"] in params["symbols"]],
    )
    meter = Meter(refuse_after=0)  # no budget for the second request
    with metering(meter), pytest.raises(PartialQuotes) as partial:
        provider.quotes(["BTC-USDT", "ETH-USDT"])
    assert [r["symbol"] for r in partial.value.quotes] == ["BTC-USDT"]
    assert partial.value.failed == ["ETH-USDT"]
    assert len([p for p in fake.paths() if p == "/api/v3/ticker/24hr"]) == 1  # nothing was sent


def test_a_stale_markets_list_serves_when_the_guard_refuses_a_refresh() -> None:
    provider, fake = make("coinbase")
    first = provider._markets()
    assert provider._markets_cache is not None
    provider._markets_cache.expires = 0.0  # a day passed
    calls = len(fake.calls)
    with metering(Meter(refuse_after=0)):
        assert provider._markets() is first  # no budget for the refresh: the old list serves
    assert len(fake.calls) == calls
    # With nothing cached the refusal is raised.
    fresh, _ = make("coinbase")
    with metering(Meter(refuse_after=0)), pytest.raises(RateLimited):
        fresh._markets()


def test_a_rate_limited_quote_request_raises_rate_limited() -> None:
    provider, fake = make("coinbase")
    provider._markets()
    fake.answers["/api/v3/brokerage/market/products"] = lambda params: (
        429,
        {"retry-after": "3"},
        {},
    )
    with pytest.raises(RateLimited) as limited:
        provider.quotes(["BTC-USD"])
    assert limited.value.retry_after == 3


def test_zero_and_missing_references_leave_the_change_out() -> None:
    row = crypto._quote_row(
        "BTC-USD",
        Market("BTC-USD", "BTC", "USD", "x", "x"),
        Ticker(last=10.0, open=0.0, volume=None),
        NOW,
    )
    assert row["prevClose"] is None and row["change"] is None and row["changePercent"] is None
    assert row["volume"] is None and "dayHigh" not in row
