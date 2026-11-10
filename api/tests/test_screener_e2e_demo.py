"""Server screener end to end on the real app with the built-in demo provider (no network):
a manual snapshot run fills the tables, then scan / status / snapshot read them and a screen
alert fires when data changes between two runs (docs/design/server-screener.md)."""

import time
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from tickerglass_api import models as m
from tickerglass_api.app import create_app
from tickerglass_api.services.screener import universe as uv
from tickerglass_api.services.screener.alerts import parse_state
from tickerglass_api.settings import Settings

TRACKED = 30
DEADLINE_S = 60.0


def wait_for(check: Callable[[], Any], what: str) -> Any:
    end = time.monotonic() + DEADLINE_S
    while time.monotonic() < end:
        got = check()
        if got:
            return got
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(  # type: ignore[call-arg]
        _env_file=None,
        market_provider="demo",
        database_url=f"sqlite:///{tmp_path}/demo.db",
        screener_max_symbols=TRACKED,
        screener_include_watchlists=False,
        # Pacing is `requests * 60 / min(rate, guard rate / 3)`: huge rates, no waiting at all.
        upstream_rate_per_min=1_000_000,
        upstream_burst=1_000,
        screener_rate_per_min=1_000_000,
        screener_info_rate_per_min=1_000_000,
    )
    app = create_app(settings_override=settings)
    with TestClient(app) as c:
        yield c


def run_snapshot(client: TestClient) -> int:
    res = client.post("/api/screener/runs", json={"kind": "snapshot"})
    assert res.status_code == 202, res.text
    run_id = int(res.json()["runId"])
    engine = client.app.state.engine  # type: ignore[attr-defined]

    def finished() -> m.ScreenerRun | None:
        with Session(engine) as s:
            run = s.get(m.ScreenerRun, run_id)
            return run if run is not None and run.status != "running" else None

    run = wait_for(finished, f"snapshot run {run_id}")
    assert run.status in ("done", "partial"), (run.status, run.error)
    # The post-run alert evaluation happens after the run row is final: wait for the job.
    wait_for(lambda: client.get("/api/screener/status").json()["running"] is None, "idle job")
    return run_id


def tracked_count(s: Session) -> int:
    """Tracked stocks with a snapshot (the screen's universe is the stocks class)."""
    return len(set(uv.class_symbols("stocks")) & set(s.scalars(select(m.ScreenerSnapshot.symbol))))


def log_entries(client: TestClient) -> list[m.AlertLog]:
    with Session(client.app.state.engine) as s:  # type: ignore[attr-defined]
        return list(s.scalars(select(m.AlertLog).order_by(m.AlertLog.id)))


def test_demo_snapshot_run_scan_status_and_screen_alert(client: TestClient) -> None:
    status = client.get("/api/screener/status").json()
    assert status["enabled"] is True and status["supported"] is True
    assert status["provider"] == "demo" and status["asOf"] is None
    assert status["reason"] == "first_run"
    assert status["coverage"]["tracked"] == TRACKED

    # A screen with an alert whose filter nothing matches yet: its first evaluation is the
    # baseline (an empty member set), so only a later entry can fire.
    screen = {
        "id": "scr-hot",
        "name": "Overbought",
        "spec": {
            "schemaVersion": 1,
            "universe": {"kind": "class", "cls": "stocks"},
            "filter": {"op": "and", "rules": [{"field": "rsi14", "op": ">", "value": 1000}]},
            "sort": {"field": "rsi14", "dir": "desc"},
        },
        "alert": {"enabled": True, "notify": {"webhook": False, "telegram": False, "email": False}},
    }
    assert client.post("/api/screener/screens", json=screen).status_code == 201

    # ---- first run
    first = run_snapshot(client)
    status = client.get("/api/screener/status").json()
    assert status["asOf"] is not None and status["computedAt"] is not None
    assert status["reason"] is None
    assert status["coverage"]["fresh"] == TRACKED and status["coverage"]["failed"] == 0
    assert status["barsRows"] > 0
    assert status["budget"]["tokensLastRun"] is not None
    with Session(client.app.state.engine) as s:  # type: ignore[attr-defined]
        run = s.get(m.ScreenerRun, first)
        assert run is not None and run.done == TRACKED and run.failed == 0
        state = s.get(m.ScreenState, "scr-hot")
        parsed = parse_state(state.members) if state is not None else None
        assert parsed is not None and parsed[0] == []  # the baseline
        assert len(parsed[1]) == tracked_count(s)  # every stock is covered
    assert log_entries(client) == []

    # ---- scan: filter + sort on a technical field
    body = {
        "universe": {"kind": "class", "cls": "stocks"},
        "filter": {"op": "and", "rules": [{"field": "rsi14", "op": ">", "value": 0}]},
        "sort": {"field": "rsi14", "dir": "desc"},
        "limit": 5,
        "fields": ["last", "rsi14", "sma50", "perf1m", "smaCross"],
    }
    res = client.post("/api/screener/scan", json=body)
    assert res.status_code == 200, res.text
    scan = res.json()
    assert scan["provider"] == "demo" and scan["asOf"] == status["asOf"]
    # The tracked set is capped in rank order across classes: only part of it is stocks.
    with Session(client.app.state.engine) as s:  # type: ignore[attr-defined]
        tracked_stocks = len(
            set(uv.class_symbols("stocks")) & set(s.scalars(select(m.ScreenerSnapshot.symbol)))
        )
    assert 5 < tracked_stocks < TRACKED
    assert scan["coverage"]["withSnapshot"] == tracked_stocks
    assert scan["total"] == tracked_stocks and len(scan["rows"]) == 5
    rsis = [r["values"]["rsi14"] for r in scan["rows"]]
    assert all(isinstance(v, float) and 0 < v <= 100 for v in rsis)
    assert rsis == sorted(rsis, reverse=True)
    assert all(r["values"]["last"] > 0 and not r["stale"] for r in scan["rows"])

    top = scan["rows"][0]["symbol"]
    res = client.post(
        "/api/screener/scan",
        json={
            **body,
            "filter": {"op": "and", "rules": [{"field": "rsi14", "op": "<", "value": 0}]},
        },
    )
    assert res.status_code == 200 and res.json()["total"] == 0

    # ---- snapshot
    res = client.get(f"/api/screener/snapshot?symbols={top},NOPE")
    assert res.status_code == 200
    snap = res.json()
    assert snap["asOf"] == status["asOf"] and set(snap["rows"]) == {top}
    assert snap["rows"][top]["rsi14"] == scan["rows"][0]["values"]["rsi14"]

    # ---- second run with changed data: one symbol enters the screen
    with Session(client.app.state.engine) as s, s.begin():  # type: ignore[attr-defined]
        s.execute(
            update(m.ScreenerSnapshot).where(m.ScreenerSnapshot.symbol == top).values(rsi14=2000.0)
        )
    # Nothing is due: a manual run right after a done one is refused (10 min cooldown).
    res = client.post("/api/screener/runs", json={"kind": "snapshot"})
    assert res.status_code == 409, res.text
    with Session(client.app.state.engine) as s, s.begin():  # type: ignore[attr-defined]
        s.execute(
            update(m.ScreenerRun)
            .where(m.ScreenerRun.id == first)
            .values(finished_at=datetime.now(UTC) - timedelta(minutes=11))
        )
    second = run_snapshot(client)
    assert second > first
    (entry,) = log_entries(client)
    assert entry.kind == "screen" and entry.alert_id is None
    assert entry.symbol == top and entry.alert_name == "Overbought"
    assert entry.values["screenId"] == "scr-hot" and entry.values["entered"] == [top]
    log_api = client.get("/api/alerts/log").json()["entries"]
    assert [e["message"] for e in log_api] == [entry.message]
