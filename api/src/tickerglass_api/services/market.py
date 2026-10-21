import threading
import time
from collections.abc import Callable
from typing import Any

from ..providers.base import MarketDataProvider, PartialQuotes

QUOTE_TTL = 15.0
EXTENDED_TTL = 60.0
EVENTS_TTL = 6 * 3600.0
NEWS_TTL = 5 * 60.0
FUNDAMENTALS_TTL = 6 * 3600.0


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


class MarketService:
    def __init__(self, provider: MarketDataProvider) -> None:
        self._provider = provider
        self._quotes = TTLCache(QUOTE_TTL, max_entries=4096)
        self._extended = TTLCache(EXTENDED_TTL, max_entries=4096)
        self._events = TTLCache(EVENTS_TTL)
        self._news = TTLCache(NEWS_TTL)
        self._fundamentals = TTLCache(FUNDAMENTALS_TTL)

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        wanted = list(dict.fromkeys(s.upper() for s in symbols))
        found: dict[str, dict[str, Any] | None] = {}
        missing: list[str] = []
        for sym in wanted:
            hit, value = self._quotes.get(sym)
            if hit:
                found[sym] = value
            else:
                missing.append(sym)
        if missing:
            fetched = {q["symbol"].upper(): q for q in self._provider.quotes(missing)}
            for sym in missing:
                value = fetched.get(sym)  # unknown symbols are cached as None
                self._quotes.put(sym, value)
                found[sym] = value
        return [q for sym in wanted if (q := found.get(sym)) is not None]

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        wanted = list(dict.fromkeys(s.upper() for s in symbols))
        found: dict[str, dict[str, Any] | None] = {}
        missing: list[str] = []
        for sym in wanted:
            hit, value = self._extended.get(sym)
            if hit:
                found[sym] = value
            else:
                missing.append(sym)
        if missing:
            failed: set[str] = set()
            try:
                rows = self._provider.extended_quotes(missing)
            except PartialQuotes as exc:
                rows, failed = exc.quotes, {s.upper() for s in exc.failed}
                if not rows and failed.issuperset(missing) and not any(found.values()):
                    raise  # nothing at all to return: surface as a provider error
            fetched = {q["symbol"].upper(): q for q in rows}
            for sym in missing:
                if sym in failed and sym not in fetched:
                    continue  # failed chunk: unknown, so never cache it as absent
                value = fetched.get(sym)  # symbols Yahoo returned no row for: cached None
                self._extended.put(sym, value)
                found[sym] = value
        return [q for sym in wanted if (q := found.get(sym)) is not None]

    def events(self, symbol: str) -> dict[str, Any]:
        sym = symbol.upper()
        result: dict[str, Any] = self._events.get_or_load(sym, lambda: self._provider.events(sym))
        return result

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        sym = symbol.upper()
        # Cache the widest request per symbol would complicate things; key on limit.
        result: list[dict[str, Any]] = self._news.get_or_load(
            (sym, limit), lambda: self._provider.news(sym, limit)
        )
        return result

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        sym = symbol.upper()
        result: dict[str, Any] = self._fundamentals.get_or_load(
            sym, lambda: self._provider.fundamentals(sym)
        )
        return result
