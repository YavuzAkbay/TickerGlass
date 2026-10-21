"""Bar cache: serves bars from the DB and keeps it in sync with the provider.

First request for a series backfills everything the provider allows. Later
requests only refetch the tail once it is older than the interval's TTL, and not
at all when the requested range ends before the newest cached bar. If the
overlapping bar changed (split or dividend re-adjustment), the series is wiped
and backfilled again. When a tail refresh fails, the cached bars are served and
the refresh is retried after a short pause.

With a `session_lookup` the tail TTL follows the market session (see
`services.sessions`): refreshes at the TTL while open, one final refresh after the
close, none until the next open, and a growing pause for series that stop receiving
bars. The schedule is stored in `SeriesMeta.next_check_at`.
"""

import logging
import math
import threading
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pandas as pd
from sqlalchemy import Engine, delete, func, or_, select, update
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
from ..settings import Settings
from .sessions import QUIET_STREAK_MAX, TradingHours, newer_bar_due, next_check_at
from .stats import CacheStats

log = logging.getLogger(__name__)

# Bars refetched before the newest cached bar, to detect retroactive adjustments.
TAIL_OVERLAP_BARS = 3
REL_TOLERANCE = 1e-6
UPSERT_BATCH = 2000
# Pause before retrying a failed tail refresh (cached bars are served meanwhile).
TAIL_RETRY_AFTER = timedelta(seconds=30)
# `SeriesMeta.last_accessed_at` is written at most this often per series.
ACCESS_TOUCH_EVERY = timedelta(hours=1)

#: Stored metadata of a symbol (`SymbolService.cached_info`), None when unknown.
SessionLookup = Callable[[str], dict[str, Any] | None]


@dataclass(frozen=True)
class BarsResult:
    bars: pd.DataFrame  # BAR_COLUMNS, ascending ts
    has_more: bool


@dataclass(frozen=True)
class TailPolicy:
    """Tail refresh timing, seconds. The TTLs replace `IntervalSpec.tail_ttl`."""

    tail_ttl_intraday_s: float = 30
    tail_ttl_daily_s: float = 300
    settle_after_close_s: float = 1200
    quiet_backoff_max_s: float = 1800

    @classmethod
    def from_settings(cls, settings: Settings) -> "TailPolicy":
        return cls(
            tail_ttl_intraday_s=settings.bars_tail_ttl_intraday_s,
            tail_ttl_daily_s=settings.bars_tail_ttl_daily_s,
            settle_after_close_s=settings.bars_settle_after_close_s,
            quiet_backoff_max_s=settings.bars_quiet_backoff_max_s,
        )


class BarService:
    def __init__(
        self,
        engine: Engine,
        provider: MarketDataProvider,
        *,
        stats: CacheStats | None = None,
        session_lookup: SessionLookup | None = None,
        policy: TailPolicy | None = None,
    ) -> None:
        self._engine = engine
        self._provider = provider
        self._stats = stats if stats is not None else CacheStats()
        # None: plain TTL since the last fetch, market hours ignored.
        self._session_lookup = session_lookup
        self._policy = policy
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
        now = (now or datetime.now(UTC)).astimezone(UTC)
        key = (symbol, spec.name, prepost)
        info = self._session_lookup(symbol) if self._session_lookup is not None else None
        hours = TradingHours.from_symbol_info(info, prepost=prepost) if info is not None else None
        with self._locks_guard:
            lock = self._locks[key]
        with lock, Session(self._engine) as s:
            meta = s.get(SeriesMeta, key)
            if meta is None:
                self._stats.incr("bars.backfill")
                self._backfill(s, symbol, spec, prepost, now)
                if self._session_lookup is not None:
                    self._schedule(s, key, spec, info, hours, now, newest_before=None)
                s.commit()
                return
            if now < self._due_at(meta, spec, info, hours):
                if self._session_lookup is None:
                    self._stats.incr("bars.fresh")
                elif hours is not None and not hours.is_open(now):
                    self._stats.incr("bars.tail_skipped_closed")
                else:
                    self._stats.incr("bars.tail_skipped_fresh")
            elif end is not None and end <= self._newest_ts(s, symbol, spec.name, prepost):
                # Only older bars were asked for; the tail does not matter.
                self._stats.incr("bars.covered")
            elif (retry_at := self._retry_at.get(key)) is not None and now < retry_at:
                self._stats.incr("bars.stale_retry_wait")
            else:
                self._stats.incr("bars.tail_refresh")
                newest_before = (
                    self._newest_ts(s, symbol, spec.name, prepost)
                    if self._session_lookup is not None
                    else None
                )
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
                    meta = s.get(SeriesMeta, key)
                    if meta is not None:
                        self._touch(s, meta, now)
                    s.commit()
                    return
                self._retry_at.pop(key, None)
                if self._session_lookup is not None:
                    self._schedule(s, key, spec, info, hours, now, newest_before=newest_before)
            self._touch(s, meta, now)
            s.commit()

    def _ttl(self, spec: IntervalSpec) -> timedelta:
        if self._policy is None:
            return spec.tail_ttl
        p = self._policy
        return timedelta(seconds=p.tail_ttl_intraday_s if spec.intraday else p.tail_ttl_daily_s)

    def _due_at(
        self,
        meta: SeriesMeta,
        spec: IntervalSpec,
        info: dict[str, Any] | None,
        hours: TradingHours | None,
    ) -> datetime:
        """When the series' tail is next due for a refresh."""
        fetched = _aware(meta.tail_fetched_at)
        if self._session_lookup is None:
            return fetched + self._ttl(spec)
        if meta.next_check_at is not None:
            return _aware(meta.next_check_at)
        # Not scheduled yet (series cached before scheduling existed): as if just fetched.
        return self._next_check(spec, info, hours, fetched, meta.quiet_streak, None)

    def _next_check(
        self,
        spec: IntervalSpec,
        info: dict[str, Any] | None,
        hours: TradingHours | None,
        fetched: datetime,
        quiet_streak: int,
        newest_ts: int | None,
    ) -> datetime:
        ttl = self._ttl(spec)
        if info is None:
            # Symbol metadata not stored (yet): plain TTL.
            return fetched + ttl
        p = self._policy if self._policy is not None else TailPolicy()
        due = next_check_at(
            hours,
            ttl.total_seconds(),
            fetched,
            fetched,
            quiet_streak,
            p.settle_after_close_s,
            p.quiet_backoff_max_s,
            newest_ts=newest_ts,
        )
        # In the exchange time zone; stored as UTC (SQLite drops the offset).
        return due.astimezone(UTC)

    def _schedule(
        self,
        s: Session,
        key: tuple[str, str, bool],
        spec: IntervalSpec,
        info: dict[str, Any] | None,
        hours: TradingHours | None,
        now: datetime,
        *,
        newest_before: int | None,
    ) -> None:
        """Record when the series fetched at `now` is next due, and whether it is quiet:
        open, yet the fetch brought no bar newer than `newest_before` though one is due."""
        meta = s.get(SeriesMeta, key)
        if meta is None:
            return
        symbol, interval, prepost = key
        newest = self._newest_ts(s, symbol, interval, prepost)
        quiet = (
            info is not None
            and newest_before is not None
            and newest >= 0
            and newest <= newest_before
            and (hours is None or hours.is_open(now))
            and newer_bar_due(hours, newest, spec.seconds, now)
        )
        if quiet:
            self._stats.incr("bars.tail_quiet")
            meta.quiet_streak = min(meta.quiet_streak + 1, QUIET_STREAK_MAX)
        else:
            meta.quiet_streak = 0
        meta.next_check_at = self._next_check(
            spec, info, hours, now, meta.quiet_streak, newest if newest >= 0 else None
        )

    def _touch(self, s: Session, meta: SeriesMeta, now: datetime) -> None:
        """Mark the series as used, at most once per `ACCESS_TOUCH_EVERY`."""
        last = meta.last_accessed_at
        if last is not None and now - _aware(last) < ACCESS_TOUCH_EVERY:
            return
        # Conditional, so concurrent requests (other processes included) write once.
        s.execute(
            update(SeriesMeta)
            .where(
                SeriesMeta.symbol == meta.symbol,
                SeriesMeta.interval == meta.interval,
                SeriesMeta.prepost == meta.prepost,
                or_(
                    SeriesMeta.last_accessed_at.is_(None),
                    SeriesMeta.last_accessed_at < now - ACCESS_TOUCH_EVERY,
                ),
            )
            .values(last_accessed_at=now)
            .execution_options(synchronize_session=False)
        )

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
                quiet_streak=0,
                last_accessed_at=now,
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
