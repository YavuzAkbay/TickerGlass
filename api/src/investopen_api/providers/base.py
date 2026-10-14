from datetime import datetime
from typing import Any, Protocol

import pandas as pd

# Columns of every frame returned by `MarketDataProvider.history`, in order.
BAR_COLUMNS = ["ts", "open", "high", "low", "close", "adj_close", "volume"]


class ProviderError(Exception):
    """Upstream data source failed (network, rate limit, unexpected payload)."""


class PartialQuotes(ProviderError):
    """Some request chunks failed: `quotes` holds what succeeded, `failed` the symbols
    whose chunk failed (their absence means "unknown", not "no such symbol")."""

    def __init__(self, message: str, quotes: list[Any], failed: list[str]) -> None:
        super().__init__(message)
        self.quotes = quotes
        self.failed = failed


class SymbolNotFound(ProviderError):
    pass


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
        """Latest quote per known symbol; unknown symbols are omitted."""
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
