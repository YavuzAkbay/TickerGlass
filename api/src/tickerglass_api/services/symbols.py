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
from .stats import CacheStats

log = logging.getLogger(__name__)

SYMBOL_TTL = timedelta(hours=24)
# Distinct search queries remembered (least recently used dropped first).
SEARCH_MAX_ENTRIES = 1024


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
    ) -> None:
        self._engine = engine
        self._provider = provider
        s = settings if settings is not None else Settings()
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

    def info(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        now = datetime.now(UTC)
        with Session(self._engine) as s:
            row = s.get(SymbolMeta, symbol)
            if row is not None:
                fetched = (
                    row.fetched_at if row.fetched_at.tzinfo else row.fetched_at.replace(tzinfo=UTC)
                )
                if now - fetched < SYMBOL_TTL:
                    return row.data
            try:
                data = self._provider.symbol_info(symbol)
            except SymbolNotFound:
                raise
            except ProviderError as exc:
                if row is None:
                    raise
                # Stale metadata beats an error; the next request tries again.
                log.warning("symbol info refresh failed for %s, serving cached: %s", symbol, exc)
                return row.data
            s.merge(SymbolMeta(symbol=symbol, data=data, fetched_at=now))
            s.commit()
            return data

    def cached_info(self, symbol: str) -> dict[str, Any] | None:
        """Stored metadata of `symbol` whatever its age, or None; never calls upstream."""
        with Session(self._engine) as s:
            row = s.get(SymbolMeta, symbol.upper())
            return None if row is None else row.data

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
