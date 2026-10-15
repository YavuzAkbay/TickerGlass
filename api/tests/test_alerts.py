"""Phase 10 alerts API: CRUD and validation, revisions, firing, state, log, channels,
bundle sections and `/ws` event topics (docs/alerts.md §1, §6.3)."""

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Connection, create_engine, func, insert, inspect, select, update
from test_userdata import NullProvider, drawing, engine_of, interleave

from investopen_api import models as m
from investopen_api.app import create_app
from investopen_api.settings import Settings
from investopen_api.userdata.alerts import AlertIn

FIXTURES = Path(__file__).resolve().parents[2] / "packages" / "alerts" / "test" / "fixtures"


# ----------------------------------------------------------------- helpers


@pytest.fixture
def make_client(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    """App factory with settings overrides (channels, token, log retention)."""
    clients: list[TestClient] = []

    def make(**settings: Any) -> TestClient:
        app = create_app(
            provider=NullProvider(),
            database_url=f"sqlite:///{tmp_path}/a{len(clients)}.db",
            settings_override=Settings(_env_file=None, **settings),  # type: ignore[call-arg]
        )
        c = TestClient(app)
        c.__enter__()
        clients.append(c)
        return c

    yield make
    for c in clients:
        c.__exit__(None, None, None)


SPEC = {
    "schemaVersion": 1,
    "left": {"kind": "price", "field": "close"},
    "condition": {"op": "crossing", "right": {"kind": "value", "value": 190}},
    "trigger": "oncePerBar",
}


def body(**kw: Any) -> dict[str, Any]:
    return {"name": "AAPL > 190", "symbol": "AAPL", "interval": "1D", "spec": SPEC, **kw}


def spec_with(**kw: Any) -> dict[str, Any]:
    return {**SPEC, **kw}


def create(client: TestClient, **kw: Any) -> dict[str, Any]:
    res = client.post("/api/alerts", json=body(**kw))
    assert res.status_code == 201, res.text
    out: dict[str, Any] = res.json()
    return out


def fire_body(alert: dict[str, Any], fire_id: str = "f1", **kw: Any) -> dict[str, Any]:
    return {
        "fireId": fire_id,
        "revision": alert["revision"],
        "firedAt": "2026-10-15T14:30:00Z",
        "barTime": 1_791_000_000,
        "final": False,
        "delayed": False,
        "message": "AAPL Crossing 190.00",
        "values": {"x": 190.5, "y": 190, "open": 189, "high": 191, "low": 188, "close": 190.5},
        **kw,
    }


def fire(client: TestClient, alert: dict[str, Any], fire_id: str = "f1", **kw: Any) -> Any:
    return client.post(f"/api/alerts/{alert['id']}/fire", json=fire_body(alert, fire_id, **kw))


def save_drawing(client: TestClient, did: str, **kw: Any) -> None:
    res = client.post("/api/drawings/batch", json={"upserts": [{"drawing": drawing(did, **kw)}]})
    assert res.status_code == 200, res.text


def drawing_spec(did: str, part: str = "line") -> dict[str, Any]:
    right = {"kind": "drawing", "drawingId": did, "part": part, "scale": "linear"}
    return spec_with(condition={"op": "crossingUp", "right": right})


def count(client: TestClient, model: Any) -> int:
    with engine_of(client).connect() as conn:
        return conn.scalar(select(func.count()).select_from(model)) or 0


# ------------------------------------------------------- shared validation


@pytest.mark.parametrize("path", sorted((FIXTURES / "valid").glob("*.json")), ids=lambda p: p.stem)
def test_valid_fixtures(path: Path) -> None:
    parsed = AlertIn.model_validate(json.loads(path.read_text()))
    dumped = parsed.spec.model_dump(mode="json", by_alias=True)
    assert dumped == json.loads(path.read_text())["spec"]  # lossless (ints stay ints)


@pytest.mark.parametrize(
    "path", sorted((FIXTURES / "invalid").glob("*.json")), ids=lambda p: p.stem
)
def test_invalid_fixtures(path: Path) -> None:
    with pytest.raises(ValidationError):
        AlertIn.model_validate(json.loads(path.read_text()))


def test_fixtures_are_rejected_over_http(client: TestClient) -> None:
    for path in sorted((FIXTURES / "invalid").glob("*.json")):
        res = client.post(
            "/api/alerts", content=path.read_text(), headers={"content-type": "application/json"}
        )
        assert res.status_code == 422, path.name


# -------------------------------------------------------------------- CRUD


def test_crud_roundtrip(client: TestClient) -> None:
    assert client.get("/api/alerts").json() == []
    a = create(client, id="a1", message="{{ticker}}", expiresAt="2099-01-01T00:00:00+02:00")
    assert a["id"] == "a1" and a["revision"] == 1 and a["status"] == "active"
    assert a["fireCount"] == 0 and a["lastFiredAt"] is None and a["statusReason"] is None
    assert a["drawingId"] is None and a["expiresAt"] == "2098-12-31T22:00:00Z"
    assert a["notify"]["toast"] is True and a["notify"]["webhookUrl"] is None
    assert a["spec"] == SPEC and a["prepost"] is False

    assert client.get("/api/alerts/a1").json() == a
    assert client.get("/api/alerts/nope").status_code == 404
    second = create(client, name="Second", status="paused")
    assert second["status"] == "paused" and len(second["id"]) == 36
    listed = client.get("/api/alerts").json()
    assert [x["id"] for x in listed] == [second["id"], "a1"]  # newest first
    assert [x["id"] for x in client.get("/api/alerts?status=paused").json()] == [second["id"]]
    assert client.get("/api/alerts?symbol=MSFT").json() == []
    assert client.get("/api/alerts?status=bogus").status_code == 422

    # Existing client-chosen id -> 409 with the stored alert.
    dup = client.post("/api/alerts", json=body(id="a1", name="other"))
    assert dup.status_code == 409
    assert dup.json()["detail"]["current"]["name"] == "AAPL > 190"

    assert client.delete("/api/alerts/a1").status_code == 204
    assert client.delete("/api/alerts/a1").status_code == 404
    assert client.get("/api/alerts/a1").status_code == 404


@pytest.mark.parametrize("reserved", ["log", "states", "channels", "service"])
def test_reserved_ids_rejected(client: TestClient, reserved: str) -> None:
    assert client.post("/api/alerts", json=body(id=reserved)).status_code == 422


def test_limit_of_1000_alerts(client: TestClient) -> None:
    t = datetime.now(UTC)
    rows = [
        {
            "id": f"x{i}",
            "name": "n",
            "symbol": "A",
            "interval": "1D",
            "prepost": False,
            "spec": SPEC,
            "schema_version": 1,
            "message": "",
            "notify": {},
            "status": "paused",
            "revision": 1,
            "fire_count": 0,
            "created_at": t,
            "updated_at": t,
        }
        for i in range(1000)
    ]
    with engine_of(client).begin() as conn:
        conn.execute(insert(m.Alert), rows)
    res = client.post("/api/alerts", json=body())
    assert res.status_code == 422 and "1000" in res.json()["detail"]


def test_oversized_spec_rejected(client: TestClient) -> None:
    inputs = {f"k{i}": "x" * 150 for i in range(60)}
    inst = [{"id": "a", "type": "sma", "inputs": inputs}]
    left = {
        "kind": "indicator",
        "ref": {"instances": inst * 1, "instanceId": "a", "outputId": "o", "title": "t"},
    }
    ok = client.post("/api/alerts", json=body(spec=spec_with(left=left)))
    assert ok.status_code == 201  # ~9 KB: fine
    inputs = {f"k{i}": "x" * 200 for i in range(64)}
    big = [{"id": f"i{n}", "type": "sma", "inputs": inputs} for n in range(8)]
    left["ref"]["instances"] = big
    left["ref"]["instanceId"] = "i0"
    assert client.post("/api/alerts", json=body(spec=spec_with(left=left))).status_code == 422


def test_sixteen_instances_total_across_operands(client: TestClient) -> None:
    def ref(prefix: str, n: int) -> dict[str, Any]:
        inst = [{"id": f"{prefix}{i}", "type": "sma", "inputs": {}} for i in range(n)]
        return {
            "kind": "indicator",
            "ref": {"instances": inst, "instanceId": f"{prefix}0", "outputId": "o", "title": "t"},
        }

    s = spec_with(left=ref("a", 9), condition={"op": "greater", "right": ref("b", 8)})
    assert client.post("/api/alerts", json=body(spec=s)).status_code == 422
    s = spec_with(left=ref("a", 8), condition={"op": "greater", "right": ref("b", 8)})
    assert client.post("/api/alerts", json=body(spec=s)).status_code == 201


def test_expiry_in_the_past_is_rejected_for_active(client: TestClient) -> None:
    past = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
    assert client.post("/api/alerts", json=body(expiresAt=past)).status_code == 422
    assert client.post("/api/alerts", json=body(expiresAt=past, status="paused")).status_code == 201


# ---------------------------------------------------------------- drawings


def test_drawing_operand_needs_a_stored_drawing(client: TestClient) -> None:
    res = client.post("/api/alerts", json=body(spec=drawing_spec("d1")))
    assert res.status_code == 422 and res.json()["detail"] == "drawing not saved: d1"

    save_drawing(client, "d1")
    a = client.post("/api/alerts", json=body(spec=drawing_spec("d1")))
    assert a.status_code == 201 and a.json()["drawingId"] == "d1"

    # A line tool has no channel parts.
    res = client.post("/api/alerts", json=body(spec=drawing_spec("d1", "upper")))
    assert res.status_code == 422 and "channel" in res.json()["detail"]


def test_drawing_channel_parts_and_scope(client: TestClient) -> None:
    save_drawing(client, "rect", type="rectangle")
    save_drawing(client, "pc3", type="parallel-channel", points=[{}, {}, {}])
    save_drawing(client, "pc2", type="parallel-channel", points=[{}, {}])
    save_drawing(client, "flat", type="flat-top-bottom", points=[{}, {}, {}])
    save_drawing(client, "flat2", type="flat-top-bottom", points=[{}, {}])
    save_drawing(client, "dj4", type="disjoint-channel", points=[{}, {}, {}, {}])
    save_drawing(client, "dj3", type="disjoint-channel", points=[{}, {}, {}])
    save_drawing(client, "dj2", type="disjoint-channel", points=[{}, {}])
    save_drawing(client, "msft", symbol="MSFT")
    save_drawing(client, "synced", scope="all", symbol=None)

    for did in ("rect", "pc3", "flat", "dj4", "dj3"):
        assert (
            client.post("/api/alerts", json=body(spec=drawing_spec(did, "upper"))).status_code
            == 201
        )
        whole = {
            "op": "insideChannel",
            "channel": {"kind": "drawing", "drawingId": did, "scale": "log"},
        }
        res = client.post("/api/alerts", json=body(spec=spec_with(condition=whole)))
        assert res.status_code == 201 and res.json()["drawingId"] == did
    for did in ("pc2", "flat2", "dj2"):
        res = client.post("/api/alerts", json=body(spec=drawing_spec(did, "lower")))
        assert res.status_code == 422 and "flat-top-bottom" in res.json()["detail"]
    # Their lines are not a single 'line' part either.
    assert client.post("/api/alerts", json=body(spec=drawing_spec("flat"))).status_code == 422
    whole = {
        "op": "insideChannel",
        "channel": {"kind": "drawing", "drawingId": "d", "scale": "log"},
    }
    assert client.post("/api/alerts", json=body(spec=spec_with(condition=whole))).status_code == 422

    # Symbol scope: must equal the alert's symbol unless the drawing is synced.
    res = client.post("/api/alerts", json=body(spec=drawing_spec("msft")))
    assert res.status_code == 422 and "MSFT" in res.json()["detail"]
    assert client.post("/api/alerts", json=body(spec=drawing_spec("synced"))).status_code == 201

    # The first drawing operand wins (bounds channel: upper before lower).
    bounds = {
        "op": "enteringChannel",
        "channel": {
            "kind": "bounds",
            "upper": {"kind": "drawing", "drawingId": "synced", "part": "line", "scale": "linear"},
            "lower": {"kind": "drawing", "drawingId": "rect", "part": "lower", "scale": "linear"},
        },
    }
    res = client.post("/api/alerts", json=body(spec=spec_with(condition=bounds)))
    assert res.status_code == 201 and res.json()["drawingId"] == "synced"


# ------------------------------------------------------- PUT / PATCH rules


def test_put_revision_conflict_and_state_cleanup(client: TestClient) -> None:
    a = create(client, id="a1")
    st = [{"alertId": "a1", "revision": 1, "state": {"prev": 1}}]
    assert client.put("/api/alerts/states", json={"states": st}).json()["written"] == ["a1"]

    res = client.put("/api/alerts/a1", json=body(name="v2", revision=1))
    assert res.status_code == 200
    v2 = res.json()
    assert v2["revision"] == 2 and v2["name"] == "v2" and v2["updatedAt"] >= a["updatedAt"]
    assert client.get("/api/alerts/states").json() == []  # state row dropped

    stale = client.put("/api/alerts/a1", json=body(name="v3", revision=1))
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["name"] == "v2"
    assert client.get("/api/alerts/a1").json()["name"] == "v2"

    # Omitting the revision overwrites ("keep mine").
    res = client.put("/api/alerts/a1", json=body(name="v3"))
    assert res.status_code == 200 and res.json()["revision"] == 3

    assert client.put("/api/alerts/nope", json=body()).status_code == 404
    assert client.put("/api/alerts/a1", json=body(id="other")).status_code == 422


def test_put_status_semantics(client: TestClient) -> None:
    a = create(client, id="a1")
    client.patch("/api/alerts/a1", json={"status": "paused"})
    # Default keeps paused.
    assert client.put("/api/alerts/a1", json=body()).json()["status"] == "paused"
    assert client.put("/api/alerts/a1", json=body(status="active")).json()["status"] == "active"
    # triggered/expired/error become active, and the reason is cleared.
    with engine_of(client).begin() as conn:
        conn.execute(update(m.Alert).values(status="error", status_reason="drawing not found"))
    res = client.put("/api/alerts/a1", json=body())
    assert res.json()["status"] == "active" and res.json()["statusReason"] is None
    past = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    assert client.put("/api/alerts/a1", json=body(expiresAt=past)).status_code == 422
    paused = client.put("/api/alerts/a1", json=body(expiresAt=past, status="paused"))
    assert paused.status_code == 200
    assert a["id"] == "a1"


def test_patch_pause_restart_and_conflict(client: TestClient) -> None:
    create(client, id="a1")
    client.put(
        "/api/alerts/states", json={"states": [{"alertId": "a1", "revision": 1, "state": {}}]}
    )
    res = client.patch("/api/alerts/a1", json={"status": "paused", "revision": 1})
    assert res.status_code == 200
    assert res.json()["status"] == "paused" and res.json()["revision"] == 2
    assert client.get("/api/alerts/states").json() == []

    stale = client.patch("/api/alerts/a1", json={"status": "active", "revision": 1})
    assert stale.status_code == 409 and stale.json()["detail"]["current"]["revision"] == 2

    # Restart from `triggered` keeps fireCount and clears the reason.
    with engine_of(client).begin() as conn:
        conn.execute(update(m.Alert).values(status="triggered", fire_count=4, status_reason="x"))
    res = client.patch("/api/alerts/a1", json={"status": "active"})
    out = res.json()
    assert out["status"] == "active" and out["fireCount"] == 4 and out["statusReason"] is None
    assert out["revision"] == 3

    # expiresAt: absent = unchanged, null clears, past on an active alert -> 422.
    future = "2099-01-01T00:00:00Z"
    assert (
        client.patch("/api/alerts/a1", json={"status": "active", "expiresAt": future}).json()[
            "expiresAt"
        ]
        == future
    )
    assert client.patch("/api/alerts/a1", json={"status": "active"}).json()["expiresAt"] == future
    assert (
        client.patch("/api/alerts/a1", json={"status": "active", "expiresAt": None}).json()[
            "expiresAt"
        ]
        is None
    )
    past = "2000-01-01T00:00:00Z"
    assert (
        client.patch("/api/alerts/a1", json={"status": "active", "expiresAt": past}).status_code
        == 422
    )
    assert client.patch("/api/alerts/a1", json={"status": "triggered"}).status_code == 422
    assert client.patch("/api/alerts/nope", json={"status": "active"}).status_code == 404


def test_delete_removes_state_and_keeps_log(client: TestClient) -> None:
    a = create(client, id="a1")
    assert fire(client, a).status_code == 200
    client.put(
        "/api/alerts/states", json={"states": [{"alertId": "a1", "revision": 1, "state": {}}]}
    )
    assert client.delete("/api/alerts/a1").status_code == 204
    assert client.get("/api/alerts/states").json() == []
    entries = client.get("/api/alerts/log").json()["entries"]
    assert (
        len(entries) == 1
        and entries[0]["alertId"] == "a1"
        and entries[0]["alertName"] == "AAPL > 190"
    )


# -------------------------------------------------------------------- fire


def test_fire_records_log_and_counters(client: TestClient) -> None:
    a = create(client, id="a1")
    res = fire(client, a, state={"prev": {"barTime": 1}})
    assert res.status_code == 200
    e = res.json()
    assert e["alertId"] == "a1" and e["message"] == "AAPL Crossing 190.00"
    assert e["read"] is False and e["final"] is False and e["delayed"] is False
    assert e["firedAt"] == "2026-10-15T14:30:00Z" and e["deliveries"] == []
    assert e["values"]["close"] == 190.5 and e["barTime"] == 1_791_000_000

    cur = client.get("/api/alerts/a1").json()
    # Counters never bump the revision, so an open edit dialog does not conflict.
    assert cur["fireCount"] == 1 and cur["revision"] == 1 and cur["status"] == "active"
    assert cur["lastFiredAt"] == "2026-10-15T14:30:00Z"
    assert client.get("/api/alerts/states").json() == [
        {"alertId": "a1", "revision": 1, "state": {"prev": {"barTime": 1}}}
    ]


def test_fire_is_idempotent_per_fire_id(client: TestClient) -> None:
    a = create(client, id="a1")
    first = fire(client, a).json()
    again = fire(client, a, message="ignored")  # same fireId, even with a stale revision
    assert again.status_code == 200 and again.json() == first
    assert client.get("/api/alerts/a1").json()["fireCount"] == 1
    assert count(client, m.AlertLog) == 1
    assert fire(client, a, "f2").status_code == 200
    assert client.get("/api/alerts/a1").json()["fireCount"] == 2


def test_fire_final_triggers_and_bumps_revision(client: TestClient) -> None:
    a = create(client, id="a1", spec=spec_with(trigger="once"))
    res = fire(client, a, final=True, state={"prev": 1})
    assert res.status_code == 200 and res.json()["final"] is True
    cur = client.get("/api/alerts/a1").json()
    assert cur["status"] == "triggered" and cur["revision"] == 2 and cur["fireCount"] == 1
    assert client.get("/api/alerts/states").json() == []  # stale revision: ignored
    # Not active any more: a second fire is a 409.
    assert fire(client, a, "f2").status_code == 409


@pytest.mark.parametrize("why", ["stale", "paused", "expired", "gone"])
def test_fire_conditional_update_conflicts(client: TestClient, why: str) -> None:
    a = create(client, id="a1", expiresAt="2026-10-15T15:00:00Z" if why == "expired" else None)
    if why == "stale":
        client.put("/api/alerts/a1", json=body(name="edited"))
    elif why == "paused":
        client.patch("/api/alerts/a1", json={"status": "paused"})
    elif why == "gone":
        client.delete("/api/alerts/a1")
    kw = {"firedAt": "2026-10-15T15:00:00Z"} if why == "expired" else {}
    res = fire(client, a, **kw)
    assert res.status_code == (404 if why == "gone" else 409), res.text
    if why != "gone":
        assert res.json()["detail"]["current"]["id"] == "a1"
        assert client.get("/api/alerts/a1").json()["fireCount"] == 0
    assert count(client, m.AlertLog) == 0


def test_fire_after_expiry_with_earlier_fired_at_is_accepted(client: TestClient) -> None:
    """A retried fire (firedAt < expiresAt) arriving after expiry is decided by the UPDATE."""
    a = create(client, id="a1", expiresAt=(datetime.now(UTC) + timedelta(hours=1)).isoformat())
    with engine_of(client).begin() as conn:
        conn.execute(
            update(m.Alert)
            .where(m.Alert.id == "a1")
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    long_ago = (datetime.now(UTC) - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    res = fire(client, a, firedAt=long_ago)
    assert res.status_code == 200, res.text
    assert count(client, m.AlertLog) == 1
    # A fire at or after expiry still conflicts, and that conflict sweeps the alert to expired.
    late = fire(client, client.get("/api/alerts/a1").json(), "f2")
    assert late.status_code == 409
    assert late.json()["detail"]["current"]["status"] == "expired"


def test_fire_creates_deliveries_for_enabled_channels(
    make_client: Callable[..., TestClient],
) -> None:
    client = make_client(alerts_webhook_url="http://127.0.0.1:9/hook", alerts_internal_token=None)
    notify = {"webhook": True, "telegram": True, "email": True, "webhookUrl": None}
    a = create(client, id="a1", notify=notify)
    deliveries = fire(client, a).json()["deliveries"]
    by = {d["channel"]: d for d in deliveries}
    assert set(by) == {"webhook", "telegram", "email"}
    assert by["telegram"]["status"] == "failed" and by["telegram"]["lastError"] == "not configured"
    assert by["email"]["status"] == "failed" and by["email"]["attempts"] == 0
    assert by["webhook"]["status"] in ("pending", "failed", "sent")
    # Per-alert URL counts as configured even without a default.
    bare = make_client()
    b = create(bare, id="b1", notify={"webhook": True, "webhookUrl": "http://hook.example:9/x"})
    assert fire(bare, b).json()["deliveries"][0]["status"] in ("pending", "failed")
    c = create(bare, id="c1", notify={"webhook": True})
    got = fire(bare, c, "f9").json()["deliveries"][0]
    assert got["status"] == "failed" and got["lastError"] == "not configured"


def test_fire_race_with_put_is_a_conflict(race_client: TestClient) -> None:
    client = race_client
    a = create(client, id="a1")

    def edit(conn: Connection) -> None:
        conn.execute(
            update(m.Alert).where(m.Alert.id == "a1").values(revision=m.Alert.revision + 1)
        )

    with interleave(client, "UPDATE alerts", edit):
        res = fire(client, a)
    assert res.status_code == 409
    assert count(client, m.AlertLog) == 0
    assert client.get("/api/alerts/a1").json()["fireCount"] == 0


def test_status_endpoint_is_conditional(client: TestClient) -> None:
    a = create(client, id="a1")
    res = client.post(
        "/api/alerts/a1/status",
        json={"revision": 1, "status": "error", "reason": "symbol not found"},
    )
    assert res.status_code == 200
    out = res.json()
    assert out["status"] == "error" and out["statusReason"] == "symbol not found"
    assert out["revision"] == 2
    again = client.post(
        "/api/alerts/a1/status", json={"revision": 2, "status": "expired", "reason": ""}
    )
    assert again.status_code == 409  # no longer active
    client.patch("/api/alerts/a1", json={"status": "active"})
    stale = client.post(
        "/api/alerts/a1/status", json={"revision": 2, "status": "expired", "reason": ""}
    )
    assert stale.status_code == 409
    assert (
        client.post(
            "/api/alerts/nope/status", json={"revision": 1, "status": "error", "reason": ""}
        ).status_code
        == 404
    )
    assert a["id"] == "a1"
    assert (
        client.post(
            "/api/alerts/a1/status", json={"revision": 3, "status": "active", "reason": ""}
        ).status_code
        == 422
    )


def test_lazy_expiry(client: TestClient) -> None:
    create(client, id="a1", expiresAt=(datetime.now(UTC) + timedelta(hours=1)).isoformat())
    create(client, id="a2")
    with engine_of(client).begin() as conn:
        conn.execute(
            update(m.Alert)
            .where(m.Alert.id == "a1")
            .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
    listed = {x["id"]: x for x in client.get("/api/alerts").json()}
    assert listed["a1"]["status"] == "expired" and listed["a1"]["revision"] == 2
    assert listed["a2"]["status"] == "active"
    with engine_of(client).begin() as conn:
        conn.execute(
            update(m.Alert).where(m.Alert.id == "a2").values(expires_at=datetime(2000, 1, 1))
        )
    assert client.get("/api/alerts/a2").json()["status"] == "expired"
    # fire sweeps too
    c = create(client, id="a3")
    with engine_of(client).begin() as conn:
        conn.execute(
            update(m.Alert).where(m.Alert.id == "a3").values(expires_at=datetime(2000, 1, 1))
        )
    assert fire(client, c).status_code == 409


# --------------------------------------------------------------- states


def test_states_put_ignores_stale_rows(client: TestClient) -> None:
    create(client, id="a1")
    create(client, id="a2")
    client.put("/api/alerts/a2", json=body())  # a2 is at revision 2 now
    res = client.put(
        "/api/alerts/states",
        json={
            "states": [
                {"alertId": "a1", "revision": 1, "state": {"n": 1}},
                {"alertId": "a2", "revision": 1, "state": {"n": 2}},
                {"alertId": "ghost", "revision": 1, "state": {}},
            ]
        },
    )
    assert res.status_code == 200
    assert res.json() == {"written": ["a1"], "ignored": ["a2", "ghost"]}
    client.put(
        "/api/alerts/states", json={"states": [{"alertId": "a1", "revision": 1, "state": {"n": 9}}]}
    )
    assert client.get("/api/alerts/states").json() == [
        {"alertId": "a1", "revision": 1, "state": {"n": 9}}
    ]


def test_states_limits(client: TestClient) -> None:
    big = {"x": "y" * 17_000}
    res = client.put(
        "/api/alerts/states", json={"states": [{"alertId": "a", "revision": 1, "state": big}]}
    )
    assert res.status_code == 422
    many = [{"alertId": f"a{i}", "revision": 1, "state": {}} for i in range(1001)]
    assert client.put("/api/alerts/states", json={"states": many}).status_code == 422


# ------------------------------------------------------------------- log


def test_log_paging_read_and_clear(client: TestClient) -> None:
    a = create(client, id="a1")
    b = create(client, id="b1", symbol="MSFT")
    for i in range(5):
        assert fire(client, a, f"fa{i}").status_code == 200
    assert fire(client, b, "fb0").status_code == 200

    page = client.get("/api/alerts/log?limit=4").json()
    ids = [e["id"] for e in page["entries"]]
    assert ids == sorted(ids, reverse=True) and len(ids) == 4
    assert page["hasMore"] is True and page["unread"] == 6
    older = client.get(f"/api/alerts/log?limit=4&before={ids[-1]}").json()
    assert [e["id"] for e in older["entries"]] == [2, 1] and older["hasMore"] is False
    newer = client.get(f"/api/alerts/log?after={ids[-1]}").json()
    assert [e["id"] for e in newer["entries"]] == ids[:-1]
    assert [e["symbol"] for e in client.get("/api/alerts/log?symbol=MSFT").json()["entries"]] == [
        "MSFT"
    ]
    only_a = client.get("/api/alerts/log?alertId=a1").json()
    assert len(only_a["entries"]) == 5
    assert client.get("/api/alerts/log?limit=501").status_code == 422
    assert client.get("/api/alerts/log?limit=0").status_code == 422

    assert client.post("/api/alerts/log/read", json={}).status_code == 422
    assert client.post("/api/alerts/log/read", json={"upTo": 2}).json() == {"unread": 4}
    assert client.post("/api/alerts/log/read", json={"ids": [6]}).json() == {"unread": 3}
    assert client.get("/api/alerts/log").json()["unread"] == 3
    flags = {e["id"]: e["read"] for e in client.get("/api/alerts/log").json()["entries"]}
    assert flags == {6: True, 5: False, 4: False, 3: False, 2: True, 1: True}

    assert client.delete("/api/alerts/log?alertId=a1").status_code == 204
    left = client.get("/api/alerts/log").json()["entries"]
    assert [e["symbol"] for e in left] == ["MSFT"]
    assert client.delete("/api/alerts/log").status_code == 204
    assert client.get("/api/alerts/log").json() == {"entries": [], "hasMore": False, "unread": 0}


def test_log_retention_prunes_oldest(make_client: Callable[..., TestClient]) -> None:
    client = make_client(alerts_log_max=3)
    a = create(client, id="a1", notify={"webhook": True})  # failed delivery rows go with the entry
    for i in range(6):
        assert fire(client, a, f"f{i}").status_code == 200
    entries = client.get("/api/alerts/log").json()["entries"]
    assert [e["id"] for e in entries] == [6, 5, 4]
    assert count(client, m.AlertDelivery) == 3


# ---------------------------------------------------------- service token


def test_internal_token_guards_service_routes(make_client: Callable[..., TestClient]) -> None:
    client = make_client(alerts_internal_token="s3cret")
    a = create(client, id="a1")
    hdr = {"X-Alerts-Token": "s3cret"}
    hb = {
        "version": "1",
        "startedAt": "2026-10-15T00:00:00Z",
        "series": 1,
        "liveSymbols": 1,
        "polledSeries": 0,
    }
    st = {"states": [{"alertId": "a1", "revision": 1, "state": {}}]}
    calls = [
        ("post", "/api/alerts/a1/fire", fire_body(a)),
        ("post", "/api/alerts/a1/status", {"revision": 1, "status": "error", "reason": "x"}),
        ("put", "/api/alerts/states", st),
        ("post", "/api/alerts/service/heartbeat", hb),
    ]
    for method, url, payload in calls:
        assert getattr(client, method)(url, json=payload).status_code == 401, url
        bad = getattr(client, method)(url, json=payload, headers={"X-Alerts-Token": "nope"})
        assert bad.status_code == 401, url
    for method, url, payload in calls:
        res = getattr(client, method)(url, json=payload, headers=hdr)
        assert res.status_code in (200, 204), (url, res.text)
    # Web routes stay open.
    assert client.get("/api/alerts").status_code == 200
    assert client.get("/api/alerts/service").status_code == 200


def test_service_heartbeat_and_online(client: TestClient) -> None:
    assert client.get("/api/alerts/service").json() == {"online": False}
    hb = {
        "version": "1.2.3",
        "startedAt": "2026-10-15T00:00:00Z",
        "series": 4,
        "liveSymbols": 3,
        "polledSeries": 1,
        "lastError": None,
    }
    assert client.post("/api/alerts/service/heartbeat", json=hb).status_code == 204
    got = client.get("/api/alerts/service").json()
    assert got["online"] is True and got["series"] == 4 and got["version"] == "1.2.3"
    assert got["lastHeartbeatAt"].endswith("Z")
    state = client.app.state.alerts_service  # type: ignore[attr-defined]
    state.last_at = datetime.now(UTC) - timedelta(seconds=91)
    assert client.get("/api/alerts/service").json()["online"] is False


# -------------------------------------------------------------- channels


def test_channels_masked(make_client: Callable[..., TestClient]) -> None:
    assert make_client().get("/api/alerts/channels").json() == {
        "webhook": {"configured": False, "url": None},
        "telegram": {"configured": False},
        "email": {"configured": False, "to": None},
    }
    client = make_client(
        alerts_webhook_url="https://hooks.example.com/services/T000/B000/SECRET",
        telegram_bot_token="123:abc",
        telegram_chat_id="42",
        smtp_host="smtp.example.com",
        smtp_from="a@example.com",
        smtp_to="me@example.com, you@example.org",
    )
    got = client.get("/api/alerts/channels").json()
    assert got["webhook"] == {"configured": True, "url": "https://hooks.example.com/…"}
    assert got["telegram"] == {"configured": True}
    assert got["email"] == {"configured": True, "to": "m***@example.com, y***@example.org"}
    assert "SECRET" not in json.dumps(got) and "123:abc" not in json.dumps(got)


def test_channel_test_requires_configuration(client: TestClient) -> None:
    for ch in ("webhook", "telegram", "email"):
        assert client.post(f"/api/alerts/channels/{ch}/test", json={}).status_code == 400
    assert client.post("/api/alerts/channels/sms/test", json={}).status_code == 422


# ------------------------------------------------------------ import/export


def test_bundle_export_import_alerts(client: TestClient) -> None:
    a = create(client, id="a1", message="hello")
    fire(client, a)
    client.patch("/api/alerts/a1", json={"status": "paused"})
    with engine_of(client).begin() as conn:
        conn.execute(update(m.Alert).values(status="error", status_reason="drawing not found"))
    bundle = client.get("/api/export").json()
    assert len(bundle["alerts"]) == 1
    exported = bundle["alerts"][0]
    assert exported["id"] == "a1" and exported["status"] == "error" and exported["fireCount"] == 1
    assert exported["statusReason"] == "drawing not found" and "state" not in exported

    # Absent key: replace leaves alerts alone.
    res = client.post(
        "/api/import?mode=replace&confirm=true", json={"version": 1, "app": "investopen"}
    )
    assert res.status_code == 200 and res.json()["alerts"] == {
        "created": 0,
        "updated": 0,
        "deleted": 0,
    }
    assert len(client.get("/api/alerts").json()) == 1

    # Merge matches by id, keeps the imported status and bumps the revision.
    client.put(
        "/api/alerts/states", json={"states": [{"alertId": "a1", "revision": 2, "state": {}}]}
    )
    exported["name"] = "renamed"
    exported["status"] = "triggered"
    merge = client.post(
        "/api/import", json={**bundle, "alerts": [exported, {**exported, "id": "a2"}]}
    )
    assert merge.status_code == 200, merge.text
    assert merge.json()["alerts"] == {"created": 1, "updated": 1, "deleted": 0}
    got = {x["id"]: x for x in client.get("/api/alerts").json()}
    assert got["a1"]["name"] == "renamed" and got["a1"]["status"] == "triggered"
    assert got["a1"]["revision"] == 3 and got["a1"]["fireCount"] == 1
    assert got["a2"]["revision"] == 1
    assert client.get("/api/alerts/states").json() == []

    # Replace with the key present empties alerts and states.
    client.put(
        "/api/alerts/states", json={"states": [{"alertId": "a2", "revision": 1, "state": {}}]}
    )
    res = client.post(
        "/api/import?mode=replace&confirm=true",
        json={"version": 1, "app": "investopen", "alerts": []},
    )
    assert res.json()["alerts"]["deleted"] == 2
    assert client.get("/api/alerts").json() == []
    assert client.get("/api/alerts/states").json() == []
    assert len(client.get("/api/alerts/log").json()["entries"]) == 1  # log is untouched


def test_bundle_rejects_invalid_alert_and_duplicates(client: TestClient) -> None:
    good = json.loads((FIXTURES / "valid" / "price-crossing-value.json").read_text())
    bad = json.loads((FIXTURES / "invalid" / "bars-zero.json").read_text())
    base = {"version": 1, "app": "investopen"}
    assert (
        client.post("/api/import", json={**base, "alerts": [{**bad, "id": "x"}]}).status_code == 422
    )
    dup = client.post(
        "/api/import", json={**base, "alerts": [{**good, "id": "x"}, {**good, "id": "x"}]}
    )
    assert dup.status_code == 422
    # Reserved ids are replaced, not imported.
    ok = client.post("/api/import", json={**base, "alerts": [{**good, "id": "states"}]})
    assert ok.status_code == 200
    [only] = client.get("/api/alerts").json()
    assert only["id"] != "states"


# --------------------------------------------------------------------- /ws


def recv_type(ws: Any, kind: str, limit: int = 10) -> dict[str, Any]:
    for _ in range(limit):
        frame: dict[str, Any] = ws.receive_json()
        if frame["type"] == kind:
            return frame
    raise AssertionError(f"no {kind!r} frame")


def test_ws_events_topics_and_alert_frames(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "events", "topics": ["alerts"]})
        assert ws.receive_json() == {"type": "events", "topics": ["alerts"]}

        ws.send_json({"op": "events", "topics": ["alerts", "bogus"]})
        assert ws.receive_json() == {"type": "error", "message": "unknown topic 'bogus'"}
        ws.send_json({"op": "events", "topics": "alerts"})
        assert "list of strings" in ws.receive_json()["message"]

        a = create(client, id="a1")  # topics unchanged by the rejected frames
        changed = recv_type(ws, "alerts.changed")
        assert changed == {
            "type": "alerts.changed",
            "topic": "alerts",
            "ids": ["a1"],
            "deleted": [],
        }

        fire(client, a, final=True)
        fired = recv_type(ws, "alert.fired")
        assert fired["topic"] == "alerts" and fired["entry"]["alertId"] == "a1"
        assert fired["alert"] == {
            "id": "a1",
            "status": "triggered",
            "revision": 2,
            "fireCount": 1,
            "lastFiredAt": "2026-10-15T14:30:00Z",
        }
        assert recv_type(ws, "alerts.changed")["ids"] == ["a1"]  # final fire

        client.post("/api/alerts/log/read", json={"upTo": 1})
        assert recv_type(ws, "alerts.log") == {
            "type": "alerts.log",
            "topic": "alerts",
            "readUpTo": 1,
        }
        client.delete("/api/alerts/log")
        assert recv_type(ws, "alerts.log")["cleared"] is True

        client.delete("/api/alerts/a1")
        assert recv_type(ws, "alerts.changed")["deleted"] == ["a1"]

        # Not subscribed to `drawings`: nothing is delivered for it.
        save_drawing(client, "d1")
        ws.send_json({"op": "events", "topics": []})
        assert ws.receive_json() == {"type": "events", "topics": []}
        ws.send_json({"op": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_ws_drawings_changed_after_batch_and_import(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "events", "topics": ["drawings", "alerts"]})
        assert ws.receive_json()["topics"] == ["alerts", "drawings"]
        save_drawing(client, "d1")
        assert recv_type(ws, "drawings.changed") == {
            "type": "drawings.changed",
            "topic": "drawings",
            "ids": ["d1"],
            "deleted": [],
        }
        res = client.post(
            "/api/drawings/batch",
            json={"upserts": [{"drawing": drawing("d2")}], "deletes": [{"id": "d1"}]},
        )
        assert res.status_code == 200
        frame = recv_type(ws, "drawings.changed")
        assert frame["ids"] == ["d2"] and frame["deleted"] == ["d1"]

        good = json.loads((FIXTURES / "valid" / "price-crossing-value.json").read_text())
        client.post(
            "/api/import",
            json={"version": 1, "app": "investopen", "alerts": [{**good, "id": "imp"}]},
        )
        assert recv_type(ws, "alerts.changed")["ids"] == ["imp"]


def test_event_subscribers_keep_upstream_idle(client: TestClient) -> None:
    with client.websocket_connect("/ws") as ws:
        ws.send_json({"op": "events", "topics": ["alerts", "drawings"]})
        ws.receive_json()
        hub = client.app.state.live_hub  # type: ignore[attr-defined]
        assert hub._refs == {} and hub._tasks == []


# --------------------------------------------------------------- migration


def test_alert_tables_in_migration(tmp_path: Path) -> None:
    from alembic import command
    from test_userdata import alembic_config

    url = f"sqlite:///{tmp_path}/m.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, "head")
    names = {"alerts", "alert_states", "alert_log", "alert_deliveries"}
    assert set(inspect(engine).get_table_names()) >= names
    uniques = inspect(engine).get_unique_constraints("alert_log")
    assert any(u["column_names"] == ["fire_id"] for u in uniques)
    fks = inspect(engine).get_foreign_keys("alert_deliveries")
    assert fks[0]["options"].get("ondelete") == "CASCADE"
    assert not inspect(engine).get_foreign_keys("alert_log")  # the log outlives the alert
    command.downgrade(cfg, "50fc9b162b6f")
    assert not set(inspect(engine).get_table_names()) & names
    engine.dispose()
