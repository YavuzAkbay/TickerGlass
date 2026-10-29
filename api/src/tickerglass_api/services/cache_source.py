"""Which provider filled the market data cache.

Bars and symbol metadata of one provider are not interchangeable with another's (adjusted
closes, session hours, symbol forms), so switching `MARKET_PROVIDER` starts from an empty
cache. The provider id is kept in `app_meta`; user data is never touched.
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import Engine, delete, exists, select
from sqlalchemy.orm import Session

from ..models import AppMeta, Bar, SeriesMeta, SymbolMeta

log = logging.getLogger(__name__)

#: `app_meta` key holding the provider id that filled the cache.
CACHE_SOURCE_KEY = "cache_source"
#: The only provider there was before the marker existed: a cache without one is its.
LEGACY_SOURCE = "yahoo"


def ensure_cache_source(engine: Engine, source: str) -> bool:
    """Record `source` as the cache's provider. With no marker yet and an empty cache there
    is nothing to clear; a cache without a marker predates the marker and was filled by
    Yahoo, the only provider then. When the recorded provider differs from `source`, bars,
    series bookkeeping and symbol metadata are deleted in one transaction together with the
    marker update. Returns True when the cache was wiped."""
    now = datetime.now(UTC)
    with Session(engine) as session, session.begin():
        row = session.get(AppMeta, CACHE_SOURCE_KEY)
        if row is None:
            filled = session.scalar(
                select(exists().where(Bar.symbol.is_not(None)))
            ) or session.scalar(select(exists().where(SymbolMeta.symbol.is_not(None))))
            previous = LEGACY_SOURCE if filled else source
            row = AppMeta(key=CACHE_SOURCE_KEY, value=previous, updated_at=now)
            session.add(row)
        else:
            previous = row.value
        if previous == source:
            return False
        for table in (Bar, SeriesMeta, SymbolMeta):
            session.execute(delete(table))
        row.value = source
        row.updated_at = now
    log.warning(
        "market data provider changed from %s to %s: cached bars and symbol metadata cleared",
        previous,
        source,
    )
    return True
