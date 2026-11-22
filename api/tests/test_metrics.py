"""Prometheus metrics and health probes (docs/design/metrics.md): `/metrics` access rules,
the catalogue, privacy of labels, the alerts service heartbeat's `metrics`, collector
isolation, and the in-process counters (HTTP, deliveries, upstream requests, fires)."""

import logging
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from prometheus_client.parser import text_string_to_metric_families
from pydantic import ValidationError
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, sessionmaker
from starlette.websockets import WebSocketDisconnect
from test_alerts import body, create, fire
from test_notifications import (  # noqa: F401 - fixtures
    T0,
    FakeNet,
    deliveries,
    http_error,
    maker,
    net,
    run,
    seed,
    settings,
)
from test_userdata import engine_of, owner_id_of
from yfinance.exceptions import YFRateLimitError

from tickerglass_api import models as m
from tickerglass_api.metrics import CATALOGUE, Metrics, upstream
from tickerglass_api.notifications.dispatcher import Dispatcher
from tickerglass_api.providers.base import ProviderError, RateLimited, UpstreamUnavailable
from tickerglass_api.providers.http import HttpRateLimited, HttpStatusError, JsonHttp
from tickerglass_api.providers.yahoo import YahooProvider
from tickerglass_api.routes import health
from tickerglass_api.settings import Settings
from tickerglass_api.userdata.alerts import HeartbeatMetrics

TOKEN = "scrape-token-0123456789"
SERVICE_TOKEN = "svc-token-0123456789abcdef0123456789abcdef"
Maker = Callable[..., TestClient]


def make_metrics(make_client: Maker, **kw: Any) -> TestClient:
    return make_client(metrics_enabled=True, metrics_token=TOKEN, **kw)


def scrape(client: TestClient, token: str | None = TOKEN) -> str:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    res = client.get("/metrics", headers=headers)
    assert res.status_code == 200, res.text
    return res.text


def samples(text_: str) -> list[Any]:
    return [s for f in text_string_to_metric_families(text_) for s in f.samples]


def value(text_: str, name: str, **labels: str) -> float | None:
    """The sample `name` with exactly these labels, None when absent."""
    for s in samples(text_):
        if s.name == name and s.labels == labels:
            return float(s.value)
    return None


def names(text_: str) -> set[str]:
    return {s.name for s in samples(text_)}


HB = {
    "version": "1.2.3",
    "startedAt": "2026-10-15T00:00:00Z",
    "series": 4,
    "liveSymbols": 3,
    "polledSeries": 1,
    "lastError": None,
}
LAG_BUCKETS = [0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]
SVC_METRICS: dict[str, Any] = {
    "evaluations": 120,
    "evaluationFailures": 2,
    "firesQueued": 7,
    "fireRetries": 3,
    "firesDropped": 1,
    "fireQueueDepth": 2,
    "statusPostFailures": 4,
    "scriptFaults": 5,
    "lag": {
        "buckets": LAG_BUCKETS,
        "counts": [1, 3, 5, 6, 6, 7, 8, 8, 8, 8],
        "count": 9,
        "sum": 41.5,
    },
}


def beat(client: TestClient, **kw: Any) -> None:
    res = client.post("/api/alerts/service/heartbeat", json={**HB, **kw})
    assert res.status_code == 204, res.text


# --------------------------------------------------------------------- access


def test_metrics_is_404_when_disabled(make_client: Maker) -> None:
    client = make_client()
    assert client.get("/metrics").status_code == 404
    assert client.get("/metrics", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 404
    assert client.app.state.metrics is None  # type: ignore[attr-defined]


def test_token_required(make_client: Maker) -> None:
    client = make_metrics(make_client)
    res = client.get("/metrics")
    assert res.status_code == 401 and res.headers["www-authenticate"] == "Bearer"
    for bad in ("Bearer nope", "Bearer ", TOKEN, f"Basic {TOKEN}", f"Bearer {TOKEN}x"):
        res = client.get("/metrics", headers={"Authorization": bad})
        assert res.status_code == 401, bad
    res = client.get("/metrics", headers={"Authorization": f"Bearer {TOKEN}"})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain; version=")


def test_session_and_service_token_do_not_grant_access(make_client: Maker) -> None:
    client = make_metrics(make_client, auth_password="sesame", alerts_internal_token=SERVICE_TOKEN)
    assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    assert client.get("/api/layouts").status_code == 200  # signed in
    assert client.get("/metrics").status_code == 401  # the cookie is not a scrape credential
    res = client.get("/metrics", headers={"X-Alerts-Token": SERVICE_TOKEN})
    assert res.status_code == 401
    assert (
        client.get("/metrics", headers={"Authorization": f"Bearer {SERVICE_TOKEN}"}).status_code
        == 401
    )
    assert client.get("/metrics", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200


def test_open_mode_and_public_need_no_token(make_client: Maker) -> None:
    open_app = make_client(metrics_enabled=True)  # no sign-in configured: the app is open anyway
    assert open_app.get("/metrics").status_code == 200
    public = make_client(metrics_enabled=True, metrics_public=True, auth_password="sesame")
    assert public.get("/metrics").status_code == 200
    assert public.get("/api/layouts").status_code == 401  # only /metrics is open
    # A token, when set, still wins over METRICS_PUBLIC.
    both = make_client(
        metrics_enabled=True, metrics_public=True, metrics_token=TOKEN, auth_password="sesame"
    )
    assert both.get("/metrics").status_code == 401


def test_settings_fail_closed() -> None:
    with pytest.raises(ValidationError, match="METRICS_TOKEN"):
        Settings(_env_file=None, metrics_enabled=True, auth_password="x")  # type: ignore[call-arg]
    with pytest.raises(ValidationError, match="METRICS_TOKEN"):
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            metrics_enabled=True,
            auth_trusted_header="X-User",
            auth_header_proxies=["10.0.0.0/8"],
            auth_allow_any_user=True,
        )
    with pytest.raises(ValidationError, match="at least 16"):
        Settings(_env_file=None, metrics_enabled=True, metrics_token="short")  # type: ignore[call-arg]
    ok = Settings(_env_file=None, metrics_enabled=True, metrics_token=TOKEN, auth_password="x")  # type: ignore[call-arg]
    assert ok.metrics_token_value == TOKEN
    assert TOKEN not in repr(ok) and TOKEN not in str(ok.model_dump())
    Settings(_env_file=None, metrics_enabled=True, metrics_public=True, auth_password="x")  # type: ignore[call-arg]
    Settings(_env_file=None, metrics_enabled=False, auth_password="x")  # type: ignore[call-arg]


def test_settings_blank_environment_values(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("METRICS_ENABLED", "METRICS_TOKEN", "METRICS_PUBLIC"):
        monkeypatch.setenv(name, "")
    cfg = Settings(_env_file=None)  # type: ignore[call-arg]
    assert (cfg.metrics_enabled, cfg.metrics_public, cfg.metrics_token) == (False, False, None)


# ------------------------------------------------------------------- catalogue


def test_exposition_parses_and_stays_in_the_catalogue(make_client: Maker) -> None:
    client = make_metrics(make_client, upstream_daily_limit=1000)
    upstream.record("probe3", "ok")
    client.get("/api/health")
    beat(client, metrics=SVC_METRICS)
    client.app.state.cache_stats.incr("cache.quote.hit", 3)  # type: ignore[attr-defined]
    out = scrape(client)
    got = names(out)
    known = {n for n in got if n.startswith("tickerglass_")}

    # Histogram and counter samples carry suffixes the catalogue names do not.
    def base(n: str) -> str:
        for suffix in ("_bucket", "_count", "_sum", "_created"):
            if n.endswith(suffix) and n[: -len(suffix)] in CATALOGUE:
                return n[: -len(suffix)]
        return n

    assert {base(n) for n in known} <= set(CATALOGUE)
    for expected in (
        "tickerglass_build_info",
        "tickerglass_http_requests_total",
        "tickerglass_http_request_duration_seconds_bucket",
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
        "tickerglass_alerts_fire_queue_depth",
        "tickerglass_alerts_evaluation_lag_seconds_bucket",
        "tickerglass_notifications_deliveries_total",
        "tickerglass_notifications_outbox",
        "tickerglass_notifications_oldest_pending_age_seconds",
        "tickerglass_screener_snapshot_rows",
        "tickerglass_screener_enabled",
        "tickerglass_backup_enabled",
        "tickerglass_metrics_collect_errors_total",
        # The library reads /proc: process_* exist on Linux only.
        *(["process_cpu_seconds_total"] if Path("/proc/self/stat").exists() else []),
        "python_info",
    ):
        assert expected in got, expected
    assert (
        value(out, "tickerglass_provider_budget_limit", provider="custom", window="daily") == 1000
    )
    assert value(out, "tickerglass_cache_requests_total", cache="quote", result="hit") == 3
    assert value(out, "tickerglass_cache_requests_total", cache="quote", result="miss") == 0
    assert all(
        value(out, "tickerglass_metrics_collect_errors_total", section=s) == 0
        for s in ("provider", "cache", "alerts", "notifications", "screener", "backups")
    )


def test_every_catalogue_name_is_documented_once() -> None:
    assert len(set(CATALOGUE)) == len(CATALOGUE)
    assert all(n.startswith("tickerglass_") for n in CATALOGUE)


def test_catalogue_matches_deploy_catalogue_file() -> None:
    path = Path(__file__).resolve().parents[2] / "deploy" / "metrics_catalogue.txt"
    listed = {
        line.split()[0]
        for line in path.read_text().splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    }
    assert listed == set(CATALOGUE)


def test_labels_carry_no_user_symbol_or_alert_data(make_client: Maker) -> None:
    client = make_metrics(make_client)
    alert = create(client, symbol="ZZZSECRET", name="Private ZZZNAME")
    assert fire(client, alert).status_code == 200
    client.get(f"/api/alerts/{alert['id']}")
    client.get("/api/bars?symbol=ZZZSECRET&interval=1d")
    client.get("/api/ZZZSECRET/nothing")
    out = scrape(client)
    owner = owner_id_of(client)
    for secret in ("ZZZSECRET", "ZZZNAME", alert["id"], owner, "Private"):
        assert secret not in out, secret
    routes = {s.labels["route"] for s in samples(out) if "route" in s.labels}
    assert "/api/alerts/{alert_id}" in routes
    assert all(alert["id"] not in r and "ZZZ" not in r for r in routes)


# ----------------------------------------------------------------- HTTP counters


def test_http_labels_use_the_route_template(make_client: Maker) -> None:
    client = make_metrics(make_client)
    client.get("/api/health")
    assert client.get("/api/alerts/does-not-exist").status_code == 404
    assert client.get("/api/alerts/also-missing").status_code == 404
    assert client.get("/nothing/here/at/all").status_code == 404
    client.request("BREW", "/api/health")
    out = scrape(client)
    scrape(client)  # /metrics itself is not counted
    out = scrape(client)
    count = "tickerglass_http_requests_total"
    assert value(out, count, method="GET", route="/api/health", status="2xx") == 1
    assert value(out, count, method="GET", route="/api/alerts/{alert_id}", status="4xx") == 2
    assert value(out, count, method="GET", route="unmatched", status="4xx") == 1
    assert value(out, count, method="other", route="/api/health", status="4xx") == 1
    assert not any(s.labels.get("route") == "/metrics" for s in samples(out))
    duration = value(
        out, "tickerglass_http_request_duration_seconds_count", method="GET", route="/api/health"
    )
    assert duration == 1


def test_http_middleware_counts_auth_refusals_and_websockets(make_client: Maker) -> None:
    client = make_metrics(make_client, auth_password="sesame")
    assert client.get("/api/layouts").status_code == 401
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
        pass  # refused before the accept
    out = scrape(client)
    count = "tickerglass_http_requests_total"
    # Refused before routing: no route to name.
    assert value(out, count, method="GET", route="unmatched", status="4xx") == 1
    assert value(out, count, method="GET", route="websocket", status="4xx") == 1


def test_websocket_connect_is_counted_once(make_client: Maker) -> None:
    client = make_metrics(make_client)
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "subscribe", "symbols": []})
    out = scrape(client)
    assert (
        value(out, "tickerglass_http_requests_total", method="GET", route="websocket", status="1xx")
        == 1
    )
    assert not any(
        s.name.startswith("tickerglass_http_request_duration_seconds")
        and s.labels.get("route") == "websocket"
        for s in samples(out)
    )


# ---------------------------------------------------------------------- health


def test_live_and_ready(make_client: Maker) -> None:
    client = make_client(auth_password="sesame")  # public even with sign-in on
    assert client.get("/api/health/live").json() == {"status": "ok"}
    assert client.get("/api/health/ready").json() == {"status": "ok"}
    assert client.get("/api/health").json()["status"] == "ok"  # unchanged
    assert set(client.get("/api/health").json()) == {"status", "version"}


def test_ready_is_503_when_the_database_is_broken(
    make_client: Maker, tmp_path: Any, caplog: pytest.LogCaptureFixture
) -> None:
    client = make_client()
    state = client.app.state  # type: ignore[attr-defined]
    good = state.engine
    state.engine = create_engine(f"sqlite:///{tmp_path}/missing-dir/x.db")
    try:
        with caplog.at_level(logging.WARNING):
            res = client.get("/api/health/ready")
            client.get("/api/health/ready")
        assert res.status_code == 503
        assert res.json() == {"status": "unavailable", "checks": {"startup": "ok", "db": "fail"}}
        assert "missing-dir" not in res.text and "unable" not in res.text.lower()
        assert len([r for r in caplog.records if "readiness" in r.getMessage()]) == 1
        assert client.get("/api/health/live").status_code == 200  # never touches the database
    finally:
        state.engine = good
    assert client.get("/api/health/ready").status_code == 200


def test_ready_is_503_before_startup_finished(make_client: Maker) -> None:
    client = make_client()
    client.app.state.ready = False  # type: ignore[attr-defined]
    res = client.get("/api/health/ready")
    assert res.status_code == 503 and res.json()["checks"]["startup"] == "fail"


def test_a_hung_database_check_is_not_stacked(
    make_client: Maker, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_client()
    state = client.app.state  # type: ignore[attr-defined]
    good = state.engine
    release = threading.Event()
    calls: list[int] = []

    class HungEngine:
        def connect(self) -> Any:
            calls.append(1)
            release.wait(10)
            raise RuntimeError("released")

    monkeypatch.setattr(health, "DB_BUDGET_S", 0.1)
    state.engine = HungEngine()
    try:
        assert client.get("/api/health/ready").status_code == 503  # timed out, thread still hung
        t0 = time.monotonic()
        res = client.get("/api/health/ready")
        assert res.status_code == 503
        assert res.json()["checks"]["db"] == "fail"
        assert time.monotonic() - t0 < 0.08  # answered without waiting for the budget
        assert len(calls) == 1  # no second thread
    finally:
        release.set()
        deadline = time.monotonic() + 5
        while health._ping_lock.locked() and time.monotonic() < deadline:
            time.sleep(0.01)
        state.engine = good
    assert client.get("/api/health/ready").status_code == 200  # recovers


def test_oversized_heartbeat_counter_is_dropped_and_the_scrape_stays_200(
    make_client: Maker,
) -> None:
    client = make_metrics(make_client)
    huge = {**SVC_METRICS, "evaluations": 10**400}
    beat(client, metrics=huge)  # the heartbeat itself is still accepted
    out = scrape(client)
    assert value(out, "tickerglass_alerts_service_up") == 1
    assert not any(n.startswith("tickerglass_alerts_evaluations") for n in names(out))
    for patch in (
        {"lag": {**SVC_METRICS["lag"], "count": 10**400}},
        {"lag": {**SVC_METRICS["lag"], "sum": 1e300}},
        {"fireQueueDepth": 2**53 + 1},
    ):
        beat(client, metrics={**SVC_METRICS, **patch})
        assert scrape(client)  # 200, metrics part dropped
        assert "tickerglass_alerts_evaluations_total" not in names(scrape(client))
    res = client.post("/api/alerts/service/heartbeat", json={**HB, "series": 10**400})
    assert res.status_code == 422
    beat(client, metrics=SVC_METRICS)
    assert value(scrape(client), "tickerglass_alerts_evaluations_total") == 120


def test_a_value_the_exposition_cannot_render_fails_only_its_section(
    make_client: Maker,
) -> None:
    client = make_metrics(make_client)
    beat(client, metrics=SVC_METRICS)
    state = client.app.state.alerts_service  # type: ignore[attr-defined]
    state.metrics = SimpleNamespace(**{**vars(state.metrics), "evaluations": 10**400})
    out = scrape(client)  # still 200
    assert value(out, "tickerglass_alerts_service_up") == 1
    assert value(out, "tickerglass_alerts_active", kind="price") == 0  # the section's DB part ran
    assert "tickerglass_alerts_evaluations_total" not in names(out)


def test_alerts_service_offline_does_not_fail_readiness(make_client: Maker) -> None:
    client = make_client()
    assert client.get("/api/alerts/service").json() == {"online": False}
    assert client.get("/api/health/ready").status_code == 200


# ------------------------------------------------------------- alerts service


def test_heartbeat_metrics_are_exposed_while_the_service_is_up(make_client: Maker) -> None:
    client = make_metrics(make_client)
    assert value(scrape(client), "tickerglass_alerts_service_up") == 0
    beat(client, metrics=SVC_METRICS)
    out = scrape(client)
    assert value(out, "tickerglass_alerts_service_up") == 1
    assert value(out, "tickerglass_alerts_series") == 4
    assert value(out, "tickerglass_alerts_live_symbols") == 3
    assert value(out, "tickerglass_alerts_polled_series") == 1
    assert value(out, "tickerglass_alerts_waiting") == 0
    started = datetime(2026, 10, 15, tzinfo=UTC).timestamp()
    assert value(out, "tickerglass_alerts_service_start_timestamp_seconds") == started
    assert value(out, "tickerglass_alerts_service_last_heartbeat_timestamp_seconds") is not None
    for name, want in {
        "evaluations": 120,
        "evaluation_failures": 2,
        "fires_queued": 7,
        "fire_retries": 3,
        "fires_dropped": 1,
        "status_post_failures": 4,
        "script_faults": 5,
    }.items():
        assert value(out, f"tickerglass_alerts_{name}_total") == want, name
    assert value(out, "tickerglass_alerts_fire_queue_depth") == 2
    lag = "tickerglass_alerts_evaluation_lag_seconds"
    for le, want in zip(LAG_BUCKETS, SVC_METRICS["lag"]["counts"], strict=True):
        assert value(out, f"{lag}_bucket", le=str(float(le))) == want, le
    assert value(out, f"{lag}_bucket", le="+Inf") == 9
    assert value(out, f"{lag}_count") == 9 and value(out, f"{lag}_sum") == 41.5
    # The metrics never leak into the service status the web app reads.
    assert "metrics" not in client.get("/api/alerts/service").json()


def test_invalid_heartbeat_metrics_are_dropped_with_one_warning(
    make_client: Maker, caplog: pytest.LogCaptureFixture
) -> None:
    client = make_metrics(make_client)
    bad = {**SVC_METRICS, "evaluations": 1.5}
    with caplog.at_level(logging.WARNING):
        beat(client, metrics=bad)
        beat(client, metrics={**SVC_METRICS, "firesQueued": -1})
        beat(client, metrics="nonsense")
    warnings = [r for r in caplog.records if "invalid metrics" in r.getMessage()]
    assert len(warnings) == 1
    assert "1.5" not in warnings[0].getMessage()  # field path and reason, never the input
    out = scrape(client)
    assert value(out, "tickerglass_alerts_service_up") == 1  # the heartbeat itself was kept
    assert value(out, "tickerglass_alerts_series") == 4
    assert not any(n.startswith("tickerglass_alerts_evaluations") for n in names(out))
    assert "tickerglass_alerts_evaluation_lag_seconds_bucket" not in names(out)
    # A valid one resumes, and re-arms the warning.
    beat(client, metrics=SVC_METRICS)
    assert value(scrape(client), "tickerglass_alerts_evaluations_total") == 120
    with caplog.at_level(logging.WARNING):
        beat(client, metrics=bad)
    assert len([r for r in caplog.records if "invalid metrics" in r.getMessage()]) == 2
    assert not any(n.startswith("tickerglass_alerts_evaluations") for n in names(scrape(client)))


def test_heartbeat_without_metrics_is_still_accepted(make_client: Maker) -> None:
    client = make_metrics(make_client)
    beat(client)
    out = scrape(client)
    assert value(out, "tickerglass_alerts_service_up") == 1
    assert "tickerglass_alerts_evaluations_total" not in names(out)


def test_offline_service_exports_no_stale_numbers(make_client: Maker) -> None:
    client = make_metrics(make_client)
    beat(client, metrics=SVC_METRICS)
    state = client.app.state.alerts_service  # type: ignore[attr-defined]
    state.last_at = datetime.now(UTC) - timedelta(seconds=91)
    out = scrape(client)
    assert value(out, "tickerglass_alerts_service_up") == 0
    assert value(out, "tickerglass_alerts_service_last_heartbeat_timestamp_seconds") is not None
    got = names(out)
    assert not {n for n in got if n.startswith("tickerglass_alerts_evaluation")}
    assert (
        not {
            "tickerglass_alerts_series",
            "tickerglass_alerts_fire_queue_depth",
            "tickerglass_alerts_script_faults_total",
        }
        & got
    )


@pytest.mark.parametrize(
    "patch",
    [
        {"evaluations": 1.0},
        {"evaluations": -1},
        {"evaluations": True},
        {"fireQueueDepth": "3"},
        {"evaluations": None},
        {"extra": 1},
        {"lag": {**SVC_METRICS["lag"], "buckets": [1, 1, 2, 3, 4, 5, 6, 7, 8, 9]}},
        {"lag": {**SVC_METRICS["lag"], "buckets": [3, 2, 1, 0.5, 0.2, 0.1, 5, 6, 7, 8]}},
        {"lag": {**SVC_METRICS["lag"], "buckets": [float("inf")] * 10}},
        {"lag": {**SVC_METRICS["lag"], "buckets": [float("nan")] + LAG_BUCKETS[1:]}},
        {"lag": {**SVC_METRICS["lag"], "buckets": list(range(21)), "counts": [0] * 21}},
        {"lag": {**SVC_METRICS["lag"], "counts": [1, 3, 5]}},
        {"lag": {**SVC_METRICS["lag"], "counts": [1, 3, 2, 6, 6, 7, 8, 8, 8, 8]}},
        {"lag": {**SVC_METRICS["lag"], "counts": [1, 3, 5, 6, 6, 7, 8, 8, 8, 10]}},
        {"lag": {**SVC_METRICS["lag"], "counts": [1.5, 3, 5, 6, 6, 7, 8, 8, 8, 8]}},
        {"lag": {**SVC_METRICS["lag"], "sum": -1}},
        {"lag": {**SVC_METRICS["lag"], "sum": float("inf")}},
        {"lag": {**SVC_METRICS["lag"], "count": 7}},
        {"lag": None},
    ],
)
def test_heartbeat_metrics_validation_rejects(patch: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        HeartbeatMetrics.model_validate({**SVC_METRICS, **patch})


def test_heartbeat_metrics_validation_accepts_the_contract() -> None:
    parsed = HeartbeatMetrics.model_validate(SVC_METRICS)
    assert parsed.lag.count == 9 and parsed.evaluations == 120
    empty = {**SVC_METRICS, "lag": {"buckets": [], "counts": [], "count": 0, "sum": 0}}
    HeartbeatMetrics.model_validate(empty)


# -------------------------------------------------------------- DB-derived data


def test_database_sections_aggregate_every_owner(make_client: Maker) -> None:
    client = make_metrics(make_client)
    with Session(engine_of(client)) as session:
        session.add(
            m.ScreenerRun(
                kind="snapshot",
                trigger="schedule",
                provider="demo",
                target_date=datetime(2026, 11, 14).date(),
                status="done",
                total=1,
                done=1,
                failed=0,
                tokens=0,
                started_at=datetime(2026, 11, 14, 22, 0, tzinfo=UTC),
                finished_at=datetime(2026, 11, 14, 22, 5, tzinfo=UTC),
            )
        )
        session.add(
            m.ScreenerSnapshot(
                symbol="AAA",
                provider="demo",
                as_of_date=datetime(2026, 11, 14).date(),
                bar_ts=1,
                computed_at=datetime(2026, 11, 14, 22, 5, tzinfo=UTC),
                bars_count=1,
            )
        )
        session.add_all(
            [
                m.BackupRun(
                    started_at=datetime(2026, 11, 15, 3, 30, tzinfo=UTC),
                    finished_at=datetime(2026, 11, 15, 3, 31, tzinfo=UTC),
                    trigger="schedule",
                    status="ok",
                    size=1234,
                ),
                m.BackupRun(
                    started_at=datetime(2026, 11, 16, 3, 30, tzinfo=UTC),
                    trigger="schedule",
                    status="failed",
                ),
            ]
        )
        session.commit()
    first, second = create(client), create(client, name="Second")  # active, any owner
    paused = client.put(
        f"/api/alerts/{second['id']}",
        json={**body(name="Second"), "status": "paused", "revision": second["revision"]},
    )
    assert paused.status_code == 200, paused.text
    out = scrape(client)
    assert first["status"] == "active"
    assert value(out, "tickerglass_alerts_active", kind="price") == 1  # the paused one is out
    assert value(out, "tickerglass_alerts_active", kind="drawing") == 0
    assert value(out, "tickerglass_screener_snapshot_rows") == 1
    age = value(out, "tickerglass_screener_snapshot_age_seconds")
    assert age is not None and age > 0
    stamp = datetime(2026, 11, 14, 22, 5, tzinfo=UTC).timestamp()
    assert (
        value(
            out, "tickerglass_screener_last_run_timestamp_seconds", kind="snapshot", status="done"
        )
        == stamp
    )
    assert value(out, "tickerglass_backup_last_run_status", status="failed") == 1
    assert value(out, "tickerglass_backup_last_run_status", status="ok") is None
    assert value(out, "tickerglass_backup_last_size_bytes") == 1234
    assert (
        value(out, "tickerglass_backup_last_success_timestamp_seconds")
        == datetime(2026, 11, 15, 3, 31, tzinfo=UTC).timestamp()
    )


def test_empty_database_omits_what_has_no_value(make_client: Maker) -> None:
    out = scrape(make_metrics(make_client))
    got = names(out)
    assert "tickerglass_screener_snapshot_age_seconds" not in got
    assert "tickerglass_backup_last_success_timestamp_seconds" not in got
    assert "tickerglass_backup_last_run_status" not in got
    assert value(out, "tickerglass_screener_snapshot_rows") == 0
    assert value(out, "tickerglass_notifications_oldest_pending_age_seconds") == 0
    assert value(out, "tickerglass_notifications_outbox", status="pending") == 0


def test_oldest_pending_age_and_outbox_counts(
    maker: sessionmaker[Session],  # noqa: F811
) -> None:
    seed(maker, [("webhook", None), ("ntfy", None)])
    holder = SimpleNamespace(state=SimpleNamespace(sessionmaker=maker))
    out = Metrics(holder).render().decode()
    assert value(out, "tickerglass_notifications_outbox", status="pending") == 2
    assert value(out, "tickerglass_notifications_outbox", status="failed") == 0
    age = value(out, "tickerglass_notifications_oldest_pending_age_seconds")
    assert age is not None and age > (datetime.now(UTC) - T0).total_seconds() - 5
    # Sections whose state is missing from the app are skipped, not errors.
    assert value(out, "tickerglass_metrics_collect_errors_total", section="provider") == 0


def test_db_reads_are_cached_between_scrapes(make_client: Maker) -> None:
    client = make_metrics(make_client)
    statements: list[str] = []

    @event.listens_for(engine_of(client), "before_cursor_execute")
    def _record(_c: Any, _cur: Any, statement: str, *_: Any) -> None:
        statements.append(statement)

    scrape(client)
    first = [s for s in statements if "alert_deliveries" in s]
    assert first
    scrape(client)
    scrape(client)
    assert [s for s in statements if "alert_deliveries" in s] == first  # no new reads


def test_a_failing_section_is_counted_and_the_scrape_still_succeeds(
    make_client: Maker, caplog: pytest.LogCaptureFixture
) -> None:
    client = make_metrics(make_client)
    with engine_of(client).begin() as conn:
        conn.execute(text("DROP TABLE alert_deliveries"))
    with caplog.at_level(logging.WARNING):
        out = scrape(client)
        again = scrape(client)
    assert value(out, "tickerglass_metrics_collect_errors_total", section="notifications") == 1
    assert value(again, "tickerglass_metrics_collect_errors_total", section="notifications") == 2
    assert value(again, "tickerglass_metrics_collect_errors_total", section="screener") == 0
    assert "tickerglass_notifications_outbox" not in names(out)
    assert "tickerglass_screener_snapshot_rows" in names(out)  # other sections unaffected
    assert "tickerglass_alerts_active" in names(out)
    assert len([r for r in caplog.records if "section notifications" in r.getMessage()]) == 1


def test_a_failing_alerts_query_keeps_the_service_metrics(make_client: Maker) -> None:
    client = make_metrics(make_client)
    beat(client)
    with engine_of(client).begin() as conn:
        conn.execute(text("DROP TABLE alert_states"))  # unrelated table: nothing breaks
        conn.execute(text("ALTER TABLE alerts RENAME TO alerts_gone"))
    out = scrape(client)
    assert value(out, "tickerglass_metrics_collect_errors_total", section="alerts") == 1
    assert value(out, "tickerglass_alerts_service_up") == 1
    assert "tickerglass_alerts_active" not in names(out)


# ---------------------------------------------------------- in-process counters


def test_fired_counter_counts_new_fires_only(make_client: Maker) -> None:
    client = make_metrics(make_client)
    alert = create(client)
    assert fire(client, alert, "f1").status_code == 200
    assert fire(client, alert, "f1").status_code == 200  # a retried fire: same entry
    out = scrape(client)
    assert value(out, "tickerglass_alerts_fired_total", source="chart") == 1
    assert value(out, "tickerglass_alerts_fired_total", source="screener") == 0
    # A conflicting fire (stale revision) is not a fire.
    stale = {**alert, "revision": 99}
    assert fire(client, stale, "f2").status_code == 409
    assert value(scrape(client), "tickerglass_alerts_fired_total", source="chart") == 1


def test_screener_job_reports_fired_screens(make_client: Maker) -> None:
    client = make_metrics(make_client)
    screener = client.app.state.market_stack.screener  # type: ignore[attr-defined]
    assert screener._on_fired is not None
    screener._on_fired(3)
    assert value(scrape(client), "tickerglass_alerts_fired_total", source="screener") == 3


def test_dispatcher_counts_sent_retry_and_failed(
    maker: sessionmaker[Session],  # noqa: F811
    net: FakeNet,  # noqa: F811
) -> None:
    metrics = Metrics(SimpleNamespace(state=SimpleNamespace()))
    cfg = settings(alerts_webhook_url="https://hook.example/")

    def count(channel: str, outcome: str) -> float | None:
        return metrics.registry.get_sample_value(
            "tickerglass_notifications_deliveries_total", {"channel": channel, "outcome": outcome}
        )

    seed(maker, [("webhook", None)])
    d = Dispatcher(maker, cfg, metrics=metrics)
    net.script = [http_error(503)]
    assert run(d, T0) == 1  # 503: retried later
    assert [count("webhook", o) for o in ("sent", "retry", "failed")] == [0, 1, 0]
    assert run(d, T0 + timedelta(seconds=10)) == 1  # the fake's default answer is a success
    assert [count("webhook", o) for o in ("sent", "retry", "failed")] == [1, 1, 0]
    assert count("ntfy", "sent") == 0  # every channel starts at zero


def test_dispatcher_counts_a_permanent_failure(
    maker: sessionmaker[Session],  # noqa: F811
    net: FakeNet,  # noqa: F811
) -> None:
    metrics = Metrics(SimpleNamespace(state=SimpleNamespace()))
    seed(maker, [("webhook", None)])
    net.script = [http_error(400)]
    d = Dispatcher(maker, settings(alerts_webhook_url="https://hook.example/"), metrics=metrics)
    assert run(d, T0) == 1
    got = metrics.registry.get_sample_value(
        "tickerglass_notifications_deliveries_total", {"channel": "webhook", "outcome": "failed"}
    )
    assert got == 1


def test_dispatcher_counts_unknown_channels_as_other() -> None:
    metrics = Metrics(SimpleNamespace(state=SimpleNamespace()))
    metrics.delivery("carrier-pigeon", "failed")
    got = metrics.registry.get_sample_value(
        "tickerglass_notifications_deliveries_total", {"channel": "other", "outcome": "failed"}
    )
    assert got == 1


def delta(provider: str, outcome: str, before: dict[tuple[str, str], int]) -> int:
    return upstream.snapshot().get((provider, outcome), 0) - before.get((provider, outcome), 0)


def test_json_http_counts_each_outcome() -> None:
    before = upstream.snapshot()
    script: list[Any] = [
        (200, {}, b"{}"),
        (404, {}, b"{}"),
        (429, {"Retry-After": "1"}, b"{}"),
        (503, {}, b""),
        OSError("down"),
        ProviderError("boom"),
    ]

    def send(url: str, headers: Any, timeout: float) -> Any:
        step = script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    http = JsonHttp("https://api.example.test", send=send, provider="probe")
    http.get("/a", {})
    with pytest.raises(HttpStatusError):
        http.get("/b", {})
    with pytest.raises(HttpRateLimited):
        http.get("/c", {})
    with pytest.raises(UpstreamUnavailable):
        http.get("/d", {})
    with pytest.raises(UpstreamUnavailable):
        http.get("/e", {})
    with pytest.raises(ProviderError):
        http.get("/f", {})
    assert delta("probe", "ok", before) == 1
    assert delta("probe", "rate_limited", before) == 1
    assert delta("probe", "unavailable", before) == 2
    assert delta("probe", "error", before) == 2  # the 404 and the transport's own error


def test_yahoo_counts_every_attempt_including_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("tickerglass_api.providers.yahoo.time.sleep", lambda _: None)
    before = upstream.snapshot()
    provider = YahooProvider(min_interval=0, retries=2, rate_limit_retries=1)
    assert provider._call(lambda: 42) == 42
    calls = iter([YFRateLimitError(), 7])

    def flaky() -> int:
        step = next(calls)
        if isinstance(step, Exception):
            raise step
        return step

    assert provider._call(flaky) == 7  # one rate-limited attempt, then ok

    def limited() -> int:
        raise YFRateLimitError()

    with pytest.raises(RateLimited):
        provider._call(limited)  # two attempts, both refused
    with pytest.raises(UpstreamUnavailable):
        provider._call(lambda: (_ for _ in ()).throw(ConnectionError("x")))  # three attempts
    assert delta("yahoo", "ok", before) == 2
    assert delta("yahoo", "rate_limited", before) == 3
    assert delta("yahoo", "unavailable", before) == 3


def test_scrape_reports_provider_counts(make_client: Maker) -> None:
    client = make_metrics(make_client)
    upstream.record("probe2", "ok")
    upstream.record("probe2", "bogus")  # an unknown outcome is an error
    out = scrape(client)
    assert value(out, "tickerglass_provider_requests_total", provider="probe2", outcome="ok") == 1
    assert (
        value(out, "tickerglass_provider_requests_total", provider="probe2", outcome="error") == 1
    )
    assert value(out, "tickerglass_provider_breaker_open", provider="custom") == 0
    assert (
        value(out, "tickerglass_provider_budget_remaining", provider="custom", window="burst")
        is not None
    )


def test_guard_refusals_and_breaker_are_read_at_scrape(make_client: Maker) -> None:
    client = make_metrics(make_client)
    guard = client.app.state.upstream_guard  # type: ignore[attr-defined]
    guard._refused["budget"] = 5
    guard._rate_limited_until = guard._clock() + 600
    out = scrape(client)
    assert value(out, "tickerglass_provider_refused_total", provider="custom", reason="budget") == 5
    assert value(out, "tickerglass_provider_breaker_open", provider="custom") == 1
