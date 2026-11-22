"""The scrape-time collector (docs/design/metrics.md §4-§5).

State that already exists (upstream guard, cache stats, the alerts service's heartbeat, DB
rows) is read when Prometheus scrapes, not hooked into the code that produces it. Every
section is isolated: one failing never fails the scrape, it counts in
`tickerglass_metrics_collect_errors_total{section}`. Labels come from small fixed sets only.
"""

import logging
import math
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from datetime import UTC, datetime
from typing import Any

from prometheus_client.metrics_core import (
    CounterMetricFamily,
    GaugeMetricFamily,
    HistogramMetricFamily,
    Metric,
)
from prometheus_client.registry import Collector
from sqlalchemy import func, select

from .. import models as m
from ..ownership import system_session
from . import upstream

log = logging.getLogger(__name__)

SECTIONS = ("provider", "cache", "alerts", "notifications", "screener", "backups")
#: How long values read from the database are reused.
DB_TTL_S = 15.0
#: Fixed set of `tickerglass_alerts_active{kind}` values.
ALERT_KINDS = ("price", "indicator", "drawing", "other")
OUTBOX_STATUSES = ("pending", "failed")
BACKUP_STATUSES = ("ok", "partial", "failed", "running")
SCREENER_RUN_KINDS = ("snapshot", "fundamentals")
#: Statuses of `ScreenerRun` rows (anything else is left out rather than made a label).
SCREENER_RUN_STATUSES = ("running", "done", "partial", "aborted", "failed")


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _gauge(name: str, doc: str, value: float, labels: dict[str, str] | None = None) -> Metric:
    family = GaugeMetricFamily(name, doc, labels=list(labels or ()))
    family.add_metric(list((labels or {}).values()), value)
    return family


def _counter(name: str, doc: str, value: float) -> Metric:
    return CounterMetricFamily(name, doc, value=value)


class _DbCache:
    """Values read from the database, reused for `ttl_s`. A failed load is not cached."""

    def __init__(self, ttl_s: float, clock: Callable[[], float]) -> None:
        self._ttl_s = ttl_s
        self._clock = clock
        self._lock = threading.Lock()
        self._items: dict[str, tuple[float, Any]] = {}

    def get(self, key: str, load: Callable[[], Any]) -> Any:
        with self._lock:
            hit = self._items.get(key)
            if hit is not None and self._clock() - hit[0] < self._ttl_s:
                return hit[1]
            value = load()
            self._items[key] = (self._clock(), value)
            return value


class TickerGlassCollector(Collector):
    def __init__(
        self,
        app: Any,
        *,
        clock: Callable[[], float] = time.monotonic,
        wall: Callable[[], float] = time.time,
        db_ttl_s: float = DB_TTL_S,
    ) -> None:
        self._app = app
        self._wall = wall
        self._db = _DbCache(db_ttl_s, clock)
        self._lock = threading.Lock()
        self._errors = dict.fromkeys(SECTIONS, 0)
        self._failing: set[str] = set()

    # -- plumbing -----------------------------------------------------------------------

    def collect(self) -> Iterator[Metric]:
        sections: tuple[tuple[str, Callable[[], Iterable[Metric]]], ...] = (
            ("provider", self._provider),
            ("cache", self._cache),
            ("alerts", self._alerts),
            ("notifications", self._notifications),
            ("screener", self._screener),
            ("backups", self._backups),
        )
        for name, produce in sections:
            families: list[Metric] = []  # what a failing section produced before it failed stays
            try:
                families.extend(produce())
            except Exception:
                with self._lock:
                    self._errors[name] += 1
                    first = name not in self._failing
                    self._failing.add(name)
                if first:  # once per outage, not once per scrape
                    log.warning("metrics: section %s failed", name, exc_info=True)
            else:
                with self._lock:
                    self._failing.discard(name)
            yield from families
        errors = CounterMetricFamily(
            "tickerglass_metrics_collect_errors_total",
            "Scrape sections that failed and were skipped.",
            labels=["section"],
        )
        with self._lock:
            for name, count in self._errors.items():
                errors.add_metric([name], count)
        yield errors

    def _state(self, name: str) -> Any:
        return getattr(self._app.state, name, None)

    def _read_db(self, key: str, load: Callable[[Any], Any]) -> Any:
        """`load(session)` on a system session (every owner's rows; only aggregates leave
        this module), cached."""
        maker = self._state("sessionmaker")
        if maker is None:
            raise RuntimeError("the database is not ready")

        def run() -> Any:
            with system_session(maker) as session:
                return load(session)

        return self._db.get(key, run)

    # -- provider -----------------------------------------------------------------------

    def _provider(self) -> Iterator[Metric]:
        requests = CounterMetricFamily(
            "tickerglass_provider_requests_total",
            "Upstream requests by provider and outcome (retries included).",
            labels=["provider", "outcome"],
        )
        for (provider, outcome), count in sorted(upstream.snapshot().items()):
            requests.add_metric([provider, outcome], count)
        yield requests
        guard = self._state("upstream_guard")
        if guard is None:
            return
        spec = self._state("provider_spec")
        provider = spec.id if spec is not None else "custom"
        snap: dict[str, Any] = guard.snapshot()
        refused = CounterMetricFamily(
            "tickerglass_provider_refused_total",
            "Calls the guard refused without contacting the upstream, by reason.",
            labels=["provider", "reason"],
        )
        for reason, count in sorted(snap.get("refused", {}).items()):
            refused.add_metric([provider, str(reason)], count)
        yield refused
        remaining = GaugeMetricFamily(
            "tickerglass_provider_budget_remaining",
            "Upstream budget left: tokens in the burst bucket, credits left today.",
            labels=["provider", "window"],
        )
        limit = GaugeMetricFamily(
            "tickerglass_provider_budget_limit",
            "Upstream budget size: the burst bucket, the daily allowance.",
            labels=["provider", "window"],
        )
        remaining.add_metric([provider, "burst"], float(snap["tokens"]))
        limit.add_metric([provider, "burst"], float(snap["burst"]))
        daily = snap.get("daily")
        if daily is not None:
            remaining.add_metric([provider, "daily"], float(daily["left"]))
            limit.add_metric([provider, "daily"], float(daily["limit"]))
        yield remaining
        yield limit
        yield _gauge(
            "tickerglass_provider_breaker_open",
            "1 while the guard refuses calls after a rate limit or an outage.",
            1.0 if snap.get("rateLimited") or snap.get("unavailable") else 0.0,
            {"provider": provider},
        )

    # -- cache --------------------------------------------------------------------------

    def _cache(self) -> Iterator[Metric]:
        stats = self._state("cache_stats")
        if stats is None:
            return
        tree: dict[str, Any] = stats.snapshot().get("cache", {})
        family = CounterMetricFamily(
            "tickerglass_cache_requests_total",
            "Cache lookups by cache and result.",
            labels=["cache", "result"],
        )
        for name in sorted(tree):
            node = tree[name]
            if not isinstance(node, dict) or not ({"hit", "miss"} & node.keys()):
                continue
            for result in ("hit", "miss"):
                family.add_metric([name, result], float(node.get(result, 0)))
        yield family

    # -- alerts -------------------------------------------------------------------------

    def _alerts(self) -> Iterator[Metric]:
        service_error: Exception | None = None
        try:
            yield from self._alerts_service()
        except Exception as exc:  # reported after the database part, which does not depend on it
            service_error = exc
        # A database failure here keeps the service's metrics above.
        active: dict[str, int] = self._read_db("alerts_active", _load_active_alerts)
        family = GaugeMetricFamily(
            "tickerglass_alerts_active", "Active alerts by kind.", labels=["kind"]
        )
        for kind in ALERT_KINDS:
            family.add_metric([kind], active.get(kind, 0))
        yield family
        if service_error is not None:
            raise service_error

    def _alerts_service(self) -> Iterator[Metric]:
        from ..routes.alerts import ONLINE_WITHIN  # lazy: the routes import this package

        state = self._state("alerts_service")
        heartbeat = getattr(state, "heartbeat", None)
        last_at: datetime | None = getattr(state, "last_at", None)
        up = (
            heartbeat is not None
            and last_at is not None
            and datetime.now(UTC) - last_at < ONLINE_WITHIN
        )
        yield _gauge(
            "tickerglass_alerts_service_up",
            "1 while the alerts service's heartbeat is recent.",
            1.0 if up else 0.0,
        )
        if heartbeat is None or last_at is None:
            return
        yield _gauge(
            "tickerglass_alerts_service_last_heartbeat_timestamp_seconds",
            "When the alerts service last sent a heartbeat (Unix seconds).",
            last_at.timestamp(),
        )
        yield _gauge(
            "tickerglass_alerts_service_start_timestamp_seconds",
            "When the alerts service last started (Unix seconds).",
            _utc(heartbeat.started_at).timestamp(),
        )
        if not up:
            return  # stale numbers would flatline dashboards
        yield _gauge(
            "tickerglass_alerts_series", "Series the service evaluates.", _number(heartbeat.series)
        )
        yield _gauge(
            "tickerglass_alerts_live_symbols",
            "Symbols with a live feed.",
            _number(heartbeat.live_symbols),
        )
        yield _gauge(
            "tickerglass_alerts_polled_series",
            "Series evaluated by polling.",
            _number(heartbeat.polled_series),
        )
        yield _gauge(
            "tickerglass_alerts_waiting",
            "Alerts held back while their script is out.",
            len(heartbeat.waiting),
        )
        yield from _service_metrics(getattr(state, "metrics", None))

    # -- notifications ------------------------------------------------------------------

    def _notifications(self) -> Iterator[Metric]:
        counts, oldest = self._read_db("outbox", _load_outbox)
        family = GaugeMetricFamily(
            "tickerglass_notifications_outbox", "Outbox rows by status.", labels=["status"]
        )
        for status in OUTBOX_STATUSES:
            family.add_metric([status], counts.get(status, 0))
        yield family
        age = max(0.0, self._wall() - oldest.timestamp()) if oldest is not None else 0.0
        yield _gauge(
            "tickerglass_notifications_oldest_pending_age_seconds",
            "Age of the oldest alert still waiting for delivery; 0 when none.",
            age,
        )

    # -- screener -----------------------------------------------------------------------

    def _screener(self) -> Iterator[Metric]:
        computed, rows, runs = self._read_db("screener", _load_screener)
        stack = self._state("market_stack")
        screener = getattr(stack, "screener", None)
        if screener is not None:
            yield _gauge(
                "tickerglass_screener_enabled",
                "1 when the server-side screener is on.",
                1.0 if screener.enabled else 0.0,
            )
        yield _gauge("tickerglass_screener_snapshot_rows", "Symbols in the snapshot.", rows)
        if computed is not None:
            yield _gauge(
                "tickerglass_screener_snapshot_age_seconds",
                "Seconds since the newest snapshot row was computed.",
                max(0.0, self._wall() - computed.timestamp()),
            )
        family = GaugeMetricFamily(
            "tickerglass_screener_last_run_timestamp_seconds",
            "When the latest run of each kind finished (started, if unfinished).",
            labels=["kind", "status"],
        )
        for kind, status, stamp in runs:
            family.add_metric([kind, status], stamp.timestamp())
        yield family

    # -- backups ------------------------------------------------------------------------

    def _backups(self) -> Iterator[Metric]:
        service = self._state("backups")
        if service is None:
            return
        last_ok, status, size = self._read_db("backups", lambda s: _load_backups(s, service))
        yield _gauge(
            "tickerglass_backup_enabled",
            "1 when scheduled backups are configured.",
            1.0 if service.enabled else 0.0,
        )
        if last_ok is not None:
            yield _gauge(
                "tickerglass_backup_last_success_timestamp_seconds",
                "When the last successful backup finished (Unix seconds).",
                last_ok.timestamp(),
            )
        if status is not None:
            yield _gauge(
                "tickerglass_backup_last_run_status",
                "Status of the latest backup run (1 for the current status).",
                1.0,
                {"status": status},
            )
        if size is not None:
            yield _gauge(
                "tickerglass_backup_last_size_bytes", "Size of the latest successful backup.", size
            )


# -- loaders (blocking DB reads, results are plain aggregates) ------------------------------


def _load_active_alerts(session: Any) -> dict[str, int]:
    kind = m.Alert.spec["left"]["kind"].as_string()
    out = dict.fromkeys(ALERT_KINDS, 0)
    has_drawing = m.Alert.drawing_id.is_not(None)
    rows = session.execute(
        select(has_drawing, kind, func.count())
        .where(m.Alert.status == "active")
        .group_by(has_drawing, kind)
    )
    for drawn, left, n in rows:
        name = "drawing" if drawn else left if left in ("price", "indicator") else "other"
        out[name] += n
    return out


def _load_outbox(session: Any) -> tuple[dict[str, int], datetime | None]:
    counts = {
        status: n
        for status, n in session.execute(
            select(m.AlertDelivery.status, func.count())
            .where(m.AlertDelivery.status.in_(OUTBOX_STATUSES))
            .group_by(m.AlertDelivery.status)
        )
    }
    oldest = session.scalar(
        select(func.min(m.AlertLog.fired_at))
        .join(m.AlertDelivery, m.AlertDelivery.log_id == m.AlertLog.id)
        .where(m.AlertDelivery.status == "pending")
    )
    return counts, _utc(oldest) if oldest is not None else None


def _load_screener(
    session: Any,
) -> tuple[datetime | None, int, list[tuple[str, str, datetime]]]:
    computed = session.scalar(select(func.max(m.ScreenerSnapshot.computed_at)))
    rows = session.scalar(select(func.count()).select_from(m.ScreenerSnapshot)) or 0
    runs: list[tuple[str, str, datetime]] = []
    for kind in SCREENER_RUN_KINDS:
        run = session.scalar(
            select(m.ScreenerRun)
            .where(m.ScreenerRun.kind == kind)
            .order_by(m.ScreenerRun.id.desc())
            .limit(1)
        )
        if run is not None and run.status in SCREENER_RUN_STATUSES:
            runs.append((kind, run.status, _utc(run.finished_at or run.started_at)))
    return (_utc(computed) if computed is not None else None), rows, runs


def _load_backups(session: Any, service: Any) -> tuple[datetime | None, str | None, int | None]:
    last_ok: datetime | None = service.last_ok_at()
    status = session.scalar(select(m.BackupRun.status).order_by(m.BackupRun.id.desc()).limit(1))
    size = session.scalar(
        select(m.BackupRun.size)
        .where(m.BackupRun.status.in_(("ok", "partial")), m.BackupRun.size.is_not(None))
        .order_by(m.BackupRun.id.desc())
        .limit(1)
    )
    return last_ok, status if status in BACKUP_STATUSES else None, size


# -- alerts service counters --------------------------------------------------------------


def _number(value: Any) -> float:
    """`value` as a finite float; ValueError, OverflowError or TypeError otherwise. A number the
    text exposition cannot render must fail its section, not the whole scrape."""
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("not a finite number")
    return number


def _service_metrics(metrics: Any) -> Iterator[Metric]:
    """The heartbeat's counters (`HeartbeatMetrics`), only for a service that is up. Every
    value is converted before the first family is yielded: a bad one drops all of them."""
    if metrics is None:
        return
    counters = (
        ("evaluations", "evaluations", "Evaluation passes since the service started."),
        ("evaluation_failures", "evaluation_failures", "Evaluation passes that failed."),
        ("fires_queued", "fires_queued", "Fires handed to the fire queue."),
        ("fire_retries", "fire_retries", "Fire sends that failed and will be retried."),
        ("fires_dropped", "fires_dropped", "Fires the API refused for good (404/422)."),
        ("status_post_failures", "status_post_failures", "Alert status updates that failed."),
        ("script_faults", "script_faults", "User script faults reported."),
    )
    values = [(name, doc, _number(getattr(metrics, field))) for field, name, doc in counters]
    depth = _number(metrics.fire_queue_depth)
    lag = metrics.lag
    buckets = [(str(_number(b)), _number(c)) for b, c in zip(lag.buckets, lag.counts, strict=True)]
    buckets.append(("+Inf", _number(lag.count)))
    lag_sum = _number(lag.sum)
    for name, doc, number in values:
        yield _counter(f"tickerglass_alerts_{name}_total", doc, number)
    yield _gauge("tickerglass_alerts_fire_queue_depth", "Fires waiting to be sent.", depth)
    yield HistogramMetricFamily(
        "tickerglass_alerts_evaluation_lag_seconds",
        "How late evaluations ran after they were due.",
        buckets=buckets,
        sum_value=lag_sum,
    )
