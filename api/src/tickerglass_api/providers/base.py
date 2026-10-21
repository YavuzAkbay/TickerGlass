from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
from typing import Any, Protocol

import pandas as pd

# Columns of every frame returned by `MarketDataProvider.history`, in order.
BAR_COLUMNS = ["ts", "open", "high", "low", "close", "adj_close", "volume"]


class ProviderError(Exception):
    """Upstream data source failed (network, rate limit, unexpected payload)."""


class RateLimited(ProviderError):
    """Upstream kept refusing after retries; `retry_after` is a hint in seconds."""

    def __init__(self, message: str, retry_after: int) -> None:
        super().__init__(message)
        self.retry_after = retry_after


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
