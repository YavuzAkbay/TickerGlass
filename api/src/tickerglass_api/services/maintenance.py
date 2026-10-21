"""Periodic upkeep of the market data cache database.

Each run (first one shortly after start, then every `cache_maintenance_interval_s`):

1. `BarService.prune`: bound the bar storage by age and by row budget;
2. delete symbol metadata that has not been refreshed for 30 days and that no cached
   series refers to any more;
3. SQLite only: `PRAGMA optimize`, and `VACUUM` when the file holds mostly free pages
   (deleted bars leave free pages behind but never shrink the file by themselves) and
   no bar request came in for `VACUUM_IDLE`: VACUUM blocks writers while it runs;
4. one INFO summary line, and the `bars.rows` / `db.*` gauges for `GET /api/cache/stats`.

Runs happen in a worker thread, so requests keep being served; a failed run is logged
and the next one is scheduled as usual.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import Engine, delete, select
from sqlalchemy.orm import Session

from ..models import SeriesMeta, SymbolMeta
from ..settings import Settings
from .bars import BarService, PruneReport
from .stats import CacheStats

log = logging.getLogger(__name__)

#: Delay before the first run after start-up, so start-up itself stays quiet.
FIRST_RUN_DELAY_S = 60.0
#: Unreferenced symbol metadata older than this is deleted.
SYMBOL_META_MAX_AGE = timedelta(days=30)
#: VACUUM only when more than this share of the file's pages is free ...
VACUUM_MIN_FREE_RATIO = 0.25
#: ... and those free pages add up to more than this many bytes.
VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024
#: ... and no bar request came in for this long (otherwise it waits for a later run).
VACUUM_IDLE = timedelta(minutes=10)

#: Counter subtrees of `CacheStats.snapshot()` repeated in the summary line.
SUMMARY_COUNTERS = ("upstream", "bars")


def should_vacuum(freelist_pages: int, page_count: int, page_size: int) -> bool:
    """True when the free pages exceed both `VACUUM_MIN_FREE_RATIO` of the file and
    `VACUUM_MIN_FREE_BYTES`."""
    if page_count <= 0:
        return False
    free_bytes = freelist_pages * page_size
    return (
        freelist_pages / page_count > VACUUM_MIN_FREE_RATIO and free_bytes > VACUUM_MIN_FREE_BYTES
    )


@dataclass
class MaintenanceReport:
    prune: PruneReport = field(default_factory=PruneReport)
    symbols_purged: int = 0
    #: SQLite page counts before the VACUUM decision; zero on other databases.
    freelist_pages: int = 0
    page_count: int = 0
    page_size: int = 0
    vacuumed: bool = False
    #: A VACUUM was due but put off because bar requests came in recently.
    vacuum_deferred: bool = False


def _flatten(tree: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in tree.items():
        name = f"{prefix}{key}"
        if isinstance(value, dict):
            out.update(_flatten(value, f"{name}."))
        else:
            out[name] = value
    return out


class CacheMaintenance:
    def __init__(
        self,
        engine: Engine,
        bars: BarService,
        settings: Settings,
        stats: CacheStats,
        *,
        first_delay_s: float = FIRST_RUN_DELAY_S,
        interval_s: float | None = None,
    ) -> None:
        self._engine = engine
        self._bars = bars
        self._settings = settings
        self._stats = stats
        self._first_delay_s = first_delay_s
        self._interval_s = (
            settings.cache_maintenance_interval_s if interval_s is None else interval_s
        )
        self._task: asyncio.Task[None] | None = None
        self._last_summary: str | None = None

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="cache-maintenance")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    async def _run(self) -> None:
        delay = self._first_delay_s
        while True:
            await asyncio.sleep(delay)
            try:
                await asyncio.to_thread(self.run_once)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("cache maintenance run failed")
            delay = self._interval_s

    # -- one run ------------------------------------------------------------

    def run_once(self, now: datetime | None = None) -> MaintenanceReport:
        """One full maintenance pass; blocking, meant for a worker thread."""
        now = (now or datetime.now(UTC)).astimezone(UTC)
        report = MaintenanceReport()
        report.prune = self._bars.prune_with_settings(self._settings, now)
        self._stats.set_gauge("bars.rows", report.prune.rows_remaining)
        report.symbols_purged = self.purge_orphan_symbols(now)
        if self._engine.dialect.name == "sqlite":
            self._sqlite_upkeep(report, now)
        self._stats.incr("maintenance.runs")
        self._log_summary(report)
        return report

    def purge_orphan_symbols(self, now: datetime) -> int:
        """Delete `symbol_meta` rows older than `SYMBOL_META_MAX_AGE` that no `series_meta`
        row refers to; returns how many."""
        cutoff = now - SYMBOL_META_MAX_AGE
        with Session(self._engine) as s:
            result = s.execute(
                delete(SymbolMeta).where(
                    SymbolMeta.fetched_at < cutoff,
                    SymbolMeta.symbol.not_in(select(SeriesMeta.symbol).distinct()),
                )
            )
            s.commit()
            return result.rowcount  # type: ignore[attr-defined, no-any-return]

    def _sqlite_upkeep(self, report: MaintenanceReport, now: datetime) -> None:
        with self._engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA optimize")
            report.freelist_pages = int(conn.exec_driver_sql("PRAGMA freelist_count").scalar() or 0)
            report.page_count = int(conn.exec_driver_sql("PRAGMA page_count").scalar() or 0)
            report.page_size = int(conn.exec_driver_sql("PRAGMA page_size").scalar() or 0)
        self._stats.set_gauge("db.free_bytes", report.freelist_pages * report.page_size)
        self._stats.set_gauge("db.file_bytes", report.page_count * report.page_size)
        if not should_vacuum(report.freelist_pages, report.page_count, report.page_size):
            return
        last = self._bars.last_request_at
        if last is not None and now - last < VACUUM_IDLE:
            report.vacuum_deferred = True
            self._stats.incr("maintenance.vacuum_deferred")
            return
        # VACUUM cannot run inside a transaction.
        with self._engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            conn.exec_driver_sql("VACUUM")
        report.vacuumed = True
        self._stats.incr("maintenance.vacuums")

    def _log_summary(self, report: MaintenanceReport) -> None:
        """One INFO line, unless it would repeat the previous run's."""
        snapshot = self._stats.snapshot()
        counters = _flatten({k: snapshot[k] for k in SUMMARY_COUNTERS if k in snapshot})
        if self._engine.dialect.name != "sqlite":
            vacuum = "vacuum n/a"
        elif report.vacuumed:
            vacuum = f"vacuumed {report.freelist_pages}/{report.page_count} free pages"
        elif report.vacuum_deferred:
            vacuum = f"vacuum deferred, busy ({report.freelist_pages}/{report.page_count} free)"
        else:
            vacuum = f"no vacuum ({report.freelist_pages}/{report.page_count} free pages)"
        p = report.prune
        summary = (
            f"pruned {p.series_deleted} series ({p.rows_deleted} bars, {p.skipped_busy} busy), "
            f"{p.rows_remaining} bars left, {report.symbols_purged} symbols purged, {vacuum}; "
            + " ".join(f"{k}={v}" for k, v in counters.items())
        )
        if summary == self._last_summary:
            return
        self._last_summary = summary
        log.info("cache maintenance: %s", summary)
