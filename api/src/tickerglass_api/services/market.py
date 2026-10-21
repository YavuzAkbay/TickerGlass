import threading
import time
from collections.abc import Callable
from concurrent.futures import Executor
from contextlib import AbstractContextManager
from dataclasses import dataclass
from typing import Any

from ..providers.base import MarketDataProvider, PartialQuotes, QuoteList
from ..settings import Settings
from .cache import BatchResult, SmartCache
from .stats import CacheStats

Row = dict[str, Any]

# `marketState` values of an extended session (before or after the regular one).
_SESSION_STATES = frozenset({"PRE", "PREPRE", "POST", "POSTPOST"})


class TTLCache:
    """Thread-safe in-memory cache with per-cache TTL (monotonic clock)."""

    def __init__(self, ttl: float, max_entries: int = 2048) -> None:
        self._ttl = ttl
        self._max = max_entries
        self._lock = threading.Lock()
        self._data: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any) -> tuple[bool, Any]:
        with self._lock:
            hit = self._data.get(key)
            if hit is None or hit[0] <= time.monotonic():
                self._data.pop(key, None)
                return False, None
            return True, hit[1]

    def put(self, key: Any, value: Any) -> None:
        with self._lock:
            if len(self._data) >= self._max:
                now = time.monotonic()
                self._data = {k: v for k, v in self._data.items() if v[0] > now}
                if len(self._data) >= self._max:
                    self._data.pop(next(iter(self._data)))
            self._data[key] = (time.monotonic() + self._ttl, value)

    def get_or_load(self, key: Any, load: Callable[[], Any]) -> Any:
        found, value = self.get(key)
        if found:
            return value
        value = load()
        self.put(key, value)
        return value


@dataclass(frozen=True)
class _News:
    """News of one symbol as fetched: up to `limit` items, newest first."""

    limit: int
    items: list[Row]


class MarketService:
    """Quotes, events, news and fundamentals, cached in memory (see `SmartCache`).

    Quotes are served fresh or fetched, and stale only when the upstream fails. Events
    and fundamentals are served stale while one background refresh runs on `refresher`
    (under `background()`), so slow data never blocks a request once cached.
    """

    def __init__(
        self,
        provider: MarketDataProvider,
        *,
        settings: Settings | None = None,
        stats: CacheStats | None = None,
        refresher: Executor | None = None,
        background: Callable[[], AbstractContextManager[object]] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._provider = provider
        s = settings if settings is not None else Settings()
        self._news_fetch_limit = s.news_fetch_limit
        stats = stats if stats is not None else CacheStats()

        self._quote_ttl = s.quote_ttl_s
        self._closed_ttl = s.quote_closed_ttl_s
        self._session_ttl = s.extended_ttl_s

        def cache(
            name: str,
            ttl: float,
            ttl_for: Callable[[Row], float] | None = None,
            negative_ttl: float = s.cache_negative_ttl_s,
        ) -> SmartCache[str, Any]:
            return SmartCache(
                name,
                ttl=ttl,
                stale_ttl=s.cache_stale_max_s,
                max_entries=s.cache_max_entries,
                negative_ttl=negative_ttl,
                stats=stats,
                clock=clock,
                refresher=refresher,
                background=background,
                ttl_for=ttl_for,
            )

        # A symbol missing from a quote answer is remembered only briefly.
        self._quotes: SmartCache[str, Row] = cache(
            "quotes", s.quote_ttl_s, self._quote_ttl_for, s.quote_negative_ttl_s
        )
        self._extended: SmartCache[str, Row] = cache(
            "extended", s.extended_ttl_s, negative_ttl=s.quote_negative_ttl_s
        )
        self._events: SmartCache[str, Row] = cache("events", s.events_ttl_s)
        self._news: SmartCache[str, _News] = cache("news", s.news_ttl_s)
        self._fundamentals: SmartCache[str, Row] = cache("fundamentals", s.fundamentals_ttl_s)

    def quotes(
        self, symbols: list[str], *, max_age: float | None = None, stale_ok: bool = True
    ) -> list[Row]:
        """Latest quote per known symbol, in request order; unknown symbols are omitted.

        `stale_ok=False` never serves a stale value after a failed load: such symbols
        are omitted (and the error raised when nothing at all can be returned)."""
        wanted = list(dict.fromkeys(s.upper() for s in symbols))
        found = self._quotes.get_many(wanted, self._load_quotes, max_age=max_age, stale_ok=stale_ok)
        return [found[sym] for sym in wanted if sym in found]

    def _quote_ttl_for(self, row: Row) -> float:
        """Freshness of a quote by its session: closed markets barely change."""
        state = row.get("marketState")
        if state == "CLOSED":
            return self._closed_ttl
        if state in _SESSION_STATES:
            return self._session_ttl
        return self._quote_ttl

    def _load_quotes(self, symbols: list[str]) -> BatchResult[str, Row]:
        rows = self._provider.quotes(symbols)
        # A symbol without a row is cached as unknown only when the provider says its
        # answer covered every symbol; otherwise it may merely have failed to load, and
        # is asked for again next time.
        confirmed = isinstance(rows, QuoteList) and rows.confirmed
        return BatchResult({q["symbol"].upper(): q for q in rows}, complete=confirmed)

    def extended_quotes(self, symbols: list[str], *, max_age: float | None = None) -> list[Row]:
        """Pre/post-market quote per known symbol, in request order.

        Raises `PartialQuotes` only when nothing at all can be returned.
        """
        wanted = list(dict.fromkeys(s.upper() for s in symbols))
        found = self._extended.get_many(wanted, self._load_extended, max_age=max_age)
        return [found[sym] for sym in wanted if sym in found]

    def _load_extended(self, symbols: list[str]) -> BatchResult[str, Row]:
        try:
            rows = self._provider.extended_quotes(symbols)
        except PartialQuotes as exc:
            # A failed chunk is "unknown", never cached as absent; the rest answered.
            return BatchResult(
                {q["symbol"].upper(): q for q in exc.quotes},
                complete=True,
                failed=[s.upper() for s in exc.failed],
                error=exc,
            )
        # Every chunk answered: a symbol without a row does not exist upstream.
        return BatchResult({q["symbol"].upper(): q for q in rows}, complete=True)

    def events(self, symbol: str) -> Row:
        sym = symbol.upper()
        return self._events.get(sym, lambda: self._provider.events(sym))

    def news(self, symbol: str, limit: int) -> list[Row]:
        """Newest `limit` items. One fetch of at least `news_fetch_limit` items per symbol
        serves every smaller limit."""
        sym = symbol.upper()
        fetch = max(limit, self._news_fetch_limit)
        cached = self._news.get(
            sym,
            lambda: _News(fetch, self._provider.news(sym, fetch)),
            swr=False,
            accept=lambda n: n.limit >= limit,
        )
        return cached.items[:limit]

    def fundamentals(self, symbol: str) -> Row:
        sym = symbol.upper()
        return self._fundamentals.get(sym, lambda: self._provider.fundamentals(sym))
