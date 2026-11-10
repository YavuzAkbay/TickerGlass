"""The screener job: nightly snapshots of every tracked symbol (docs/design/server-screener.md
§2, §5, §9).

`ScreenerJob` belongs to a `MarketStack` and is started/stopped by `ProviderSwitcher` like
`CacheMaintenance`. It runs as one asyncio task; upstream calls and database work go to
worker threads, so the event loop is never blocked.

Schedule. Every NYSE trading day at `screener_run_at` in `screener_tz` (and once shortly
after start), unless a `done` run of that kind for the target date exists: a snapshot run,
then (when the provider has `ScreenInfoProvider`) a fundamentals run. The target date is the
latest completed trading session in `screener_tz`: its close (16:00, 13:00 on an early close)
plus `bars_settle_after_close_s`, weekends and NYSE holidays skipped (`services/holidays.py`,
plus `market_extra_holidays` for one-off closures). A holiday is neither a target nor a
scheduled run day; crypto symbols are unaffected (their bars follow UTC days). `trigger` starts
a run at once; a manual one is refused (`RunInProgress`) for `FUNDAMENTALS_COOLDOWN` after a
`done` fundamentals run of the target, and for `SNAPSHOT_COOLDOWN` after a `done` snapshot run
of it while nothing is stale.

Snapshot run. Work queue = tracked symbols (`universe.tracked_symbols`) whose snapshot is
missing or has `as_of_date` before the target, unless it was already computed after the
target's close (a symbol not trading): oldest first, so a restart resumes where
it stopped. Per symbol: `BarService.get_bars(sym, 1d, limit=450)` at `background` priority,
`technicals.compute_snapshot`, upsert into `screener_snapshots`.

Pacing and limits (`RunControl`):
- after each upstream call, sleep `requests * 60 / rate` with the requests it made (the
  `upstream.*.requests` counters of `CacheStats`; cache hits cost nothing) and
  `rate = min(screener_rate_per_min, guard.sustainable_rate_per_min() / 3)`;
- a refusal by the guard (budget kept for more urgent calls) waits its `retry_after` and
  retries: it is not a failure; a wait over `MAX_WAIT_S` (daily credits) ends the run
  `partial`;
- while a breaker is open the run pauses;
- `MAX_RATE_LIMITS` upstream rate limits in one run abort it;
- with a daily credit limit (Twelve Data) the job stops (`partial`) after spending
  `CREDIT_SHARE` of it in a UTC day.
`SymbolNotFound` bumps `screener_symbols.fail_count` (`TOMBSTONE_AFTER` in a row tombstone
the symbol; a bundle update clears it); other errors are logged and the run goes on.

A run holds the `job_leases` row 'screener' (renewed every 60 s; lost: the run aborts), and is
logged in `screener_runs` (newest `KEEP_RUNS` kept). Status: `done` (all processed, no
failures), `partial` (failures, or stopped by a budget), `aborted` (rate limits, lease lost,
stopped by a provider switch or shutdown), `failed` (the job itself broke). Whoever acquires
the lease marks `running` rows left by a process that exited mid-run `aborted`. After a `done`
or `partial` snapshot run, `services.screener.alerts.evaluate_screens` is called (if present)
with `complete` true for `done` only.
"""

import asyncio
import contextlib
import importlib
import logging
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal, TypeVar
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd
from sqlalchemy import Engine, delete, select, update
from sqlalchemy.orm import Session

from ...intervals import INTERVALS
from ...models import ScreenerRun, ScreenerSnapshot, ScreenerSymbol
from ...providers.base import (
    Capabilities,
    CostModel,
    ProviderError,
    ProviderUnsupported,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from ...providers.guard import GuardedProvider, UpstreamGuard
from ...settings import Settings
from ..bars import TAIL_RETRY_AFTER, BarService
from ..cache_gate import CacheGate, CacheRetired
from ..holidays import is_trading_day
from ..stats import CacheStats
from . import fundamentals
from .lease import RENEW_EVERY, Lease
from .technicals import (
    bar_date,
    compute_snapshot,
    latest_completed_session,
    session_final_at,
)
from .universe import tracked_symbols

log = logging.getLogger(__name__)
T = TypeVar("T")

RunKind = Literal["snapshot", "fundamentals"]
LEASE_NAME = "screener"
#: `screener_runs` rows kept.
KEEP_RUNS = 200
#: Daily bars read per symbol (252 for 52 weeks, 200 for SMA200, plus room).
BARS_LIMIT = 450
#: Delay before the first scheduled check after start-up.
FIRST_RUN_DELAY_S = 60.0
#: Upstream rate limits in one run that abort it.
MAX_RATE_LIMITS = 3
#: Share of a daily credit limit the job may spend per UTC day.
CREDIT_SHARE = 0.30
#: A refusal asking for a longer wait ends the run (`partial`).
MAX_WAIT_S = 900.0
#: Refusals of one call in a row after which the run ends (`partial`).
MAX_REFUSALS = 20
#: Connection failures of one call in a row before it counts as an error.
MAX_UNAVAILABLE = 3
#: `SymbolNotFound` answers in a row that tombstone a symbol.
TOMBSTONE_AFTER = 3
#: Longest single sleep (the lease is renewed between them).
SLEEP_SLICE_S = 30.0
#: Longest single sleep of the scheduler (it re-reads the clock after each).
SCHEDULE_SLICE_S = 900.0
#: Progress is written to `screener_runs` at least this often.
PROGRESS_EVERY_S = 5.0
#: A manual fundamentals run is refused this long after a `done` one of the same target.
FUNDAMENTALS_COOLDOWN = timedelta(hours=1)
#: A manual snapshot run is refused this long after a `done` one of the same target (while
#: no snapshot is due).
SNAPSHOT_COOLDOWN = timedelta(minutes=10)
#: Error of a `running` row found while acquiring the lease.
STALE_RUN_ERROR = "stale (process exit)"
_ERROR_MAX = 500
_LAST_ERROR_MAX = 200


class RunInProgress(Exception):
    """A run is already going (in this process, or another holds the lease)."""


class RunEnded(Exception):
    """Ends a run early with `status` and the message as its error."""

    status = "aborted"


class RunAborted(RunEnded):
    status = "aborted"


class RunStopped(RunEnded):
    """Stopped by a budget: what was done stands (`partial`)."""

    status = "partial"


class RunFailed(RunEnded):
    status = "failed"


def iso(dt: datetime) -> str:
    return _aware(dt).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _aware(dt: datetime) -> datetime:
    # SQLite drops tzinfo on round-trip; stored times are UTC.
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)


@dataclass(frozen=True)
class Counters:
    """Sums of the `upstream.*` counters, and the bar cache's counters of serving cached
    bars after a failed refresh (`stale_error`) or while its retry waits (`stale_wait`)."""

    requests: int = 0
    rate_limited: int = 0
    refused: int = 0
    stale_error: int = 0
    stale_wait: int = 0

    @classmethod
    def read(cls, stats: CacheStats) -> "Counters":
        tree = stats.snapshot().get("upstream", {})
        ops = [node for node in tree.values() if isinstance(node, dict)]
        return cls(
            requests=int(sum(node.get("requests", 0) for node in ops)),
            rate_limited=int(sum(node.get("rate_limited", 0) for node in ops)),
            refused=int(sum(node.get("refused", 0) for node in ops)),
            stale_error=stats.counter("bars.stale_error"),
            stale_wait=stats.counter("bars.stale_retry_wait"),
        )

    def __sub__(self, other: "Counters") -> "Counters":
        return Counters(
            self.requests - other.requests,
            self.rate_limited - other.rate_limited,
            self.refused - other.refused,
            self.stale_error - other.stale_error,
            self.stale_wait - other.stale_wait,
        )


@dataclass
class RunState:
    id: int
    kind: RunKind
    trigger: str
    target: date
    started_at: datetime
    total: int = 0
    done: int = 0
    failed: int = 0
    tokens: int = 0
    rate_limits: int = 0
    status: str = "running"
    error: str | None = None
    #: Job-clock time of the last progress write.
    flushed_at: datetime | None = None
    dirty: bool = field(default=False)


class RunControl:
    """Pacing, budgets and bookkeeping of one run (see the module docstring)."""

    def __init__(self, job: "ScreenerJob", state: RunState) -> None:
        self._job = job
        self.state = state
        #: Counter deltas of the latest `call`.
        self.last_delta = Counters()
        self._renewed_at = job.now()

    def now(self) -> datetime:
        return self._job.now()

    def rate(self, *, info: bool = False) -> float:
        return self._job.rate_per_min(info=info)

    async def sleep(self, seconds: float) -> None:
        """Sleep in slices, renewing the lease in between."""
        left = seconds
        while left > 0:
            step = min(left, SLEEP_SLICE_S)
            await self._job._sleep(step)
            left -= step
            await self._renew_if_due()

    async def _renew_if_due(self) -> None:
        if self._job.stopping:
            raise RunAborted("stopped")
        now = self.now()
        if now - self._renewed_at < RENEW_EVERY:
            return
        if not await asyncio.to_thread(self._job.lease.renew, now):
            raise RunAborted("lost the screener lease to another worker")
        self._renewed_at = now

    async def checkpoint(self) -> None:
        """Before each unit of work: stop, lease, breakers, credit share, progress."""
        await self._renew_if_due()
        snap = self._job.guard.snapshot()
        pause = max(
            float(snap["rateLimitedForS"]) if snap["rateLimited"] else 0.0,
            float(snap["unavailableForS"]) if snap["unavailable"] else 0.0,
        )
        if pause > 0:
            log.info("screener: upstream breaker open, pausing %.0fs", pause)
            await self.sleep(pause)
        daily = snap.get("daily")
        if daily and self._job.tokens_today(self.now()) >= CREDIT_SHARE * daily["limit"]:
            raise RunStopped(f"stopped after {CREDIT_SHARE:.0%} of the daily upstream credits")
        await self.flush(force=False)

    async def call(self, fn: Callable[[], T], *, rate: float, retry_stale: bool = False) -> T:
        """Run `fn` (an upstream call) on a worker thread at `background` priority, retrying
        refusals and short outages, then pace by the requests it made. `retry_stale`: `fn`
        serves cached data when its refresh is refused (BarService), so a refusal seen in the
        counters is retried like a raised one."""
        refusals = unavailable = 0
        while True:
            before = Counters.read(self._job.stats)
            error: BaseException | None = None
            result: T | None = None
            try:
                result = await asyncio.to_thread(self._job.in_background, fn)
            except Exception as exc:
                error = exc
            delta = Counters.read(self._job.stats) - before
            self.last_delta = delta
            self._job.count_tokens(self.now(), delta.requests)
            self.state.tokens += delta.requests
            self.state.dirty = True
            if delta.rate_limited:
                self.state.rate_limits += delta.rate_limited
                log.warning(
                    "screener: upstream rate limited (%d in this run)", self.state.rate_limits
                )
                if self.state.rate_limits >= MAX_RATE_LIMITS:
                    raise RunAborted(f"upstream rate limited {self.state.rate_limits} times")
            wait: float | None = None
            if isinstance(error, RateLimited):
                wait = float(error.retry_after)
            elif isinstance(error, UpstreamUnavailable) and unavailable + 1 < MAX_UNAVAILABLE:
                unavailable += 1
                wait = max(1.0, float(self._job.guard.snapshot()["unavailableForS"]))
            elif (
                error is None
                and retry_stale
                and (delta.refused or delta.rate_limited or delta.stale_wait)
            ):
                snap = self._job.guard.snapshot()
                wait = max(
                    TAIL_RETRY_AFTER.total_seconds(),
                    float(snap["retryAfterS"]),
                    float(snap["rateLimitedForS"]),
                )
            if wait is not None:
                refusals += 1
                if wait > MAX_WAIT_S or refusals > MAX_REFUSALS:
                    raise RunStopped(f"upstream budget unavailable (retry in {wait:.0f}s)")
                await self.sleep(max(1.0, wait))
                continue
            await self.pace(delta.requests, rate)
            if error is not None:
                raise error
            return result  # type: ignore[return-value]

    async def pace(self, requests: int, rate: float) -> None:
        if requests <= 0:
            return
        if rate <= 0:
            raise RunStopped("no upstream credits left for today")
        await self.sleep(requests * 60 / rate)

    async def write(self, fn: Callable[[Session], object]) -> None:
        """Run `fn` in a session on a worker thread and commit it through the cache gate."""
        try:
            await asyncio.to_thread(self._job.write, fn)
        except CacheRetired as exc:
            raise RunAborted("the provider was switched") from exc

    def advance(self, *, done: int = 0, failed: int = 0) -> None:
        self.state.done += done
        self.state.failed += failed
        self.state.dirty = True

    async def flush(self, *, force: bool) -> None:
        state = self.state
        now = self.now()
        due = state.flushed_at is None or (now - state.flushed_at).total_seconds() >= (
            PROGRESS_EVERY_S
        )
        if state.dirty and (force or due):
            await asyncio.to_thread(self._job.save_progress, state)
            state.flushed_at = now
            state.dirty = False


class ScreenerJob:
    """See the module docstring. `clock` / `sleep` are injectable for tests."""

    def __init__(
        self,
        engine: Engine,
        bars: BarService,
        provider: GuardedProvider,
        guard: UpstreamGuard,
        stats: CacheStats,
        settings: Settings,
        *,
        provider_id: str,
        capabilities: Capabilities | None = None,
        costs: CostModel | None = None,
        gate: CacheGate | None = None,
        generation: int = 0,
        session_lookup: Callable[[str], dict[str, Any] | None] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        first_delay_s: float = FIRST_RUN_DELAY_S,
        lease: Lease | None = None,
    ) -> None:
        self._engine = engine
        self._bars = bars
        self.provider = provider
        self.guard = guard
        self.stats = stats
        self._settings = settings
        self.provider_id = provider_id[:16]
        self._caps = capabilities if capabilities is not None else Capabilities.full()
        self._costs = costs if costs is not None else CostModel()
        self._gate = gate
        self._generation = generation
        self._session_lookup = session_lookup
        self._clock = clock
        self._sleep = sleep
        self._first_delay_s = first_delay_s
        self.lease = lease or Lease(engine, LEASE_NAME)
        self._hub: Callable[[], Any] | None = None
        self._dispatcher: Callable[[], Any] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._schedule_task: asyncio.Task[None] | None = None
        self._run_task: asyncio.Task[None] | None = None
        self._active: RunState | None = None
        self._lock = threading.Lock()
        self.stopping = False
        self._had_done_run = False
        #: Upstream requests of this job per UTC day (for `CREDIT_SHARE`).
        self._day_tokens: tuple[date, int] = (date.min, 0)

    # -- configuration ------------------------------------------------------

    @property
    def enabled(self) -> bool:
        """`screener_enabled`, or by default on for the yahoo and demo providers only."""
        setting = self._settings.screener_enabled
        if setting is not None:
            return setting
        return self.provider_id in ("yahoo", "demo")

    @property
    def supported(self) -> bool:
        """The provider serves daily bars (every built-in one does)."""
        return "1d" in self._caps.intervals

    @property
    def fundamentals_supported(self) -> bool:
        return self.provider.screen_info

    def now(self) -> datetime:
        return self._clock().astimezone(UTC)

    def rate_per_min(self, *, info: bool = False) -> float:
        """Requests per minute a run may use now."""
        setting = (
            self._settings.screener_info_rate_per_min
            if info
            else self._settings.screener_rate_per_min
        )
        return max(0.0, min(setting, self.guard.sustainable_rate_per_min() / 3))

    def _zone(self) -> ZoneInfo:
        try:
            return ZoneInfo(self._settings.screener_tz)
        except (ZoneInfoNotFoundError, ValueError):
            log.warning("unknown SCREENER_TZ %r; using UTC", self._settings.screener_tz)
            return ZoneInfo("UTC")

    def _run_time(self) -> time:
        text = self._settings.screener_run_at
        try:
            hh, mm = text.split(":")
            return time(int(hh), int(mm))
        except ValueError:
            log.warning("bad SCREENER_RUN_AT %r; using 17:15", text)
            return time(17, 15)

    def target_date(self, now: datetime | None = None) -> date:
        """The latest completed US trading session (see the module docstring)."""
        return latest_completed_session(
            now or self.now(),
            self._zone().key,
            settle=timedelta(seconds=self._settings.bars_settle_after_close_s),
            extra=self._settings.market_extra_holidays,
        )

    def _target_cutoff(self, target: date) -> datetime:
        """When the target session's bars are final (close + settle), UTC."""
        settle = timedelta(seconds=self._settings.bars_settle_after_close_s)
        return session_final_at(
            target, self._zone().key, settle, extra=self._settings.market_extra_holidays
        )

    def next_run_at(self, now: datetime | None = None) -> datetime:
        """The next scheduled run after `now` (NYSE trading days at `screener_run_at`), UTC."""
        now = now or self.now()
        zone = self._zone()
        at = self._run_time()
        today = now.astimezone(zone).date()
        for ahead in range(15):
            day = today + timedelta(days=ahead)
            if is_trading_day(day, extra=self._settings.market_extra_holidays):
                when = datetime.combine(day, at, zone)
                if when > now:
                    return when.astimezone(UTC)
        raise AssertionError("no trading day within two weeks")  # pragma: no cover

    def bind(
        self, *, hub: Callable[[], Any] | None = None, dispatcher: Callable[[], Any] | None = None
    ) -> None:
        """Where `evaluate_screens` gets the live hub and the dispatcher from."""
        self._hub = hub
        self._dispatcher = dispatcher

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        """Start the scheduler (when enabled); manual runs work either way."""
        self._loop = asyncio.get_running_loop()
        if not self.enabled or not self.supported:
            log.info("screener job not scheduled (provider %s)", self.provider_id)
            return
        self._schedule_task = asyncio.create_task(self._schedule_loop(), name="screener")

    async def stop(self) -> None:
        """Cancel the scheduler and a running run (logged `aborted`, lease released)."""
        self.stopping = True
        for task in (self._schedule_task, self._run_task):
            if task is not None:
                task.cancel()
        for task in (self._schedule_task, self._run_task):
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self._schedule_task = self._run_task = None

    async def _schedule_loop(self) -> None:
        await self._sleep(self._first_delay_s)
        while True:
            try:
                await self._cycle()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("screener scheduled cycle failed")
            await self._sleep_until(self.next_run_at())

    async def _sleep_until(self, when: datetime) -> None:
        while (left := (when - self.now()).total_seconds()) > 0:
            await self._sleep(min(left, SCHEDULE_SLICE_S))

    async def _cycle(self) -> None:
        """The scheduled work: each run kind not yet `done` for the target date."""
        await self._wait_for_run()
        target = self.target_date()
        kinds: list[RunKind] = ["snapshot"]
        if self.fundamentals_supported:
            kinds.append("fundamentals")
        for kind in kinds:
            if not await asyncio.to_thread(self._needs_run, kind, target):
                continue
            try:
                await self.trigger_async(kind, trigger="schedule")
            except RunInProgress as exc:
                log.info("screener %s run skipped: %s", kind, exc)
                return
            await self._wait_for_run()

    async def wait(self) -> None:
        """Wait until the running run (if any) has ended."""
        await self._wait_for_run()

    async def _wait_for_run(self) -> None:
        task = self._run_task
        if task is not None:
            with contextlib.suppress(Exception):
                await asyncio.shield(task)

    # -- runs ---------------------------------------------------------------

    def trigger(self, kind: RunKind, *, trigger: str = "manual") -> int:
        """Start a `kind` run now; returns its `screener_runs` id. Raises `RunInProgress`
        when one is running (here or in another worker holding the lease), or for a manual
        run still in its cooldown. Blocks on the database: on the event loop use
        `trigger_async`."""
        state = self._claim(kind, trigger)
        try:
            asyncio.get_running_loop()
            self._run_task = asyncio.create_task(self._execute(state), name=f"screener-{kind}")
        except RuntimeError:
            loop = self._loop
            if loop is None:
                with self._lock:
                    self._active = None
                self.lease.release()
                raise
            future = asyncio.run_coroutine_threadsafe(self._spawn(state), loop)
            future.result(timeout=5)
        return state.id

    async def trigger_async(self, kind: RunKind, *, trigger: str = "manual") -> int:
        """`trigger` with its database work on a worker thread."""
        state = await asyncio.to_thread(self._claim, kind, trigger)
        self._run_task = asyncio.create_task(self._execute(state), name=f"screener-{kind}")
        return state.id

    def _claim(self, kind: RunKind, trigger: str) -> RunState:
        """Take the lease and log a `running` row (blocking); the caller starts the task."""
        if kind not in ("snapshot", "fundamentals"):
            raise ValueError(f"unknown run kind {kind!r}")
        with self._lock:
            if self.stopping:
                raise RunInProgress("the screener job is stopping")
            if self._active is not None:
                raise RunInProgress(f"a {self._active.kind} run is in progress")
            now = self.now()
            target = self.target_date(now)
            if trigger == "manual":
                self._check_cooldown(kind, target, now)
            if not self.lease.acquire(now):
                raise RunInProgress("another worker is running the screener")
            state = RunState(id=0, kind=kind, trigger=trigger, target=target, started_at=now)
            try:
                self._abort_stale_runs(now)
                state.id = self._insert_run(state)
            except Exception:
                self.lease.release()
                raise
            self._active = state
        return state

    def _check_cooldown(self, kind: RunKind, target: date, now: datetime) -> None:
        """Refuse a manual run that would redo a `done` one just finished."""
        cooldown = FUNDAMENTALS_COOLDOWN if kind == "fundamentals" else SNAPSHOT_COOLDOWN
        finished = self._last_done_at(kind, target)
        if finished is None or now - finished >= cooldown:
            return
        if kind == "fundamentals":
            raise RunInProgress(f"fundamentals already done for {target}; retry after 1h")
        if not self._snapshot_queue(target):
            raise RunInProgress(f"snapshots already done for {target}; retry after 10 min")

    async def _spawn(self, state: RunState) -> None:
        self._run_task = asyncio.create_task(self._execute(state), name=f"screener-{state.kind}")

    async def _execute(self, state: RunState) -> None:
        ctl = RunControl(self, state)
        try:
            try:
                if state.kind == "snapshot":
                    await self._snapshot_run(ctl)
                else:
                    await self._fundamentals_run(ctl)
                state.status = "partial" if state.failed else "done"
            except RunEnded as exc:
                state.status, state.error = exc.status, str(exc)
                log.warning("screener %s run %d %s: %s", state.kind, state.id, exc.status, exc)
            except asyncio.CancelledError:
                state.status, state.error = "aborted", "stopped"
                self._finish(state)  # blocking, but short: the task is being torn down
                raise
            except Exception as exc:
                log.exception("screener %s run %d failed", state.kind, state.id)
                state.status, state.error = "failed", f"{type(exc).__name__}: {exc}"
            await asyncio.to_thread(self._finish, state)
            if state.kind == "snapshot" and state.status in ("done", "partial"):
                await self._evaluate_alerts(state.target, complete=state.status == "done")
        finally:
            with self._lock:
                if self._active is state:
                    self._active = None

    def _finish(self, state: RunState) -> None:
        finished = self.now()
        try:
            self.save_progress(state, finished_at=finished)
            self._prune_runs()
        except Exception:
            log.exception("could not log the end of screener run %d", state.id)
        try:
            self.lease.release()
        except Exception:
            log.exception("could not release the screener lease")
        if state.kind == "snapshot" and state.status == "done":
            self._had_done_run = True
        log.info(
            "screener %s run %d %s: %d/%d done, %d failed, %d requests",
            state.kind,
            state.id,
            state.status,
            state.done,
            state.total,
            state.failed,
            state.tokens,
        )

    async def _snapshot_run(self, ctl: RunControl) -> None:
        state = ctl.state
        queue = await asyncio.to_thread(self._snapshot_queue, state.target)
        state.total, state.dirty = len(queue), True
        await ctl.flush(force=True)
        for symbol, cls in queue:
            await ctl.checkpoint()
            await self._snapshot_one(ctl, symbol, cls)
        await ctl.flush(force=True)

    async def _snapshot_one(self, ctl: RunControl, symbol: str, cls: str) -> None:
        spec = INTERVALS["1d"]

        def fetch() -> pd.DataFrame:
            return self._bars.get_bars(symbol, spec, False, limit=BARS_LIMIT, now=self.now()).bars

        try:
            frame = await ctl.call(fetch, rate=ctl.rate(), retry_stale=True)
        except CacheRetired as exc:
            raise RunAborted("the provider was switched") from exc
        except SymbolNotFound:
            await ctl.write(lambda s: self._mark_failed(s, symbol, "symbol not found", True))
            ctl.advance(failed=1)
            return
        except ProviderUnsupported as exc:
            await self._failed(ctl, symbol, str(exc))
            return
        except ProviderError as exc:
            log.warning("screener: bars of %s not served: %s", symbol, exc)
            await self._failed(ctl, symbol, str(exc))
            return
        if ctl.last_delta.stale_error:
            # The tail refresh failed and the cached bars were served: try next run.
            log.warning("screener: bars of %s are stale (refresh failed)", symbol)
            ctl.advance(failed=1)
            return
        now = self.now()
        try:
            row = await asyncio.to_thread(self._snapshot_row, symbol, cls, frame, now, ctl.state)
        except ValueError as exc:
            await self._failed(ctl, symbol, str(exc))
            return

        def store(s: Session) -> None:
            fundamentals.upsert_rows(s, ScreenerSnapshot, [row], "symbol")
            self._mark_ok(s, symbol)

        await ctl.write(store)
        ctl.advance(done=1)

    async def _failed(self, ctl: RunControl, symbol: str, error: str) -> None:
        await ctl.write(lambda s: self._mark_failed(s, symbol, error, False))
        ctl.advance(failed=1)

    def _symbol_tz(self, symbol: str) -> str:
        info = self._session_lookup(symbol) if self._session_lookup is not None else None
        tz = info.get("timezone") if info else None
        if isinstance(tz, str) and tz:
            try:
                ZoneInfo(tz)
                return tz
            except (ZoneInfoNotFoundError, ValueError):
                pass
        return self._zone().key

    def _snapshot_row(
        self, symbol: str, cls: str, frame: pd.DataFrame, now: datetime, state: RunState
    ) -> dict[str, Any]:
        crypto = cls == "crypto"
        tz = "UTC" if crypto else self._symbol_tz(symbol)
        values = compute_snapshot(frame, tz, now, crypto=crypto, target=state.target)
        bar_ts = int(values["bar_ts"] or 0)
        return {
            "symbol": symbol,
            "provider": self.provider_id,
            "as_of_date": bar_date(bar_ts, tz, crypto=crypto),
            "computed_at": now,
            **values,
        }

    async def _fundamentals_run(self, ctl: RunControl) -> None:
        state = ctl.state
        if not self.fundamentals_supported:
            raise RunFailed(f"screener fundamentals are not supported by {self.provider_id}")
        symbols, info_due = await asyncio.to_thread(self._fundamentals_queue)
        state.total, state.dirty = len(symbols) + len(info_due), True
        await ctl.flush(force=True)
        await fundamentals.quote_pass(
            ctl, self.provider, self.provider_id, symbols, self._costs.quote_batch
        )
        await fundamentals.info_pass(ctl, self.provider, self.provider_id, info_due)
        await ctl.flush(force=True)

    async def _evaluate_alerts(self, as_of: date, *, complete: bool) -> None:
        try:
            module = importlib.import_module(f"{__package__}.alerts")
        except ImportError:
            return
        evaluate = getattr(module, "evaluate_screens", None)
        hub = self._hub() if self._hub is not None else None
        dispatcher = self._dispatcher() if self._dispatcher is not None else None
        if evaluate is None or hub is None or dispatcher is None:
            log.info("screen alerts not evaluated: no evaluator, live hub or dispatcher")
            return

        def work() -> int:
            with Session(self._engine) as s:
                fired = int(
                    evaluate(
                        s,
                        self._settings,
                        as_of=as_of,
                        hub=hub,
                        dispatcher=dispatcher,
                        now=self.now(),
                        complete=complete,
                    )
                )
                s.commit()
                return fired

        try:
            fired = await asyncio.to_thread(work)
        except Exception:
            log.exception("screen alert evaluation failed")
            return
        if fired:
            log.info("screen alerts: %d fired for %s", fired, as_of)

    # -- blocking helpers (worker threads) ------------------------------------

    def in_background(self, fn: Callable[[], T]) -> T:
        with self.guard.priority("background"):
            return fn()

    def write(self, fn: Callable[[Session], object]) -> None:
        with Session(self._engine) as s:
            fn(s)
            if self._gate is None:
                s.commit()
                return
            with self._gate.writing(self._generation) as current:
                if current:
                    s.commit()
                    return
                s.rollback()
        raise CacheRetired("screener")

    def count_tokens(self, now: datetime, requests: int) -> None:
        day, used = self._day_tokens
        today = now.astimezone(UTC).date()
        self._day_tokens = (today, (used if day == today else 0) + requests)

    def tokens_today(self, now: datetime) -> int:
        day, used = self._day_tokens
        return used if day == now.astimezone(UTC).date() else 0

    def _snapshot_queue(self, target: date) -> list[tuple[str, str]]:
        with Session(self._engine) as s:
            tracked = tracked_symbols(s, self._settings)
            s.commit()
            classes: dict[str, str] = {
                sym: cls
                for sym, cls in s.execute(select(ScreenerSymbol.symbol, ScreenerSymbol.cls))
            }
            snaps = {
                sym: (as_of, computed)
                for sym, as_of, computed in s.execute(
                    select(
                        ScreenerSnapshot.symbol,
                        ScreenerSnapshot.as_of_date,
                        ScreenerSnapshot.computed_at,
                    )
                )
            }
        cutoff = self._target_cutoff(target)
        queue: list[tuple[date, int, str]] = []
        for i, sym in enumerate(tracked):
            snap = snaps.get(sym)
            if snap is None:
                queue.append((date.min, i, sym))
            elif snap[0] < target and _aware(snap[1]) < cutoff:
                queue.append((snap[0], i, sym))
        queue.sort()
        return [(sym, classes.get(sym, "stocks")) for _, _, sym in queue]

    def _fundamentals_queue(self) -> tuple[list[str], list[str]]:
        with Session(self._engine) as s:
            tracked = tracked_symbols(s, self._settings)
            s.commit()
            return tracked, fundamentals.info_queue(s, tracked, self.now())

    def _mark_failed(self, s: Session, symbol: str, error: str, not_found: bool) -> None:
        row = s.get(ScreenerSymbol, symbol)
        if row is None:
            return
        row.last_error = error[:_LAST_ERROR_MAX]
        if not_found:
            row.fail_count = (row.fail_count or 0) + 1
            if row.fail_count >= TOMBSTONE_AFTER and row.tombstoned_at is None:
                row.tombstoned_at = self.now()
                log.warning("screener: %s tombstoned after %d not-found", symbol, row.fail_count)

    @staticmethod
    def _mark_ok(s: Session, symbol: str) -> None:
        row = s.get(ScreenerSymbol, symbol)
        if row is not None and (row.fail_count or row.last_error):
            row.fail_count, row.last_error = 0, None

    def _insert_run(self, state: RunState) -> int:
        with Session(self._engine) as s:
            row = ScreenerRun(
                kind=state.kind,
                trigger=state.trigger,
                provider=self.provider_id,
                target_date=state.target,
                status="running",
                total=0,
                done=0,
                failed=0,
                tokens=0,
                started_at=state.started_at,
            )
            s.add(row)
            s.commit()
            return int(row.id)

    def _abort_stale_runs(self, now: datetime) -> None:
        """With the lease held no other run is going: `running` rows are left-overs of a
        process that exited mid-run."""
        with Session(self._engine) as s:
            result = s.execute(
                update(ScreenerRun)
                .where(ScreenerRun.status == "running")
                .values(status="aborted", error=STALE_RUN_ERROR, finished_at=now)
            )
            s.commit()
        stale = int(getattr(result, "rowcount", 0) or 0)
        if stale:
            log.warning("screener: %d stale running run(s) marked aborted", stale)

    def _last_done_at(self, kind: RunKind, target: date) -> datetime | None:
        """When the newest `done` `kind` run of `target` (this provider) finished."""
        with Session(self._engine) as s:
            found = s.scalar(
                select(ScreenerRun.finished_at)
                .where(
                    ScreenerRun.kind == kind,
                    ScreenerRun.provider == self.provider_id,
                    ScreenerRun.target_date == target,
                    ScreenerRun.status == "done",
                    ScreenerRun.finished_at.is_not(None),
                )
                .order_by(ScreenerRun.finished_at.desc())
                .limit(1)
            )
        return _aware(found) if found is not None else None

    def save_progress(self, state: RunState, *, finished_at: datetime | None = None) -> None:
        values: dict[str, Any] = {
            "total": state.total,
            "done": state.done,
            "failed": state.failed,
            "tokens": state.tokens,
            "status": state.status,
            "error": state.error[:_ERROR_MAX] if state.error else None,
        }
        if finished_at is not None:
            values["finished_at"] = finished_at
        with Session(self._engine) as s:
            s.execute(update(ScreenerRun).where(ScreenerRun.id == state.id).values(**values))
            s.commit()

    def _prune_runs(self) -> None:
        with Session(self._engine) as s:
            keep = select(ScreenerRun.id).order_by(ScreenerRun.id.desc()).limit(KEEP_RUNS)
            s.execute(delete(ScreenerRun).where(ScreenerRun.id.not_in(keep.scalar_subquery())))
            s.commit()

    def _needs_run(self, kind: RunKind, target: date) -> bool:
        with Session(self._engine) as s:
            done = s.scalar(
                select(ScreenerRun.id)
                .where(
                    ScreenerRun.kind == kind,
                    ScreenerRun.provider == self.provider_id,
                    ScreenerRun.target_date == target,
                    ScreenerRun.status == "done",
                )
                .limit(1)
            )
        return done is None

    def _first_run_pending(self) -> bool:
        if self._had_done_run:
            return False
        with Session(self._engine) as s:
            done = s.scalar(
                select(ScreenerRun.id)
                .where(
                    ScreenerRun.kind == "snapshot",
                    ScreenerRun.provider == self.provider_id,
                    ScreenerRun.status == "done",
                )
                .limit(1)
            )
        self._had_done_run = done is not None
        return not self._had_done_run

    # -- status -------------------------------------------------------------

    def runtime(self) -> dict[str, Any]:
        """In-process state for `GET /api/screener/status` (§9)."""
        now = self.now()
        enabled, supported = self.enabled, self.supported
        reason: str | None = None
        if not supported:
            reason = "provider_unsupported"
        elif not enabled:
            reason = "disabled"
        elif self._first_run_pending():
            reason = "first_run"
        rate = self.rate_per_min()
        running: dict[str, Any] | None = None
        state = self._active
        if state is not None:
            left = max(0, state.total - state.done - state.failed)
            processed = state.done + state.failed
            elapsed = (now - state.started_at).total_seconds()
            eta: float | None
            if processed:
                eta = elapsed / processed * left
            else:
                eta = left * 60 / rate if rate > 0 else None
            running = {
                "runId": state.id,
                "kind": state.kind,
                "done": state.done,
                "total": state.total,
                "startedAt": iso(state.started_at),
                "etaS": round(eta) if eta is not None else None,
            }
        return {
            "enabled": enabled,
            "supported": supported,
            "reason": reason,
            "running": running,
            "nextRunAt": iso(self.next_run_at(now)) if enabled and supported else None,
            "ratePerMin": rate,
        }
