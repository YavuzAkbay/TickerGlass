"""Bar cache: serves bars from the DB and keeps it in sync with the provider.

First request for a series backfills everything the provider allows. Later
requests only refetch the tail once it is older than the interval's TTL, and not
at all when the requested range ends before the newest cached bar. If the
overlapping bar changed (split or dividend re-adjustment), the series is wiped
and backfilled again. When a tail refresh fails, the cached bars are served and
the refresh is retried after a short pause.
"""

import logging
import math
import threading
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import pandas as pd
from sqlalchemy import Engine, delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..intervals import IntervalSpec
from ..models import Bar, SeriesMeta
from ..providers.base import (
    BAR_COLUMNS,
    MarketDataProvider,
    ProviderError,
    RateLimited,
    SymbolNotFound,
)
from .stats import CacheStats

log = logging.getLogger(__name__)

# Bars refetched before the newest cached bar, to detect retroactive adjustments.
TAIL_OVERLAP_BARS = 3
REL_TOLERANCE = 1e-6
UPSERT_BATCH = 2000
# Pause before retrying a failed tail refresh (cached bars are served meanwhile).
TAIL_RETRY_AFTER = timedelta(seconds=30)


@dataclass(frozen=True)
class BarsResult:
    bars: pd.DataFrame  # BAR_COLUMNS, ascending ts
    has_more: bool


class BarService:
    def __init__(
        self, engine: Engine, provider: MarketDataProvider, *, stats: CacheStats | None = None
    ) -> None:
        self._engine = engine
        self._provider = provider
        self._stats = stats if stats is not None else CacheStats()
        # Series whose last tail refresh failed -> earliest next attempt.
        self._retry_at: dict[tuple[str, str, bool], datetime] = {}
        self._locks: defaultdict[tuple[str, str, bool], threading.Lock] = defaultdict(
            threading.Lock
        )
        self._locks_guard = threading.Lock()

    def get_bars(
        self,
        symbol: str,
        spec: IntervalSpec,
        prepost: bool,
        *,
        start: int | None = None,
        end: int | None = None,
        limit: int = 1000,
        adjusted: bool = False,
        now: datetime | None = None,
    ) -> BarsResult:
        """Return up to `limit` most recent bars with start <= ts < end."""
        symbol = symbol.upper()
        prepost = prepost and spec.intraday
        self.sync(symbol, spec, prepost, now=now, end=end)
        with Session(self._engine) as s:
            q = select(Bar).where(
                Bar.symbol == symbol, Bar.interval == spec.name, Bar.prepost == prepost
            )
            if start is not None:
                q = q.where(Bar.ts >= start)
            if end is not None:
                q = q.where(Bar.ts < end)
            rows = s.scalars(q.order_by(Bar.ts.desc()).limit(limit + 1)).all()
        has_more = len(rows) > limit
        rows = list(reversed(rows[:limit]))
        df = pd.DataFrame(
            [(r.ts, r.open, r.high, r.low, r.close, r.adj_close, r.volume) for r in rows],
            columns=BAR_COLUMNS,
        )
        if adjusted and not df.empty:
            factor = (df["adj_close"] / df["close"]).where(df["close"] != 0, 1.0)
            for col in ("open", "high", "low", "close"):
                df[col] = df[col] * factor
        return BarsResult(df, has_more)

    def sync(
        self,
        symbol: str,
        spec: IntervalSpec,
        prepost: bool,
        now: datetime | None = None,
        end: int | None = None,
    ) -> None:
        """Bring the cached series up to date for a request ending before `end`.

        Raises only when nothing is cached; a failed tail refresh leaves the cache as is.
        """
        now = now or datetime.now(UTC)
        key = (symbol, spec.name, prepost)
        with self._locks_guard:
            lock = self._locks[key]
        with lock, Session(self._engine) as s:
            meta = s.get(SeriesMeta, key)
            if meta is None:
                self._stats.incr("bars.backfill")
                self._backfill(s, symbol, spec, prepost, now)
            elif now - _aware(meta.tail_fetched_at) < spec.tail_ttl:
                self._stats.incr("bars.fresh")
                return
            elif end is not None and end <= self._newest_ts(s, symbol, spec.name, prepost):
                # Only older bars were asked for; the tail does not matter.
                self._stats.incr("bars.covered")
                return
            elif (retry_at := self._retry_at.get(key)) is not None and now < retry_at:
                self._stats.incr("bars.stale_retry_wait")
                return
            else:
                self._stats.incr("bars.tail_refresh")
                try:
                    self._refresh_tail(s, meta, spec, now)
                except SymbolNotFound:
                    raise
                except ProviderError as exc:
                    s.rollback()
                    if not self._has_bars(s, symbol, spec.name, prepost):
                        raise
                    pause = TAIL_RETRY_AFTER
                    if isinstance(exc, RateLimited):
                        pause = max(pause, timedelta(seconds=exc.retry_after))
                    self._retry_at[key] = now + pause
                    self._stats.incr("bars.stale_error")
                    log.warning(
                        "tail refresh failed for %s %s prepost=%s, serving cached bars: %s",
                        symbol,
                        spec.name,
                        prepost,
                        exc,
                    )
                    return
                self._retry_at.pop(key, None)
            s.commit()

    def _backfill(
        self, s: Session, symbol: str, spec: IntervalSpec, prepost: bool, now: datetime
    ) -> None:
        frames: list[pd.DataFrame] = []
        if spec.max_lookback is None:
            frames.append(self._provider.history(symbol, spec.name, None, None, prepost))
        else:
            start = now - spec.max_lookback
            step = spec.chunk or spec.max_lookback
            while start < now:
                stop = min(start + step, now + timedelta(days=1))
                frames.append(self._provider.history(symbol, spec.name, start, stop, prepost))
                start = stop
        df = _concat(frames)
        if df.empty and not self._has_bars(s, symbol, spec.name, prepost):
            raise SymbolNotFound(symbol)
        _upsert(s, symbol, spec.name, prepost, df)
        s.merge(
            SeriesMeta(
                symbol=symbol,
                interval=spec.name,
                prepost=prepost,
                backfilled_at=now,
                tail_fetched_at=now,
            )
        )
        log.info("backfilled %s %s prepost=%s: %d bars", symbol, spec.name, prepost, len(df))

    def _refresh_tail(
        self, s: Session, meta: SeriesMeta, spec: IntervalSpec, now: datetime
    ) -> None:
        symbol, prepost = meta.symbol, meta.prepost
        tail = s.scalars(
            select(Bar)
            .where(Bar.symbol == symbol, Bar.interval == spec.name, Bar.prepost == prepost)
            .order_by(Bar.ts.desc())
            .limit(TAIL_OVERLAP_BARS)
        ).all()
        if not tail:
            self._rebackfill(s, symbol, spec, prepost, now)
            return
        # Calendar-based intervals (weeks, months) need a wider window to see full bars.
        span = max(spec.seconds * (TAIL_OVERLAP_BARS + 1), 4 * 86_400)
        start = datetime.fromtimestamp(tail[-1].ts, UTC) - timedelta(seconds=span)
        fresh = self._provider.history(symbol, spec.name, start, now + timedelta(days=1), prepost)
        if _adjustment_changed(tail, fresh):
            log.info("%s %s history re-adjusted upstream; re-backfilling", symbol, spec.name)
            self._rebackfill(s, symbol, spec, prepost, now)
            return
        _upsert(s, symbol, spec.name, prepost, fresh)
        meta.tail_fetched_at = now

    def _rebackfill(
        self, s: Session, symbol: str, spec: IntervalSpec, prepost: bool, now: datetime
    ) -> None:
        s.execute(
            delete(Bar).where(
                Bar.symbol == symbol, Bar.interval == spec.name, Bar.prepost == prepost
            )
        )
        self._backfill(s, symbol, spec, prepost, now)

    @staticmethod
    def _newest_ts(s: Session, symbol: str, interval: str, prepost: bool) -> int:
        """Newest cached bar's ts, or -1 when the series has no bars."""
        ts = s.scalar(
            select(func.max(Bar.ts)).where(
                Bar.symbol == symbol, Bar.interval == interval, Bar.prepost == prepost
            )
        )
        return -1 if ts is None else int(ts)

    @staticmethod
    def _has_bars(s: Session, symbol: str, interval: str, prepost: bool) -> bool:
        n = s.scalar(
            select(func.count())
            .select_from(Bar)
            .where(Bar.symbol == symbol, Bar.interval == interval, Bar.prepost == prepost)
        )
        return bool(n)


def _aware(dt: datetime) -> datetime:
    # SQLite drops tzinfo on round-trip.
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _concat(frames: list[pd.DataFrame]) -> pd.DataFrame:
    frames = [f for f in frames if not f.empty]
    if not frames:
        return pd.DataFrame(columns=BAR_COLUMNS)
    df = pd.concat(frames, ignore_index=True)
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


def _adjustment_changed(cached: Sequence[Bar], fresh: pd.DataFrame) -> bool:
    """True if a closed bar we already have now has different close/adj_close.

    The newest cached bar is skipped because it may still be forming.
    """
    if fresh.empty:
        return False
    by_ts: dict[int, tuple[float, float]] = dict(
        zip(
            fresh["ts"].astype("int64").tolist(),
            zip(fresh["close"].tolist(), fresh["adj_close"].tolist(), strict=True),
            strict=True,
        )
    )
    for bar in cached[1:]:
        if bar.ts not in by_ts:
            continue
        close, adj_close = by_ts[bar.ts]
        for old, new in ((bar.close, close), (bar.adj_close, adj_close)):
            if not math.isclose(old, new, rel_tol=REL_TOLERANCE):
                return True
    return False


def _upsert(s: Session, symbol: str, interval: str, prepost: bool, df: pd.DataFrame) -> None:
    if df.empty:
        return
    insert = pg_insert if s.get_bind().dialect.name == "postgresql" else sqlite_insert
    cols = ("open", "high", "low", "close", "adj_close", "volume")
    key = {"symbol": symbol, "interval": interval, "prepost": prepost}
    values = zip(
        df["ts"].astype("int64").tolist(),
        *(df[c].astype(float).tolist() for c in cols),
        strict=True,
    )
    records = [{**key, "ts": row[0], **dict(zip(cols, row[1:], strict=True))} for row in values]
    for i in range(0, len(records), UPSERT_BATCH):
        stmt = insert(Bar).values(records[i : i + UPSERT_BATCH])
        stmt = stmt.on_conflict_do_update(
            index_elements=["symbol", "interval", "prepost", "ts"],
            set_={
                c: stmt.excluded[c] for c in ("open", "high", "low", "close", "adj_close", "volume")
            },
        )
        s.execute(stmt)
