"""Bar cache: serves bars from the DB and keeps it in sync with the provider.

First request for a series backfills everything the provider allows. Later
requests only refetch the tail once it is older than the interval's TTL, and not
at all when the requested range ends before the newest cached bar. A tail refresh
refetches a few closed bars already cached and compares them (`_classify_overlap`):

- daily and longer intervals (full history in one request): any change wipes the
  series and backfills it again;
- intraday, every compared bar scaled by one ratio (a split or re-adjustment): the
  older stored bars are rescaled locally, keeping history beyond the provider's
  lookback;
- intraday, other changes (the provider revised recent bars): the fresh bars are
  upserted, nothing else.

When a tail refresh fails, the cached bars are served and the refresh is retried
after a short pause. Upstream calls happen before any write of the same sync, so no
database write lock is held across network I/O, and a re-backfill replaces the series
only once its fresh bars are in hand. A tail that reaches back further than one request
may span (a series not read for a while) is caught up in chunks, keeping older bars.

A series the provider has no bars for is remembered as unknown for
`TailPolicy.unknown_symbol_ttl_s`; a chunked backfill stops after an empty newest chunk
unless the symbol is known (stored metadata).

With a `session_lookup` the tail TTL follows the market session (see
`services.sessions`): refreshes at the TTL while open, one final refresh after the
close, none until the next open, and a growing pause for series that stop receiving
bars. The schedule is stored in `SeriesMeta.next_check_at`.

`BarService.prune` bounds storage: it deletes series unused past a retention period
and, over a row budget, the least recently used series (intraday first).
"""

import logging
import math
import statistics
import threading
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast

import pandas as pd
from sqlalchemy import CursorResult, Engine, Result, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..intervals import INTERVALS, IntervalSpec
from ..models import Bar, SeriesMeta
from ..providers.base import (
    BAR_COLUMNS,
    MarketDataProvider,
    ProviderError,
    ProviderUnsupported,
    RateLimited,
    SymbolNotFound,
)
from ..settings import Settings
from .cache_gate import CacheGate, CacheRetired
from .sessions import (
    METADATA_MAX_AGE,
    QUIET_STREAK_MAX,
    TradingHours,
    newer_bar_due,
    next_check_at,
)
from .stats import CacheStats

log = logging.getLogger(__name__)

# Bars refetched before the newest cached bar, to detect retroactive adjustments.
TAIL_OVERLAP_BARS = 3
#: Two prices closer than this (relative) are the same price.
REL_TOLERANCE = 1e-6
#: Per-bar price ratios closer than this (relative) are one ratio (prices are rounded).
RATIO_TOLERANCE = 1e-4
#: Closed overlapping bars that must agree on a ratio before history is rescaled.
MIN_UNIFORM_BARS = 2
UPSERT_BATCH = 2000
# Pause before retrying a failed tail refresh (cached bars are served meanwhile).
TAIL_RETRY_AFTER = timedelta(seconds=30)
# `SeriesMeta.last_accessed_at` is written at most this often per series.
ACCESS_TOUCH_EVERY = timedelta(hours=1)
#: Over the row budget, series are evicted until this share of it is left.
BUDGET_TARGET = 0.9
#: Unknown series remembered at most (expired ones are dropped first, then the oldest).
UNKNOWN_MAX_ENTRIES = 4096

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
    #: How long a series without any upstream bars is answered "not found" from memory.
    unknown_symbol_ttl_s: float = 3600

    @classmethod
    def from_settings(cls, settings: Settings) -> "TailPolicy":
        return cls(
            tail_ttl_intraday_s=settings.bars_tail_ttl_intraday_s,
            tail_ttl_daily_s=settings.bars_tail_ttl_daily_s,
            settle_after_close_s=settings.bars_settle_after_close_s,
            quiet_backoff_max_s=settings.bars_quiet_backoff_max_s,
            unknown_symbol_ttl_s=settings.cache_negative_ttl_s,
        )


@dataclass(frozen=True)
class Same:
    """The refetched closed bars match the cached ones."""


@dataclass(frozen=True)
class Uniform:
    """Every refetched closed bar is the cached one scaled: `close` (and open, high, low)
    by `rc`, `adj_close` by `ra`. A split or a re-adjustment of the whole history."""

    rc: float
    ra: float


@dataclass(frozen=True)
class Mixed:
    """The refetched closed bars changed in no common way: revised bars."""


Overlap = Same | Uniform | Mixed


@dataclass
class PruneReport:
    """What one `BarService.prune` run deleted, per reason. A series is one
    `SeriesMeta` row with its bars; rows are bar rows."""

    intraday_age_series: int = 0
    intraday_age_rows: int = 0
    daily_age_series: int = 0
    daily_age_rows: int = 0
    budget_series: int = 0
    budget_rows: int = 0
    #: Series due for deletion but left alone because a request held their lock.
    skipped_busy: int = 0
    #: Bar rows left after the run.
    rows_remaining: int = 0

    @property
    def series_deleted(self) -> int:
        return self.intraday_age_series + self.daily_age_series + self.budget_series

    @property
    def rows_deleted(self) -> int:
        return self.intraday_age_rows + self.daily_age_rows + self.budget_rows


@dataclass(frozen=True)
class _SeriesUse:
    key: tuple[str, str, bool]
    intraday: bool
    last_used: datetime


class BarService:
    def __init__(
        self,
        engine: Engine,
        provider: MarketDataProvider,
        *,
        stats: CacheStats | None = None,
        session_lookup: SessionLookup | None = None,
        policy: TailPolicy | None = None,
        extended_history: bool = True,
        self_paging: bool = False,
        metadata_max_age: timedelta = METADATA_MAX_AGE,
        gate: CacheGate | None = None,
        generation: int = 0,
    ) -> None:
        self._engine = engine
        self._provider = provider
        # With a gate, commits of this service stop once its `generation` is retired.
        self._gate = gate
        self._generation = generation
        # False: the provider has no pre/post-market bars; `prepost` requests are served
        # (and stored) as regular-session series.
        self._extended_history = extended_history
        # True: `history` pages through a long range itself, so a range is one provider
        # call whatever `IntervalSpec.chunk` (Yahoo's request size) says.
        self._self_paging = self_paging
        # How long stored symbol metadata is trusted to hold today's session.
        self._metadata_max_age = metadata_max_age
        self._stats = stats if stats is not None else CacheStats()
        # None: plain TTL since the last fetch, market hours ignored.
        self._session_lookup = session_lookup
        self._policy = policy
        # Series whose last tail refresh failed -> earliest next attempt.
        self._retry_at: dict[tuple[str, str, bool], datetime] = {}
        # Series the provider had no bars for -> when that answer expires.
        self._unknown: dict[tuple[str, str, bool], datetime] = {}
        # The refusal to answer with while a series is in `_unknown` for being unsupported
        # (the provider cannot serve the symbol), rather than missing.
        self._unsupported: dict[tuple[str, str, bool], ProviderUnsupported] = {}
        # Guards `_retry_at` and `_unknown` (prune sweeps them from another thread).
        self._maps_guard = threading.Lock()
        # One lock per series (see `_series_lock`); `_evict` drops those of deleted series.
        self._locks: dict[tuple[str, str, bool], threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._last_request_at: datetime | None = None

    @property
    def last_request_at(self) -> datetime | None:
        """`now` of the latest bar request, None before the first."""
        return self._last_request_at

    def _lock_for(self, key: tuple[str, str, bool]) -> threading.Lock:
        """The series' registered lock, created when missing."""
        with self._locks_guard:
            return self._locks.setdefault(key, threading.Lock())

    @contextmanager
    def _series_lock(self, key: tuple[str, str, bool]) -> Iterator[None]:
        """Hold the series' lock. A lock dropped by `_evict` while this waited on it is
        released again and the registered one taken instead (see `_drop_lock`)."""
        while True:
            lock = self._lock_for(key)
            lock.acquire()
            with self._locks_guard:
                if self._locks.get(key) is lock:
                    break
            lock.release()
        try:
            yield
        finally:
            lock.release()

    def _commit(self, s: Session) -> None:
        """Commit the session's cache writes, unless this service's generation is retired:
        then roll back and raise `CacheRetired`. Gates writes that add or change rows only:
        delete-only paths (`_evict`, the maintenance purge) are intentionally ungated, see
        `cache_gate`."""
        if self._gate is None:
            s.commit()
            return
        with self._gate.writing(self._generation) as current:
            if current:
                s.commit()
                return
            s.rollback()
        self._stats.incr("bars.retired_write")
        raise CacheRetired("bars")

    def _ensure_current(self) -> None:
        """Raise `CacheRetired` when this service's generation is retired."""
        if self._gate is not None and self._gate.generation != self._generation:
            self._stats.incr("bars.retired_read")
            raise CacheRetired("bars")

    def effective_prepost(self, spec: IntervalSpec, prepost: bool) -> bool:
        """Whether a `prepost` request is served as pre/post-market bars: only intraday
        series, and only when the provider has them."""
        return prepost and spec.intraday and self._extended_history

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
        prepost = self.effective_prepost(spec, prepost)
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
        # `sync` may have finished before a switch wiped the cache: rows read after the
        # wipe are not this service's provider's.
        self._ensure_current()
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
        self._last_request_at = now
        key = (symbol, spec.name, prepost)
        info = self._session_lookup(symbol) if self._session_lookup is not None else None
        hours = (
            TradingHours.from_symbol_info(
                info, prepost=prepost, now=now, max_age=self._metadata_max_age
            )
            if info is not None
            else None
        )
        with self._series_lock(key), Session(self._engine) as s:
            meta = s.get(SeriesMeta, key)
            if meta is None:
                if self._known_unknown(key, now):
                    self._stats.incr("bars.unknown_cached")
                    with self._maps_guard:
                        refusal = self._unsupported.get(key)
                    raise refusal if refusal is not None else SymbolNotFound(symbol)
                self._stats.incr("bars.backfill")
                try:
                    self._backfill(s, symbol, spec, prepost, now, known=info is not None)
                except SymbolNotFound:
                    self._remember_unknown(key, now)
                    raise
                except ProviderUnsupported as exc:
                    # Like an unknown symbol: asking again cannot change the answer.
                    self._remember_unknown(key, now, exc)
                    raise
                if self._session_lookup is not None:
                    self._schedule(s, key, spec, info, hours, now, newest_before=None)
                self._commit(s)
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
            elif self._retry_pending(key, now):
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
                    with self._maps_guard:
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
                    self._commit(s)
                    return
                with self._maps_guard:
                    self._retry_at.pop(key, None)
                if self._session_lookup is not None:
                    self._schedule(s, key, spec, info, hours, now, newest_before=newest_before)
            self._touch(s, meta, now)
            self._commit(s)

    def _retry_pending(self, key: tuple[str, str, bool], now: datetime) -> bool:
        """True while a failed tail refresh waits for its retry; drops expired pauses."""
        with self._maps_guard:
            retry_at = self._retry_at.get(key)
            if retry_at is None:
                return False
            if now < retry_at:
                return True
            del self._retry_at[key]
            return False

    def _known_unknown(self, key: tuple[str, str, bool], now: datetime) -> bool:
        """True while the provider's "no bars" answer for the series is remembered."""
        with self._maps_guard:
            until = self._unknown.get(key)
            if until is None:
                return False
            if now < until:
                return True
            del self._unknown[key]
            return False

    def _remember_unknown(
        self, key: tuple[str, str, bool], now: datetime, refusal: ProviderUnsupported | None = None
    ) -> None:
        p = self._policy if self._policy is not None else TailPolicy()
        with self._maps_guard:
            self._unknown[key] = now + timedelta(seconds=p.unknown_symbol_ttl_s)
            if refusal is not None:
                self._unsupported[key] = refusal
            else:
                self._unsupported.pop(key, None)
            if len(self._unknown) > UNKNOWN_MAX_ENTRIES:
                _drop_expired(self._unknown, now)
            while len(self._unknown) > UNKNOWN_MAX_ENTRIES:
                del self._unknown[next(iter(self._unknown))]
            self._unsupported = {k: v for k, v in self._unsupported.items() if k in self._unknown}

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
        self,
        s: Session,
        symbol: str,
        spec: IntervalSpec,
        prepost: bool,
        now: datetime,
        *,
        known: bool,
    ) -> None:
        df = self._fetch_full(symbol, spec, prepost, now, known=known)
        if df.empty and not self._has_bars(s, symbol, spec.name, prepost):
            raise SymbolNotFound(symbol)
        self._store_full(s, symbol, spec, prepost, now, df)

    def _fetch_full(
        self, symbol: str, spec: IntervalSpec, prepost: bool, now: datetime, *, known: bool
    ) -> pd.DataFrame:
        """All the history the provider serves. Unless the symbol is `known` to exist, an
        empty newest chunk ends a chunked fetch (an unknown symbol costs one call)."""
        if spec.max_lookback is None:
            return _concat([self._provider.history(symbol, spec.name, None, None, prepost)])
        start = now - spec.max_lookback
        if self._chunk(spec) is None:
            return _concat([self._provider.history(symbol, spec.name, start, now, prepost)])
        return self._fetch_range(
            symbol,
            spec,
            prepost,
            start,
            now + timedelta(days=1),
            stop_if_newest_empty=not known,
            keep_partial=True,
        )

    def _chunk(self, spec: IntervalSpec) -> timedelta | None:
        """Longest span of one provider call (None: the whole range at once)."""
        return None if self._self_paging else spec.chunk

    def _fetch_range(
        self,
        symbol: str,
        spec: IntervalSpec,
        prepost: bool,
        start: datetime,
        end: datetime,
        *,
        stop_if_newest_empty: bool = False,
        keep_partial: bool = False,
    ) -> pd.DataFrame:
        """Bars in [start, end), in requests of at most the chunk, newest first.

        With `keep_partial` (a backfill), a chunk failing after others came ends the fetch:
        the newer bars are kept and the older history is simply shorter."""
        chunk = self._chunk(spec)
        if chunk is None:
            return _concat([self._provider.history(symbol, spec.name, start, end, prepost)])
        frames: list[pd.DataFrame] = []
        stop = end
        while stop > start:
            begin = max(stop - chunk, start)
            try:
                frame = self._provider.history(symbol, spec.name, begin, stop, prepost)
            except ProviderError as exc:
                if not keep_partial or not any(len(f) for f in frames):
                    raise
                self._stats.incr("bars.partial_backfill")
                log.warning(
                    "backfill of %s %s stopped at %s, keeping the newer bars: %s",
                    symbol,
                    spec.name,
                    begin,
                    exc,
                )
                break
            if not frames and frame.empty and stop_if_newest_empty:
                break
            frames.append(frame)
            stop = begin
        return _concat(frames)

    def _store_full(
        self,
        s: Session,
        symbol: str,
        spec: IntervalSpec,
        prepost: bool,
        now: datetime,
        df: pd.DataFrame,
    ) -> None:
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
        end = now + timedelta(days=1)
        if spec.max_lookback is not None and start < now - spec.max_lookback:
            # Not read for longer than the provider's lookback: catch up what it still
            # serves; the older cached bars stay (with a gap before the fresh ones).
            start = now - spec.max_lookback
            self._stats.incr("bars.tail_catch_up")
        elif (chunk := self._chunk(spec)) is not None and end - start > chunk:
            self._stats.incr("bars.tail_catch_up")
        fresh = self._fetch_range(symbol, spec, prepost, start, end)
        overlap = _classify_overlap(tail, fresh)
        if isinstance(overlap, Same):
            self._stats.incr("bars.overlap_same")
        elif spec.max_lookback is None:
            # Full history is a single request: refetch it so every bar matches upstream.
            log.info("%s %s history changed upstream; re-backfilling", symbol, spec.name)
            self._rebackfill(s, symbol, spec, prepost, now)
            return
        elif isinstance(overlap, Uniform):
            # The provider serves only a window of intraday history; rescaling keeps the rest.
            self._stats.incr("bars.overlap_rescaled")
            log.info(
                "%s %s prepost=%s history rescaled upstream (close x%g, adj_close x%g); "
                "rescaling cached bars",
                symbol,
                spec.name,
                prepost,
                overlap.rc,
                overlap.ra,
            )
            _rescale(s, symbol, spec.name, prepost, overlap)
        else:
            self._stats.incr("bars.overlap_revised")
        _upsert(s, symbol, spec.name, prepost, fresh)
        meta.tail_fetched_at = now

    def _rebackfill(
        self, s: Session, symbol: str, spec: IntervalSpec, prepost: bool, now: datetime
    ) -> None:
        self._stats.incr("bars.rebackfill")
        # Fetch before the DELETE: that takes the SQLite write lock, which must not be held
        # across network I/O, and an empty answer must not wipe the cached bars.
        df = self._fetch_full(symbol, spec, prepost, now, known=True)
        if df.empty:
            if self._has_bars(s, symbol, spec.name, prepost):
                # The series exists: a transient upstream glitch, served stale by `sync`.
                raise ProviderError(f"re-backfill of {symbol} {spec.name} returned no bars")
            raise SymbolNotFound(symbol)
        s.execute(
            delete(Bar).where(
                Bar.symbol == symbol, Bar.interval == spec.name, Bar.prepost == prepost
            )
        )
        self._store_full(s, symbol, spec, prepost, now, df)

    def prune(
        self,
        now: datetime | None = None,
        *,
        max_rows: int,
        intraday_retention_days: float,
        daily_retention_days: float,
        protect_s: float = 86_400,
    ) -> PruneReport:
        """Delete cached series to bound storage, in this order:

        1. intraday series unused for `intraday_retention_days`;
        2. daily and longer series unused for `daily_retention_days`;
        3. while the bar rows exceed `max_rows`, the least recently used series,
           intraday first, until at most `BUDGET_TARGET` of `max_rows` are left.

        "Used" is `last_accessed_at`, or `backfilled_at` when never recorded. A series
        used within `protect_s` is never deleted, nor one a request is syncing right now
        (its lock is busy). Each series is deleted in its own transaction, so this can
        run in the background while requests are served. Expired retry pauses and
        unknown-series entries are dropped, and so are the locks of deleted series.
        """
        now = (now or datetime.now(UTC)).astimezone(UTC)
        protect_from = now - timedelta(seconds=protect_s)
        report = PruneReport()
        with self._maps_guard:
            _drop_expired(self._retry_at, now)
            _drop_expired(self._unknown, now)
            self._unsupported = {k: v for k, v in self._unsupported.items() if k in self._unknown}

        uses = self._series_uses()
        for intraday, days in ((True, intraday_retention_days), (False, daily_retention_days)):
            cutoff = min(now - timedelta(days=days), protect_from)
            for use in uses:
                if use.intraday != intraday or use.last_used >= cutoff:
                    continue
                rows = self._evict(use.key, cutoff, report)
                if rows is None:
                    continue
                if intraday:
                    report.intraday_age_series += 1
                    report.intraday_age_rows += rows
                else:
                    report.daily_age_series += 1
                    report.daily_age_rows += rows

        total = sum(self._row_counts().values())
        if total > max_rows:
            target = int(max_rows * BUDGET_TARGET)
            candidates = sorted(
                (u for u in self._series_uses() if u.last_used < protect_from),
                key=lambda u: (not u.intraday, u.last_used),
            )
            for use in candidates:
                if total <= target:
                    break
                rows = self._evict(use.key, protect_from, report)
                if rows is None:
                    continue
                total -= rows
                report.budget_series += 1
                report.budget_rows += rows
        report.rows_remaining = total

        self._stats.incr("bars.pruned_series", report.series_deleted)
        self._stats.incr("bars.pruned_rows", report.rows_deleted)
        if report.series_deleted or report.skipped_busy:
            log.info(
                "pruned %d series (%d bars), %d busy skipped, %d bars left",
                report.series_deleted,
                report.rows_deleted,
                report.skipped_busy,
                report.rows_remaining,
            )
        return report

    def prune_with_settings(self, settings: Settings, now: datetime | None = None) -> PruneReport:
        """`prune` with the bar storage bounds from `settings`."""
        return self.prune(
            now,
            max_rows=settings.bars_max_rows,
            intraday_retention_days=settings.bars_intraday_retention_days,
            daily_retention_days=settings.bars_daily_retention_days,
        )

    def _series_uses(self) -> list[_SeriesUse]:
        with Session(self._engine) as s:
            rows = s.execute(
                select(
                    SeriesMeta.symbol,
                    SeriesMeta.interval,
                    SeriesMeta.prepost,
                    SeriesMeta.last_accessed_at,
                    SeriesMeta.backfilled_at,
                )
            ).all()
        uses: list[_SeriesUse] = []
        for symbol, interval, prepost, accessed, backfilled in rows:
            spec = INTERVALS.get(interval)
            uses.append(
                _SeriesUse(
                    key=(symbol, interval, prepost),
                    # An interval no longer served cannot be read again: evict it early.
                    intraday=spec is None or spec.intraday,
                    last_used=_last_used(accessed, backfilled),
                )
            )
        return uses

    def _row_counts(self) -> dict[tuple[str, str, bool], int]:
        """Bar rows per series."""
        with Session(self._engine) as s:
            rows = s.execute(
                select(Bar.symbol, Bar.interval, Bar.prepost, func.count()).group_by(
                    Bar.symbol, Bar.interval, Bar.prepost
                )
            ).all()
        return {(symbol, interval, prepost): n for symbol, interval, prepost, n in rows}

    def _evict(
        self, key: tuple[str, str, bool], used_before: datetime, report: PruneReport
    ) -> int | None:
        """Delete the series' bars and meta if it is still unused since `used_before`.

        Returns the bar rows deleted, or None when skipped: the lock is busy (counted in
        `report`), the series is gone, or it was used meanwhile.
        """
        lock = self._lock_for(key)
        if not lock.acquire(blocking=False):
            report.skipped_busy += 1
            return None
        try:
            with self._locks_guard:
                if self._locks.get(key) is not lock:  # dropped meanwhile: series gone
                    return None
            with Session(self._engine) as s:
                meta = s.get(SeriesMeta, key)
                if meta is None:
                    self._drop_lock(key)
                    return None
                if _last_used(meta.last_accessed_at, meta.backfilled_at) >= used_before:
                    return None
                symbol, interval, prepost = key
                rows = _rowcount(
                    s.execute(
                        delete(Bar).where(
                            Bar.symbol == symbol, Bar.interval == interval, Bar.prepost == prepost
                        )
                    )
                )
                s.execute(
                    delete(SeriesMeta).where(
                        SeriesMeta.symbol == symbol,
                        SeriesMeta.interval == interval,
                        SeriesMeta.prepost == prepost,
                    )
                )
                s.commit()
            with self._maps_guard:
                self._retry_at.pop(key, None)
            self._drop_lock(key)
            return rows
        finally:
            lock.release()

    def _drop_lock(self, key: tuple[str, str, bool]) -> None:
        """Forget the lock of a deleted series. The caller holds that lock.

        Safe because only a lock's holder ever removes it, so the registered lock of a
        key cannot change while anyone is inside `_series_lock`. A request already
        waiting on the dropped lock finds it unregistered once it gets it, lets go and
        takes the registered (new) lock instead: at most one request per series runs.
        """
        with self._locks_guard:
            self._locks.pop(key, None)

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


def _last_used(accessed: datetime | None, backfilled: datetime) -> datetime:
    """When a series was last read; series cached before access tracking: when cached."""
    return _aware(accessed if accessed is not None else backfilled)


def _drop_expired(deadlines: dict[tuple[str, str, bool], datetime], now: datetime) -> None:
    """Remove entries whose deadline has passed (caller holds the map's guard)."""
    for key in [k for k, until in deadlines.items() if until <= now]:
        del deadlines[key]


def _rowcount(result: Result[Any]) -> int:
    """Rows matched by a Core UPDATE/DELETE executed through the session."""
    return cast(CursorResult[Any], result).rowcount


def _concat(frames: list[pd.DataFrame]) -> pd.DataFrame:
    frames = [f for f in frames if not f.empty]
    if not frames:
        return pd.DataFrame(columns=BAR_COLUMNS)
    df = pd.concat(frames, ignore_index=True)
    return df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)


def _classify_overlap(cached: Sequence[Bar], fresh: pd.DataFrame) -> Overlap:
    """How the cached closed bars changed in the refetched `fresh` frame.

    `cached` is newest first; its newest bar may still be forming and is skipped. Only
    `close` and `adj_close` are compared. A single changed bar is `Mixed`: one bar
    cannot tell a split from a revision.
    """
    if fresh.empty:
        return Same()
    by_ts: dict[int, tuple[float, float]] = dict(
        zip(
            fresh["ts"].astype("int64").tolist(),
            zip(fresh["close"].tolist(), fresh["adj_close"].tolist(), strict=True),
            strict=True,
        )
    )
    pairs = [((bar.close, bar.adj_close), by_ts[bar.ts]) for bar in cached[1:] if bar.ts in by_ts]
    if all(
        math.isclose(old, new, rel_tol=REL_TOLERANCE)
        for olds, news in pairs
        for old, new in zip(olds, news, strict=True)
    ):
        return Same()
    if len(pairs) < MIN_UNIFORM_BARS:
        return Mixed()
    ratios: list[tuple[float, float]] = []
    for (old_c, old_a), (new_c, new_a) in pairs:
        if old_c == 0 or old_a == 0:
            return Mixed()
        rc, ra = new_c / old_c, new_a / old_a
        if not (math.isfinite(rc) and math.isfinite(ra) and rc > 0 and ra > 0):
            return Mixed()
        ratios.append((rc, ra))
    rc = statistics.fmean(r[0] for r in ratios)
    ra = statistics.fmean(r[1] for r in ratios)
    if all(
        math.isclose(c, rc, rel_tol=RATIO_TOLERANCE)
        and math.isclose(a, ra, rel_tol=RATIO_TOLERANCE)
        for c, a in ratios
    ):
        return Uniform(rc, ra)
    return Mixed()


def _rescale(s: Session, symbol: str, interval: str, prepost: bool, by: Uniform) -> None:
    """Scale every stored bar of the series as `by` describes; the refetched bars are
    upserted over theirs afterwards. Prices scale by the close ratio and `adj_close` by
    its own (adjusted OHLC is derived from adj_close / close at read time); volume scales
    inversely, as a split multiplies the share count."""
    s.execute(
        update(Bar)
        .where(Bar.symbol == symbol, Bar.interval == interval, Bar.prepost == prepost)
        .values(
            open=Bar.open * by.rc,
            high=Bar.high * by.rc,
            low=Bar.low * by.rc,
            close=Bar.close * by.rc,
            adj_close=Bar.adj_close * by.ra,
            volume=Bar.volume / by.rc,
        )
        .execution_options(synchronize_session=False)
    )


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
