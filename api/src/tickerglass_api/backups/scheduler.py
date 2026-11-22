"""The daily backup schedule (pattern of the screener job's scheduler).

`BACKUP_AT` in `BACKUP_TZ`, daily. After a start with no successful run in the last 26 hours
(a missed night, or a new install) one run follows `CATCH_UP_DELAY_S` later. Sleeps go in
slices so a changed clock or a long sleep never overshoots by much; the clock and the sleep are
injectable. Only one process runs a backup (the `backup` lease inside `BackupService.claim`)."""

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from ..settings import Settings
from .runner import BackupService, NoTargets, NotSupported, RunInProgress

log = logging.getLogger(__name__)

CATCH_UP_DELAY_S = 300.0
SCHEDULE_SLICE_S = 900.0


def run_time(settings: Settings) -> time:
    hh, mm = settings.backup_at.split(":")  # validated by `Settings`
    return time(int(hh), int(mm))


def zone(settings: Settings) -> ZoneInfo:
    try:
        return ZoneInfo(settings.backup_zone)
    except Exception:
        log.warning("unknown backup time zone %r; using UTC", settings.backup_zone)
        return ZoneInfo("UTC")


def next_run_at(settings: Settings, now: datetime) -> datetime:
    """The next daily run strictly after `now`, UTC."""
    tz = zone(settings)
    at = run_time(settings)
    today = now.astimezone(tz).date()
    for ahead in range(3):
        when = datetime.combine(today + timedelta(days=ahead), at, tz)
        if when > now:
            return when.astimezone(UTC)
    raise AssertionError("no run time within three days")  # pragma: no cover


class BackupScheduler:
    def __init__(
        self,
        service: BackupService,
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        catch_up_delay_s: float = CATCH_UP_DELAY_S,
    ) -> None:
        self._service = service
        self._sleep = sleep
        self._catch_up_delay_s = catch_up_delay_s
        self._task: asyncio.Task[None] | None = None

    @property
    def scheduled(self) -> bool:
        return self._task is not None

    def next_run(self) -> datetime | None:
        if not self._service.enabled:
            return None
        return next_run_at(self._service.settings, self._service.now())

    def needs_catch_up(self) -> bool:
        last = self._service.last_ok_at()
        return last is None or self._service.now() - last > self._service.stale_after()

    def start(self) -> None:
        if not self._service.enabled:
            log.info("scheduled backups are off (no target configured, or disabled)")
            return
        self._task = asyncio.create_task(self._loop(), name="backup-scheduler")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task

    async def _loop(self) -> None:
        try:
            if await asyncio.to_thread(self.needs_catch_up):
                log.info("no recent backup: running one in %d s", int(self._catch_up_delay_s))
                await self._sleep(self._catch_up_delay_s)
                await self._cycle("schedule")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("backup catch-up failed")
        while True:
            await self._sleep_until(next_run_at(self._service.settings, self._service.now()))
            await self._cycle("schedule")

    async def _sleep_until(self, when: datetime) -> None:
        while (left := (when - self._service.now()).total_seconds()) > 0:
            await self._sleep(min(left, SCHEDULE_SLICE_S))

    async def _cycle(self, trigger: str) -> None:
        """One scheduled run; never raises (except cancellation)."""
        try:
            run_id = await asyncio.to_thread(self._service.claim, trigger)
        except RunInProgress as exc:
            log.info("scheduled backup skipped: %s", exc)
            return
        except (NoTargets, NotSupported) as exc:
            log.warning("scheduled backup skipped: %s", exc)
            return
        except Exception:
            log.exception("scheduled backup could not start")
            return
        try:
            await asyncio.to_thread(self._service.execute, run_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("scheduled backup failed")
