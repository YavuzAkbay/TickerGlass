import logging
import time
from collections.abc import Callable
from concurrent.futures import Executor
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from ..models import SymbolMeta
from ..providers.base import MarketDataProvider, ProviderError, SymbolNotFound
from ..settings import Settings
from .cache import SmartCache
from .cache_gate import CacheGate, CacheRetired
from .sessions import StoredInfo
from .stats import CacheStats

log = logging.getLogger(__name__)

# Default metadata TTL (`Settings.symbol_info_ttl_s`).
SYMBOL_TTL = timedelta(hours=24)
# Distinct search queries remembered (least recently used dropped first).
SEARCH_MAX_ENTRIES = 1024
# Symbols whose metadata fetch is remembered (only "unknown" outcomes are kept long).
INFO_MAX_ENTRIES = 1024


@dataclass(frozen=True)
class _Search:
    """Results of one query as fetched: up to `limit` rows, best match first."""

    limit: int
    rows: list[dict[str, Any]]


class SymbolService:
    """Symbol metadata (persisted) and search (cached in memory, see `SmartCache`)."""

    def __init__(
        self,
        engine: Engine,
        provider: MarketDataProvider,
        *,
        settings: Settings | None = None,
        stats: CacheStats | None = None,
        refresher: Executor | None = None,
        background: Callable[[], AbstractContextManager[object]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        gate: CacheGate | None = None,
        generation: int = 0,
    ) -> None:
        self._engine = engine
        self._provider = provider
        # With a gate, commits of this service stop once its `generation` is retired.
        self._gate = gate
        self._generation = generation
        self._stats = stats if stats is not None else CacheStats()
        s = settings if settings is not None else Settings()
        self._ttl = timedelta(seconds=s.symbol_info_ttl_s)
        self._search: SmartCache[str, _Search] = SmartCache(
            "search",
            ttl=s.search_ttl_s,
            stale_ttl=s.cache_stale_max_s,
            max_entries=SEARCH_MAX_ENTRIES,
            negative_ttl=s.cache_negative_ttl_s,
            stats=stats,
            clock=clock,
            refresher=refresher,
            background=background,
        )
        # Metadata itself is stored in the DB; this only remembers unknown symbols (and
        # merges concurrent fetches). A fetched value is stale at once (TTL 0).
        self._fetches: SmartCache[str, dict[str, Any]] = SmartCache(
            "symbol_info",
            ttl=0,
            stale_ttl=0,
            max_entries=INFO_MAX_ENTRIES,
            negative_ttl=s.cache_negative_ttl_s,
            stats=stats,
            clock=clock,
        )

    def info(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        now = datetime.now(UTC)
        with Session(self._engine) as s:
            row = s.get(SymbolMeta, symbol)
            if row is not None:
                fetched = (
                    row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=UTC)
                )
                if now - fetched < self._ttl:
                    self._ensure_current()
                    return row.data
            try:
                data = self._fetches.get(
                    symbol, lambda: self._provider.symbol_info(symbol), swr=False
                )
            except SymbolNotFound:
                raise
            except ProviderError as exc:
                if row is None:
                    raise
                # Stale metadata beats an error; the next request tries again.
                log.warning("symbol info refresh failed for %s, serving cached: %s", symbol, exc)
                self._ensure_current()
                return row.data
            s.merge(SymbolMeta(symbol=symbol, data=data, fetched_at=now))
            self._commit(s)
            return data

    def _ensure_current(self) -> None:
        """Raise `CacheRetired` when this service's generation is retired: a row read after
        a switch wiped the cache is not this service's provider's."""
        if self._gate is not None and self._gate.generation != self._generation:
            self._stats.incr("symbols.retired_read")
            raise CacheRetired("symbols")

    def _commit(self, s: Session) -> None:
        """Commit the session's cache writes, unless this service's generation is retired:
        then roll back and raise `CacheRetired`."""
        if self._gate is None:
            s.commit()
            return
        with self._gate.writing(self._generation) as current:
            if current:
                s.commit()
                return
            s.rollback()
        self._stats.incr("symbols.retired_write")
        raise CacheRetired("symbols")

    def cached_info(self, symbol: str) -> StoredInfo | None:
        """Stored metadata of `symbol` whatever its age (`fetched_at` tells it), or None;
        never calls upstream."""
        with Session(self._engine) as s:
            row = s.get(SymbolMeta, symbol.upper())
            return None if row is None else StoredInfo(row.data, fetched_at=row.fetched_at)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        """Best `limit` matches. Queries differing in case or surrounding spaces share one
        entry, and one fetch serves every smaller limit; a larger one fetches again."""
        text = query.strip()
        found = self._search.get(
            text.casefold(),
            lambda: _Search(limit, self._provider.search(text, limit)),
            accept=lambda r: r.limit >= limit,
        )
        return found.rows[:limit]
