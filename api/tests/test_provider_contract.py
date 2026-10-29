"""Behaviour every `MarketDataProvider` must have, run against each case in
`CONTRACT_PROVIDERS`.

Adding a provider: append a `ContractCase` whose `make` builds it over canned responses (a
fixture-backed fake `send` for HTTP providers; no network in the suite) and whose `now` and
`ranges` fall inside what the canned data covers. Set `unknown_symbol` to a symbol the
provider reports as `SymbolNotFound` (None when it has no such notion, as the demo).
"""

import re
import types
import typing
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from pydantic import SecretStr
from td_fake import FakeTD

from tickerglass_api.intervals import INTERVALS
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    FUNDAMENTALS_INFO_KEYS,
    Capabilities,
    Events,
    ExtendedQuote,
    Fundamentals,
    MarketDataProvider,
    NewsItem,
    ProviderUnsupported,
    Quote,
    SearchResult,
    SymbolInfo,
    SymbolNotFound,
)
from tickerglass_api.providers.demo import DemoProvider
from tickerglass_api.providers.guard import GuardedProvider, UpstreamGuard
from tickerglass_api.providers.twelvedata import (
    TwelveDataConfig,
    TwelveDataProvider,
    capabilities_for,
    effective_profile,
)

NOW = datetime(2026, 6, 17, 15, 0, tzinfo=UTC)  # a Wednesday, US market open
MARKET_STATES = {"PRE", "REGULAR", "POST", "CLOSED", "PREPRE", "POSTPOST"}
INTRADAY = {"1m", "2m", "5m", "15m", "30m", "60m", "90m"}
DEFAULT_DAYS = {"1d": 30, "5d": 60, "1wk": 120, "1mo": 400, "3mo": 800}


@dataclass(frozen=True)
class ContractCase:
    name: str
    make: Callable[[], MarketDataProvider]
    capabilities: Capabilities
    #: A symbol the provider knows, and a query that finds it.
    symbol: str
    query: str
    now: datetime = NOW
    unknown_symbol: str | None = None
    #: Per-interval (start, end) when the default window (5 days of intraday bars, a
    #: longer one for daily and up, ending at `now`) is not covered by the canned data.
    ranges: dict[str, tuple[datetime, datetime]] = field(default_factory=dict)

    def window(self, interval: str) -> tuple[datetime, datetime]:
        if interval in self.ranges:
            return self.ranges[interval]
        days = 5 if interval in INTRADAY else DEFAULT_DAYS[interval]
        return self.now - timedelta(days=days), self.now


DEMO = ContractCase(
    name="demo",
    make=lambda: DemoProvider(clock=lambda: NOW),
    capabilities=Capabilities.full(),
    symbol="GLSS",
    query="glass",
)


def _twelvedata() -> MarketDataProvider:
    config = TwelveDataConfig(api_key=SecretStr("contract-key"), _env_file=None)  # type: ignore[call-arg]
    return TwelveDataProvider(config, send=FakeTD())


# Canned data: 1-minute bars of 2026-10-26/27 (the same rows stand in for every intraday
# interval), five daily and weekly bars, ten monthly ones.
TWELVEDATA = ContractCase(
    name="twelvedata",
    make=_twelvedata,
    capabilities=capabilities_for(effective_profile(None)),
    symbol="AAPL",
    query="AAPL",
    now=datetime(2026, 10, 28, tzinfo=UTC),
    unknown_symbol="ZZZZNOTREAL",
    ranges={
        **{
            i: (datetime(2026, 10, 26, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC))
            for i in INTRADAY
        },
        "1d": (datetime(2026, 10, 20, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC)),
        "1wk": (datetime(2026, 9, 20, tzinfo=UTC), datetime(2026, 10, 28, tzinfo=UTC)),
        "1mo": (datetime(2025, 12, 1, tzinfo=UTC), datetime(2026, 11, 1, tzinfo=UTC)),
        "3mo": (datetime(2025, 12, 1, tzinfo=UTC), datetime(2026, 11, 1, tzinfo=UTC)),
    },
)
CONTRACT_PROVIDERS: list[ContractCase] = [DEMO, TWELVEDATA]


def ids(cases: list[ContractCase]) -> list[str]:
    return [c.name for c in cases]


def interval_params() -> list[Any]:
    return [
        pytest.param(case, interval, id=f"{case.name}-{interval}")
        for case in CONTRACT_PROVIDERS
        for interval in sorted(case.capabilities.intervals)
    ]


@pytest.fixture(params=CONTRACT_PROVIDERS, ids=ids(CONTRACT_PROVIDERS))
def case(request: pytest.FixtureRequest) -> ContractCase:
    return request.param  # type: ignore[no-any-return]


# -- TypedDict validation ----------------------------------------------------------------


def _classes(hint: Any) -> tuple[type, ...]:
    """Runtime classes a TypedDict value hint accepts (None as NoneType)."""
    if hint is Any:
        return (object,)
    origin = typing.get_origin(hint)
    if origin is typing.Union or origin is types.UnionType:
        return tuple(c for arg in typing.get_args(hint) for c in _classes(arg))
    if origin is not None:
        return (origin,)
    return (type(None) if hint is None else hint,)


def check_typed(row: Any, td: type, *required: str) -> None:
    """`row` is a dict using only keys of the TypedDict `td`, with values of the declared
    types (an int is a valid float), and carries the `required` keys."""
    assert isinstance(row, dict), row
    hints = typing.get_type_hints(td)
    for key, value in row.items():
        assert key in hints, f"unknown key {key!r} for {td.__name__}"
        accepted = _classes(hints[key])
        ok = isinstance(value, accepted)
        if isinstance(value, bool):
            ok = bool in accepted
        elif isinstance(value, int) and float in accepted:
            ok = True
        assert ok, f"{td.__name__}.{key} = {value!r}, expected {hints[key]}"
    for key in required:
        assert key in row, f"{td.__name__} lacks {key!r}"


# -- history -----------------------------------------------------------------------------


def history(
    case: ContractCase, provider: MarketDataProvider, interval: str, window: tuple[Any, Any]
) -> pd.DataFrame:
    return provider.history(case.symbol, interval, window[0], window[1], False)


@pytest.mark.parametrize(("case", "interval"), interval_params())
def test_history_frame_shape_and_range(case: ContractCase, interval: str) -> None:
    start, end = case.window(interval)
    df = history(case, case.make(), interval, (start, end))
    assert list(df.columns) == BAR_COLUMNS
    assert not df.empty, f"{interval} returned no bars"
    assert df["ts"].dtype == "int64"
    ts = df["ts"].tolist()
    assert ts == sorted(set(ts)), "ts must be strictly increasing (sorted, unique)"
    assert ts[0] >= int(start.timestamp()) and ts[-1] < int(end.timestamp())
    for column in BAR_COLUMNS[1:]:
        assert pd.api.types.is_numeric_dtype(df[column]), column
    assert (df["high"] >= df["low"]).all()


@pytest.mark.parametrize(("case", "interval"), interval_params())
def test_history_of_an_empty_range_is_empty(case: ContractCase, interval: str) -> None:
    far = case.now + timedelta(days=30)
    df = history(case, case.make(), interval, (far, far + timedelta(days=5)))
    assert df.empty and list(df.columns) == BAR_COLUMNS


def test_daily_bars_are_stamped_at_exchange_local_midnight(case: ContractCase) -> None:
    if "1d" not in case.capabilities.intervals:
        pytest.skip("no daily bars")
    provider = case.make()
    tz = ZoneInfo(provider.symbol_info(case.symbol)["timezone"])
    df = history(case, provider, "1d", case.window("1d"))
    assert not df.empty
    for t in df["ts"]:
        local = datetime.fromtimestamp(int(t), tz)
        assert (local.hour, local.minute, local.second) == (0, 0, 0), local


# -- symbol info, search, quotes ---------------------------------------------------------


def test_symbol_info_validates(case: ContractCase) -> None:
    info = case.make().symbol_info(case.symbol)
    check_typed(info, SymbolInfo, "symbol", "timezone", "session")
    ZoneInfo(info["timezone"])
    assert re.fullmatch(r"\d{4}-\d{4}", info["session"])
    if info.get("type") is not None:
        assert info["type"] == info["type"].lower()


def test_search_rows_validate(case: ContractCase) -> None:
    if not case.capabilities.search:
        pytest.skip("search not supported")
    rows = case.make().search(case.query, 5)
    assert 0 < len(rows) <= 5
    for row in rows:
        check_typed(row, SearchResult, "symbol")


def test_quotes_rows_validate(case: ContractCase) -> None:
    provider = case.make()
    probe = [case.symbol] + ([case.unknown_symbol] if case.unknown_symbol else [])
    rows = provider.quotes(probe)
    assert [r["symbol"] for r in rows] == [case.symbol]  # unknown symbols are omitted
    check_typed(rows[0], Quote, "symbol", "last")
    if rows[0].get("marketState") is not None:
        assert rows[0]["marketState"] in MARKET_STATES


def test_extended_quotes_rows_validate(case: ContractCase) -> None:
    if not case.capabilities.extended_quotes:
        pytest.skip("extended quotes not supported")
    rows = case.make().extended_quotes([case.symbol])
    assert [r["symbol"] for r in rows] == [case.symbol]
    check_typed(rows[0], ExtendedQuote, "symbol")
    if rows[0].get("marketState") is not None:
        assert rows[0]["marketState"] in MARKET_STATES


# -- events, news, fundamentals ----------------------------------------------------------


def test_events_validate_and_unsupported_kinds_are_empty(case: ContractCase) -> None:
    if not case.capabilities.events:
        pytest.skip("events not supported")
    events = case.make().events(case.symbol)
    check_typed(events, Events)
    for kind in {"dividends", "splits", "earnings"} - case.capabilities.events:
        assert not events.get(kind), f"{kind} are not a capability but came back"


def test_news_validates(case: ContractCase) -> None:
    if not case.capabilities.news:
        pytest.skip("news not supported")
    for item in case.make().news(case.symbol, 5):
        check_typed(item, NewsItem, "title")


def test_fundamentals_validate(case: ContractCase) -> None:
    caps = case.capabilities
    if not (caps.fundamentals_info or caps.fundamentals_statements):
        pytest.skip("fundamentals not supported")
    data = case.make().fundamentals(case.symbol)
    check_typed(data, Fundamentals)
    assert set(data.get("info", {})) <= set(FUNDAMENTALS_INFO_KEYS)


# -- unknown symbols ---------------------------------------------------------------------


def test_unknown_symbol_raises_symbol_not_found(case: ContractCase) -> None:
    if case.unknown_symbol is None:
        pytest.skip("provider has no unknown symbols")
    provider = case.make()
    start, end = case.window("1d")
    with pytest.raises(SymbolNotFound):
        provider.history(case.unknown_symbol, "1d", start, end, False)
    with pytest.raises(SymbolNotFound):
        provider.symbol_info(case.unknown_symbol)


# -- unsupported features through the guard -----------------------------------------------


class Spy:
    """Stands in for a provider: any call that reaches it is a failure."""

    def __getattr__(self, name: str) -> Any:
        def call(*args: Any, **kwargs: Any) -> Any:
            raise AssertionError(f"{name} reached the provider")

        return call


def test_unsupported_features_are_refused_by_the_guard_before_the_provider(
    case: ContractCase,
) -> None:
    """Whatever the provider declares it cannot serve is `ProviderUnsupported` at the guard,
    so it never costs credits. Checked on the declared capabilities, narrowed to a minimum."""
    caps = replace(
        case.capabilities,
        intervals=frozenset({"1d"}) & case.capabilities.intervals,
        extended_quotes=False,
        news=False,
        events=frozenset(),
        fundamentals_info=False,
        fundamentals_statements=False,
        search=False,
    )
    guarded = GuardedProvider(Spy(), UpstreamGuard(), capabilities=caps)  # type: ignore[arg-type]
    window = case.window("1d")
    attempts: list[Callable[[], Any]] = [
        lambda: guarded.extended_quotes([case.symbol]),
        lambda: guarded.news(case.symbol, 5),
        lambda: guarded.events(case.symbol),
        lambda: guarded.fundamentals(case.symbol),
        lambda: guarded.search(case.query, 5),
    ]
    attempts += [
        (lambda i=name: guarded.history(case.symbol, i, window[0], window[1], False))
        for name in INTERVALS
        if name not in caps.intervals
    ]
    for attempt in attempts:
        with pytest.raises(ProviderUnsupported):
            attempt()


def test_declared_capabilities_only_name_known_things(case: ContractCase) -> None:
    caps = case.capabilities
    assert caps.intervals <= set(INTERVALS)
    assert caps.events <= {"dividends", "splits", "earnings"}
    assert caps.markets <= {"us", "intl", "fx", "crypto", "index", "futures"}
    assert caps.to_json()["intervals"]


def test_the_typed_dicts_are_total_false() -> None:
    # Providers fill what their upstream knows; the contract requires only what the
    # tests above name.
    for td in (Quote, ExtendedQuote, SymbolInfo, SearchResult, Events, NewsItem, Fundamentals):
        assert issubclass(td, dict) and td.__total__ is False
