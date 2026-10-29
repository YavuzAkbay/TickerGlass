import math
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol, TypedDict, cast, runtime_checkable

import pandas as pd

from ..intervals import INTERVALS

# Columns of every frame returned by `MarketDataProvider.history`, in order.
BAR_COLUMNS = ["ts", "open", "high", "low", "close", "adj_close", "volume"]


class ProviderError(Exception):
    """Upstream data source failed (network, rate limit, unexpected payload)."""


class RateLimited(ProviderError):
    """Upstream kept refusing after retries; `retry_after` is a hint in seconds. `daily`
    marks a refusal because the daily credit allowance is used up (not the per-minute
    one): the guard then refuses everything until 00:00 UTC."""

    def __init__(self, message: str, retry_after: int, *, daily: bool = False) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.daily = daily


class LocalRateLimited(RateLimited):
    """The provider itself refused a request that would be charged and refused upstream
    (more credits than are left in the window). Nothing was sent, so the guard opens no
    breaker and refunds the `credits` it took for the request."""

    def __init__(self, message: str, retry_after: int, *, credits: int = 0) -> None:
        super().__init__(message, retry_after)
        self.credits = credits


class UpstreamUnavailable(ProviderError):
    """Upstream could not be reached (connection failure or timeout)."""


class UpstreamDegraded(UpstreamUnavailable):
    """One upstream endpoint is failing while the upstream itself answers, so the request
    was not sent (or not retried another way); no outage breaker should open."""


class PartialQuotes(ProviderError):
    """Some request chunks failed: `quotes` holds what succeeded, `failed` the symbols
    whose chunk failed (their absence means "unknown", not "no such symbol")."""

    def __init__(self, message: str, quotes: list[Any], failed: list[str]) -> None:
        super().__init__(message)
        self.quotes = quotes
        self.failed = failed


class SymbolNotFound(ProviderError):
    pass


class ProviderUnsupported(ProviderError):
    """The active provider cannot serve this feature at all (answered as 501): the call
    was refused before any upstream request, and retrying will not help."""

    def __init__(self, feature: str, provider: str | None = None) -> None:
        by = provider if provider else "this data provider"
        super().__init__(f"{feature} is not supported by {by}")
        self.feature = feature
        self.provider = provider


class ProviderNotConfigured(ProviderError):
    """Required provider settings are missing (answered as 503); the message names them."""


# `Capabilities.events` members.
EVENT_KINDS = frozenset({"dividends", "splits", "earnings"})
# `Capabilities.markets` members.
MARKETS = frozenset({"us", "intl", "fx", "crypto", "index", "futures"})


@dataclass(frozen=True)
class Capabilities:
    """What a provider serves; the guard refuses the rest with `ProviderUnsupported` and
    the web app hides it. A provider serving only some `events` kinds returns empty lists
    for the others."""

    #: Canonical interval names served, natively or synthesized by the provider.
    intervals: frozenset[str]
    #: `history(prepost=True)` returns pre/post-market bars.
    extended_history: bool
    extended_quotes: bool
    #: `adj_close` differs from `close` (dividend/split adjusted).
    adjusted_close: bool
    search: bool
    events: frozenset[str]
    news: bool
    fundamentals_info: bool
    fundamentals_statements: bool
    #: Has a live streaming source (`registry.ProviderSpec.make_live`).
    streaming: bool
    markets: frozenset[str]

    @classmethod
    def full(cls) -> "Capabilities":
        return cls(
            intervals=frozenset(INTERVALS),
            extended_history=True,
            extended_quotes=True,
            adjusted_close=True,
            search=True,
            events=EVENT_KINDS,
            news=True,
            fundamentals_info=True,
            fundamentals_statements=True,
            streaming=True,
            markets=MARKETS,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "intervals": sorted(self.intervals, key=_interval_order),
            "extendedHistory": self.extended_history,
            "extendedQuotes": self.extended_quotes,
            "adjustedClose": self.adjusted_close,
            "search": self.search,
            "events": sorted(self.events),
            "news": self.news,
            "fundamentalsInfo": self.fundamentals_info,
            "fundamentalsStatements": self.fundamentals_statements,
            "streaming": self.streaming,
            "markets": sorted(self.markets),
        }


def _interval_order(name: str) -> tuple[int, str]:
    spec = INTERVALS.get(name)
    return (spec.seconds if spec else 0, name)


@dataclass(frozen=True)
class Budget:
    """Upstream request budget of a provider: a token bucket plus an optional daily cap."""

    rate_per_min: float
    burst: int
    daily: int | None = None


@dataclass(frozen=True)
class CostModel:
    """Upstream cost, in guard tokens, of each provider operation. The defaults are
    Yahoo's (one request per call). Extra requests of one call (retries, pages) are
    reported with `charge_upstream`."""

    history: int = 1
    symbol_info: int = 1
    search: int = 1
    #: Symbols answered by one quote request.
    quote_batch: int = 50
    quote_per_request: int = 1
    quote_per_symbol: int = 0
    events: int = 2
    news: int = 1
    #: Yahoo: summary info plus six statements, one request each.
    fundamentals: int = 7

    def quotes(self, n: int) -> int:
        """Cost of a quote call for `n` symbols."""
        requests = math.ceil(n / self.quote_batch)
        return requests * self.quote_per_request + n * self.quote_per_symbol

    def to_json(self) -> dict[str, int]:
        return {
            "history": self.history,
            "symbolInfo": self.symbol_info,
            "search": self.search,
            "quoteBatch": self.quote_batch,
            "quotePerRequest": self.quote_per_request,
            "quotePerSymbol": self.quote_per_symbol,
            "events": self.events,
            "news": self.news,
            "fundamentals": self.fundamentals,
        }


@dataclass(frozen=True)
class ConfigField:
    """One setting of a provider's config model, as shown in the app. Derived from the
    model (`registry.config_fields`), never written by hand."""

    name: str
    #: Environment variable that sets it.
    env: str
    label: str
    secret: bool
    required: bool
    #: Whether the user has set it (otherwise the default applies).
    set: bool
    #: None for secrets: their values never leave the process.
    value: Any | None

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "env": self.env,
            "label": self.label,
            "secret": self.secret,
            "required": self.required,
            "set": self.set,
            "value": None if self.secret else self.value,
        }


# Meter of the provider call running in this context (see `charge_upstream`).
_CHARGE: ContextVar[Callable[[int], None] | None] = ContextVar("upstream_charge", default=None)


@contextmanager
def metering(charge: Callable[[int], None]) -> Iterator[None]:
    """Route `charge_upstream` calls made in this context to `charge` (the guard installs
    it around every provider call)."""
    token = _CHARGE.set(charge)
    try:
        yield
    finally:
        _CHARGE.reset(token)


def charge_upstream(requests: int) -> None:
    """Report `requests` upstream requests beyond what the current call was charged for
    (retries, fallbacks) before sending them. Raises a `ProviderError` (`RateLimited`,
    `UpstreamUnavailable`) when they may not be sent; a no-op outside a metered call."""
    charge = _CHARGE.get()
    if charge is not None and requests > 0:
        charge(requests)


class UsageHandler(Protocol):
    def __call__(
        self,
        *,
        minute_used: int | None,
        minute_left: int | None,
        daily_used: int | None,
        daily_limit: int | None,
    ) -> None: ...


# Receiver of the provider call running in this context (see `report_usage`).
_USAGE: ContextVar[UsageHandler | None] = ContextVar("upstream_usage", default=None)


@contextmanager
def usage_reporting(handler: UsageHandler) -> Iterator[None]:
    """Route `report_usage` calls made in this context to `handler` (the guard installs it
    around every provider call, next to `metering`)."""
    token = _USAGE.set(handler)
    try:
        yield
    finally:
        _USAGE.reset(token)


def report_usage(
    *,
    minute_used: int | None = None,
    minute_left: int | None = None,
    daily_used: int | None = None,
    daily_limit: int | None = None,
) -> None:
    """Tell the guard what the upstream says about the credits of the current window, e.g.
    from response headers (`api-credits-used` / `api-credits-left`). The guard lowers its
    tokens to `minute_left` (never raises them), takes `minute_used + minute_left` as the
    per-minute limit unless the user set one, and keeps the larger of its own and the
    reported daily count. Fields the upstream does not tell stay None; a no-op outside a
    guarded call."""
    handler = _USAGE.get()
    if handler is not None:
        handler(
            minute_used=minute_used,
            minute_left=minute_left,
            daily_used=daily_used,
            daily_limit=daily_limit,
        )


@dataclass(frozen=True)
class Usage:
    """Credits as the upstream accounts them; None for what it does not tell.
    `daily_limit` 0 says the upstream has no daily cap."""

    minute_limit: int | None = None
    minute_used: int | None = None
    daily_limit: int | None = None
    daily_used: int | None = None


@runtime_checkable
class MeteredProvider(Protocol):
    """Optional: a provider that can ask its upstream for its credit usage (a free or cheap
    request). The app calls it once at startup to seed the guard's daily count."""

    def usage(self) -> Usage: ...


def as_metered(provider: object) -> MeteredProvider | None:
    """`provider` if it implements `usage`, else None. Looks at the class, not the
    instance, so proxies and fakes with a catch-all `__getattr__` are not probed."""
    return (
        cast(MeteredProvider, provider)
        if callable(getattr(type(provider), "usage", None))
        else None
    )


@runtime_checkable
class SymbolRouting(Protocol):
    """Optional: a provider that knows, without asking its upstream, which symbols it
    cannot serve. The guard then keeps such work free (no tokens, no daily credits)."""

    def billable(self, symbols: list[str]) -> list[str]:
        """`symbols` without duplicates and without those the provider answers locally
        (it serves no quote for them); what is left is what a quote call costs. When
        nothing is left, the provider's `quotes` for the original list raises
        `ProviderUnsupported` without sending a request."""
        ...

    def answers_locally(self, op: str, symbol: str) -> bool:
        """True when `op` (history, symbol_info, events, fundamentals) for `symbol` is
        answered without an upstream request (an error or an empty result)."""
        ...


def as_symbol_routing(provider: object) -> SymbolRouting | None:
    """`provider` if it implements `SymbolRouting`, else None (class lookup, like
    `as_metered`)."""
    return (
        cast(SymbolRouting, provider)
        if callable(getattr(type(provider), "billable", None))
        and callable(getattr(type(provider), "answers_locally", None))
        else None
    )


class QuoteList(list[dict[str, Any]]):
    """Rows returned by `MarketDataProvider.quotes`, plus whether the upstream answered
    for every requested symbol (`confirmed`): then a symbol without a row is known not to
    exist. Providers returning a plain list never confirm."""

    def __init__(self, rows: Iterable[dict[str, Any]] = (), *, confirmed: bool = False) -> None:
        super().__init__(rows)
        self.confirmed = confirmed


class MarketDataProvider(Protocol):
    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        """Bars in [start, end) as a frame with BAR_COLUMNS, sorted by ts.

        `start=None` means the earliest available bar. Returns an empty frame when
        the range has no bars; it does not raise for that.
        """
        ...

    def symbol_info(self, symbol: str) -> dict[str, Any]: ...

    def search(self, query: str, limit: int) -> list[dict[str, Any]]: ...

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol; unknown symbols are omitted. Return a `QuoteList`
        with `confirmed=True` only when the omission proves the symbol does not exist."""
        ...

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Pre/post-market quote per known symbol (see `YahooProvider.extended_quotes`);
        unknown symbols are omitted."""
        ...

    def events(self, symbol: str) -> dict[str, Any]:
        """Dividends, splits and earnings for a symbol (times are unix seconds UTC)."""
        ...

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]: ...

    def fundamentals(self, symbol: str) -> dict[str, Any]: ...


# Documented shapes of what providers return. The protocol itself stays `dict[str, Any]`;
# these name the frozen keys the services and the web app read. Times are unix seconds UTC
# unless noted; every key is optional because providers fill what their upstream knows.
class Quote(TypedDict, total=False):
    symbol: str
    last: float | None
    prevClose: float | None
    change: float | None
    changePercent: float | None
    volume: int | None
    currency: str | None
    #: PRE, REGULAR, POST, CLOSED, PREPRE or POSTPOST.
    marketState: str | None
    time: int | None


class ExtendedQuote(TypedDict, total=False):
    symbol: str
    marketState: str | None
    regularMarketPrice: float | None
    regularMarketTime: int | None
    preMarketPrice: float | None
    preMarketTime: int | None
    preMarketChange: float | None
    preMarketChangePercent: float | None
    postMarketPrice: float | None
    postMarketTime: int | None
    postMarketChange: float | None
    postMarketChangePercent: float | None


class SymbolInfo(TypedDict, total=False):
    symbol: str
    name: str
    exchange: str | None
    exchangeName: str | None
    #: Lower case: equity, etf, index, currency, cryptocurrency, future, ...
    type: str | None
    currency: str | None
    #: IANA time zone of the exchange.
    timezone: str | None
    #: Regular session "HHMM-HHMM" in `timezone`.
    session: str | None
    priceHint: int
    minTick: float
    hasIntraday: bool


class SearchResult(TypedDict, total=False):
    symbol: str
    name: str
    exchange: str | None
    type: str | None
    typeDisplay: str | None


class Events(TypedDict, total=False):
    #: Items `{"t", "amount"}`.
    dividends: list[dict[str, Any]]
    #: Items `{"t", "ratio"}`.
    splits: list[dict[str, Any]]
    #: Items `{"t", "epsEstimate", "epsActual", "surprisePercent"}`.
    earnings: list[dict[str, Any]]


class NewsItem(TypedDict, total=False):
    id: str
    title: str
    publisher: str | None
    url: str
    time: int | None
    summary: str | None
    thumbnail: str | None


class Fundamentals(TypedDict, total=False):
    #: Keys from `FUNDAMENTALS_INFO_KEYS`.
    info: dict[str, Any]
    #: `{"income", "balance", "cashflow", "quarterly": {...}}`, each
    #: `{"periods": [ISO dates], "rows": {name: [values]}}`.
    financials: dict[str, Any]


# Keys of `Fundamentals["info"]`.
FUNDAMENTALS_INFO_KEYS = (
    "longName",
    "quoteType",
    "currency",
    "exchange",
    "marketCap",
    "enterpriseValue",
    "trailingPE",
    "forwardPE",
    "priceToBook",
    "trailingEps",
    "forwardEps",
    "dividendRate",
    "dividendYield",
    "payoutRatio",
    "beta",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
    "fiftyDayAverage",
    "twoHundredDayAverage",
    "averageVolume",
    "sharesOutstanding",
    "profitMargins",
    "returnOnEquity",
    "sector",
    "industry",
    "country",
    "website",
    "fullTimeEmployees",
    "longBusinessSummary",
    "earningsTimestamp",
    "earningsTimestampStart",
    "earningsTimestampEnd",
    "isEarningsDateEstimate",
    "exDividendDate",
    "floatShares",
)
