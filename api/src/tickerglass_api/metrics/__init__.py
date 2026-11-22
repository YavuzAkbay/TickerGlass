"""Prometheus metrics (docs/design/metrics.md). One scrape target, `GET /metrics`.

`Metrics` owns a private registry (not the global default, so apps in tests stay isolated),
the counters nothing else keeps (HTTP requests, notification deliveries, fires), and the
collector that reads everything else when scraped. Single process: with several uvicorn
workers each would report its own numbers, which is unsupported.
"""

from typing import Any

from prometheus_client import (
    CollectorRegistry,
    Counter,
    Histogram,
    disable_created_metrics,
    generate_latest,
)
from prometheus_client.gc_collector import GCCollector
from prometheus_client.metrics_core import GaugeMetricFamily
from prometheus_client.platform_collector import PlatformCollector
from prometheus_client.process_collector import ProcessCollector
from prometheus_client.registry import Collector

from .. import __version__
from .collector import DB_TTL_S, TickerGlassCollector
from .middleware import MetricsMiddleware

# No `<name>_created` series next to every counter and histogram: they double the series
# count and nothing here reads them (the library applies this process-wide).
disable_created_metrics()  # type: ignore[no-untyped-call]

#: Channels a delivery is counted under (others: `other`), and the delivery outcomes.
CHANNELS = ("webhook", "telegram", "email", "ntfy", "gotify", "apprise")
DELIVERY_OUTCOMES = ("sent", "retry", "failed")
FIRE_SOURCES = ("chart", "screener")
HTTP_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)

#: Every metric family the API can emit (exposition names), for the dashboard/rules check.
CATALOGUE: tuple[str, ...] = (
    "tickerglass_build_info",
    "tickerglass_http_requests_total",
    "tickerglass_http_request_duration_seconds",
    "tickerglass_provider_requests_total",
    "tickerglass_provider_refused_total",
    "tickerglass_provider_budget_remaining",
    "tickerglass_provider_budget_limit",
    "tickerglass_provider_breaker_open",
    "tickerglass_cache_requests_total",
    "tickerglass_alerts_fired_total",
    "tickerglass_alerts_active",
    "tickerglass_alerts_service_up",
    "tickerglass_alerts_service_last_heartbeat_timestamp_seconds",
    "tickerglass_alerts_service_start_timestamp_seconds",
    "tickerglass_alerts_series",
    "tickerglass_alerts_live_symbols",
    "tickerglass_alerts_polled_series",
    "tickerglass_alerts_waiting",
    "tickerglass_alerts_evaluations_total",
    "tickerglass_alerts_evaluation_failures_total",
    "tickerglass_alerts_fires_queued_total",
    "tickerglass_alerts_fire_retries_total",
    "tickerglass_alerts_fires_dropped_total",
    "tickerglass_alerts_fire_queue_depth",
    "tickerglass_alerts_status_post_failures_total",
    "tickerglass_alerts_script_faults_total",
    "tickerglass_alerts_evaluation_lag_seconds",
    "tickerglass_notifications_deliveries_total",
    "tickerglass_notifications_outbox",
    "tickerglass_notifications_oldest_pending_age_seconds",
    "tickerglass_screener_snapshot_age_seconds",
    "tickerglass_screener_snapshot_rows",
    "tickerglass_screener_last_run_timestamp_seconds",
    "tickerglass_screener_enabled",
    "tickerglass_backup_last_success_timestamp_seconds",
    "tickerglass_backup_last_run_status",
    "tickerglass_backup_last_size_bytes",
    "tickerglass_backup_enabled",
    "tickerglass_metrics_collect_errors_total",
)


class _BuildInfo(Collector):
    def collect(self) -> list[GaugeMetricFamily]:
        family = GaugeMetricFamily(
            "tickerglass_build_info", "Always 1; the version is the label.", labels=["version"]
        )
        family.add_metric([__version__], 1.0)
        return [family]


class Metrics:
    """`app.state.metrics` (None when `METRICS_ENABLED` is off)."""

    def __init__(self, app: Any, *, db_ttl_s: float = DB_TTL_S) -> None:
        self.registry = CollectorRegistry()
        ProcessCollector(registry=self.registry)
        PlatformCollector(registry=self.registry)
        GCCollector(registry=self.registry)
        self.registry.register(_BuildInfo())
        self.http_requests = Counter(
            "tickerglass_http_requests",
            "HTTP requests by method, route template and status class.",
            ["method", "route", "status"],
            registry=self.registry,
        )
        self.http_duration = Histogram(
            "tickerglass_http_request_duration_seconds",
            "HTTP request duration by method and route template.",
            ["method", "route"],
            buckets=HTTP_BUCKETS,
            registry=self.registry,
        )
        self._deliveries = Counter(
            "tickerglass_notifications_deliveries",
            "Notification delivery attempts by channel and outcome.",
            ["channel", "outcome"],
            registry=self.registry,
        )
        self._fired = Counter(
            "tickerglass_alerts_fired",
            "Alerts fired, by source.",
            ["source"],
            registry=self.registry,
        )
        # Zero from the start, so `rate()` and `increase()` see the first event.
        for channel in (*CHANNELS, "other"):
            for outcome in DELIVERY_OUTCOMES:
                self._deliveries.labels(channel, outcome)
        for source in FIRE_SOURCES:
            self._fired.labels(source)
        self.registry.register(TickerGlassCollector(app, db_ttl_s=db_ttl_s))

    def delivery(self, channel: str, outcome: str) -> None:
        """Count a notification attempt; an unknown channel is `other`."""
        self._deliveries.labels(channel if channel in CHANNELS else "other", outcome).inc()

    def fired(self, source: str, n: int = 1) -> None:
        if n > 0:
            self._fired.labels(source).inc(n)

    def render(self) -> bytes:
        """Text exposition of everything (blocking: call from a worker thread)."""
        return generate_latest(self.registry)


__all__ = ["CATALOGUE", "Metrics", "MetricsMiddleware"]
