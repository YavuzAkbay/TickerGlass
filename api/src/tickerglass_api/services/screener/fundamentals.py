"""Screener fundamentals: `screener_fundamentals` rows from the provider's
`ScreenInfoProvider` capability (docs/design/server-screener.md §0, §2).

Two passes, run by `ScreenerJob` as a `fundamentals` run (after the snapshot run):

1. Quote extras for every tracked symbol, `CostModel.quote_batch` (Yahoo: 50) symbols per
   `screen_fields` request: market cap, P/E, forward P/E, EPS, dividend yield, shares, next
   earnings. Stamps `quote_at`.
2. `info` (beta, sector, industry) for tracked stocks whose `info_at` is missing or older
   than `INFO_MAX_AGE`, one request each, at `screener_info_rate_per_min`. Stamps `info_at`
   (also for a symbol the provider does not know, so it is asked again only a week later).

Yahoo's v7 fields are mapped defensively (any may be missing): the dividend yield is
`trailingAnnualDividendYield` (a fraction) * 100, else `dividendYield` taken as percent
(unverified unit); the next earnings is the earliest of `earningsTimestamp`,
`earningsTimestampStart`, `earningsTimestampEnd` not before yesterday. The market cap is the
quote currency's, and the field is declared USD: there is no currency column, so `mcap` is
stored only when the row's `currency` is USD or the row names none (US listings, crypto
`-USD` pairs, demo data) and is null for any other quote currency. `eps` stays in the
company's reporting currency and is not converted.
"""

import logging
import math
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import DeclarativeBase, Session

from ...models import ScreenerFundamental, ScreenerSymbol
from ...providers.base import ProviderError, SymbolNotFound
from ...providers.guard import GuardedProvider

if TYPE_CHECKING:
    from .job import RunControl

log = logging.getLogger(__name__)

#: `info` is refreshed when older than this.
INFO_MAX_AGE = timedelta(days=7)
#: An earnings time this far in the past still counts as the next one (reported today).
EARNINGS_GRACE_S = 86_400
_SECTOR_MAX = 64
_INDUSTRY_MAX = 100


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _usd_market_cap(row: dict[str, Any]) -> float | None:
    """`marketCap` unless the row says it is quoted in a currency other than USD."""
    currency = row.get("currency")
    if isinstance(currency, str) and currency.strip() and currency.strip().upper() != "USD":
        return None
    return _num(row.get("marketCap"))


def quote_values(row: dict[str, Any], now: datetime) -> dict[str, Any]:
    """`screener_fundamentals` columns from one `screen_fields` row."""
    yield_frac = _num(row.get("trailingAnnualDividendYield"))
    div_yield = yield_frac * 100 if yield_frac is not None else _num(row.get("dividendYield"))
    floor = now.timestamp() - EARNINGS_GRACE_S
    times = [
        t
        for key in ("earningsTimestamp", "earningsTimestampStart", "earningsTimestampEnd")
        if (t := _num(row.get(key))) is not None and t >= floor
    ]
    return {
        "mcap": _usd_market_cap(row),
        "pe": _num(row.get("trailingPE")),
        "fwd_pe": _num(row.get("forwardPE")),
        "eps_ttm": _num(row.get("epsTrailingTwelveMonths")),
        "div_yield_pct": div_yield,
        "shares_out": _num(row.get("sharesOutstanding")),
        "next_earnings_ts": int(min(times)) if times else None,
    }


def info_values(info: dict[str, Any]) -> dict[str, Any]:
    """`screener_fundamentals` columns from one `info` answer."""

    def text(key: str, limit: int) -> str | None:
        value = info.get(key)
        return value[:limit] if isinstance(value, str) and value else None

    return {
        "beta": _num(info.get("beta")),
        "sector": text("sector", _SECTOR_MAX),
        "industry": text("industry", _INDUSTRY_MAX),
    }


def upsert_rows(
    session: Session, model: type[DeclarativeBase], rows: Sequence[dict[str, Any]], key: str
) -> None:
    """Insert `rows` or update the columns they carry when `key` exists (SQLite and Postgres:
    `ON CONFLICT DO UPDATE`; other dialects: `merge`). The caller commits."""
    if not rows:
        return
    dialect = session.get_bind().dialect.name
    if dialect in ("sqlite", "postgresql"):
        insert = pg_insert if dialect == "postgresql" else sqlite_insert
        by_columns: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for row in rows:
            by_columns.setdefault(tuple(sorted(row)), []).append(row)
        for columns, group in by_columns.items():
            stmt = insert(model).values(group)
            stmt = stmt.on_conflict_do_update(
                index_elements=[key],
                set_={c: stmt.excluded[c] for c in columns if c != key},
            )
            session.execute(stmt)
        return
    for row in rows:
        session.merge(model(**row))


def write_quotes(
    session: Session, provider_id: str, rows: list[dict[str, Any]], now: datetime
) -> int:
    """Store `screen_fields` rows; returns how many."""
    records = []
    for row in rows:
        symbol = row.get("symbol")
        if not isinstance(symbol, str) or not symbol:
            continue
        records.append(
            {
                "symbol": symbol.upper(),
                "provider": provider_id,
                "quote_at": now,
                **quote_values(row, now),
            }
        )
    upsert_rows(session, ScreenerFundamental, records, "symbol")
    return len(records)


def write_info(
    session: Session, provider_id: str, symbol: str, info: dict[str, Any] | None, now: datetime
) -> None:
    """Store one `info` answer (None: the provider does not know the symbol)."""
    values = info_values(info) if info is not None else {}
    upsert_rows(
        session,
        ScreenerFundamental,
        [{"symbol": symbol, "provider": provider_id, "info_at": now, **values}],
        "symbol",
    )


def _aware(dt: datetime | None) -> datetime | None:
    return None if dt is None else dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def info_queue(session: Session, symbols: list[str], now: datetime) -> list[str]:
    """The stocks among `symbols` whose `info` is due, never-fetched and oldest first."""
    stocks = set(
        session.scalars(
            select(ScreenerSymbol.symbol).where(
                ScreenerSymbol.cls == "stocks", ScreenerSymbol.symbol.in_(symbols)
            )
        )
    )
    fetched = {
        sym: _aware(at)
        for sym, at in session.execute(
            select(ScreenerFundamental.symbol, ScreenerFundamental.info_at).where(
                ScreenerFundamental.symbol.in_(symbols)
            )
        )
    }
    cutoff = now - INFO_MAX_AGE
    due = [s for s in symbols if s in stocks and ((at := fetched.get(s)) is None or at < cutoff)]
    oldest = datetime.min.replace(tzinfo=UTC)
    return sorted(due, key=lambda s: fetched.get(s) or oldest)


def _store_quotes(
    session: Session, *, provider_id: str, rows: list[dict[str, Any]], now: datetime
) -> None:
    write_quotes(session, provider_id, rows, now)


def _store_info(
    session: Session, *, provider_id: str, symbol: str, info: dict[str, Any] | None, now: datetime
) -> None:
    write_info(session, provider_id, symbol, info, now)


async def quote_pass(
    ctl: "RunControl", provider: GuardedProvider, provider_id: str, symbols: list[str], batch: int
) -> None:
    """Pass 1 (see the module docstring): one `screen_fields` call per `batch` symbols."""
    for i in range(0, len(symbols), max(1, batch)):
        chunk = symbols[i : i + batch]
        await ctl.checkpoint()
        try:
            rows = await ctl.call(partial(provider.screen_fields, chunk), rate=ctl.rate())
        except ProviderError as exc:
            log.warning("screener fundamentals: %d symbols not served: %s", len(chunk), exc)
            ctl.advance(failed=len(chunk))
            continue
        now = ctl.now()
        await ctl.write(partial(_store_quotes, provider_id=provider_id, rows=rows, now=now))
        ctl.advance(done=len(chunk))


async def info_pass(
    ctl: "RunControl", provider: GuardedProvider, provider_id: str, symbols: list[str]
) -> None:
    """Pass 2 (see the module docstring): one `info` call per due stock."""
    for symbol in symbols:
        await ctl.checkpoint()
        info: dict[str, Any] | None
        try:
            info = await ctl.call(partial(provider.info, symbol), rate=ctl.rate(info=True))
        except SymbolNotFound:
            info = None
        except ProviderError as exc:
            log.warning("screener info for %s not served: %s", symbol, exc)
            ctl.advance(failed=1)
            continue
        now = ctl.now()
        await ctl.write(
            partial(_store_info, provider_id=provider_id, symbol=symbol, info=info, now=now)
        )
        ctl.advance(done=1 if info is not None else 0, failed=0 if info is not None else 1)
