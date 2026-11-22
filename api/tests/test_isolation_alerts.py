"""Multi-user isolation of alerts, saved screens and the screener's custom lists
(docs/design/multi-user.md): two users through the HTTP API, the alerts service through its
token, and `/ws`. Alice owns the data; Bob must never see, change or delete it, and nothing but
"id in use" tells him an id is taken."""

from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

from fastapi.testclient import TestClient
from multiuser import Multi, system_session
from sqlalchemy import func, select
from test_alerts import body as alert_body
from test_alerts import drawing_spec, fire_body
from test_screens import ALERT as SCREEN_ALERT
from test_screens import SPEC as SCREEN_SPEC
from test_userdata import drawing, engine_of

from tickerglass_api import models as m

SVC = {"X-Alerts-Token": "svc-token-0123456789abcdef0123456789abcdef"}
IN_USE = {"detail": "id in use"}


def make_alert(client: TestClient, aid: str, **kw: Any) -> dict[str, Any]:
    res = client.post("/api/alerts", json=alert_body(id=aid, **kw))
    assert res.status_code == 201, res.text
    out: dict[str, Any] = res.json()
    return out


def service(multi: Multi) -> TestClient:
    """The alerts service: no cookie, the token on every call."""
    return multi.new_client()


def drain(ws: Any) -> list[dict[str, Any]]:
    """Frames queued for this socket so far (a ping marks the end)."""
    ws.send_json({"op": "ping"})
    out: list[dict[str, Any]] = []
    while True:
        frame = ws.receive_json()
        if frame.get("type") == "pong":
            return out
        out.append(frame)


# ------------------------------------------------------------------- alerts


def test_alerts_are_private_across_every_route(multi: Multi) -> None:
    a = make_alert(multi.alice, "a1")
    assert a["ownerId"] == multi.ids["alice"]
    bob = multi.bob
    assert bob.get("/api/alerts").json() == []
    url = "/api/alerts/a1"
    assert bob.get(url).status_code == 404
    assert bob.put(url, json=alert_body(name="x", revision=1)).status_code == 404
    assert bob.patch(url, json={"status": "paused"}).status_code == 404
    assert bob.delete(url).status_code == 404
    # Nothing changed for Alice.
    cur = multi.alice.get(url).json()
    assert cur["name"] == a["name"] and cur["status"] == "active" and cur["revision"] == 1
    assert [x["id"] for x in multi.alice.get("/api/alerts").json()] == ["a1"]
    # Alice deletes hers; Bob's own alerts are unaffected by either.
    b = make_alert(bob, "b1")
    assert multi.alice.delete("/api/alerts/b1").status_code == 404
    assert multi.alice.delete(url).status_code == 204
    assert [x["id"] for x in bob.get("/api/alerts").json()] == [b["id"]]


def test_alert_log_and_deliveries_are_private(multi: Multi) -> None:
    notify = {"webhook": True}  # not configured on this server: a failed delivery row
    a = make_alert(multi.alice, "a1", notify=notify)
    b = make_alert(multi.bob, "b1")
    svc = service(multi)
    res = svc.post("/api/alerts/a1/fire", json=fire_body(a, "fa"), headers=SVC)
    assert res.status_code == 200, res.text
    assert [d["channel"] for d in res.json()["deliveries"]] == ["webhook"]
    assert svc.post("/api/alerts/b1/fire", json=fire_body(b, "fb"), headers=SVC).status_code == 200

    mine = multi.alice.get("/api/alerts/log").json()
    assert [e["alertId"] for e in mine["entries"]] == ["a1"] and mine["unread"] == 1
    assert [d["channel"] for d in mine["entries"][0]["deliveries"]] == ["webhook"]
    theirs = multi.bob.get("/api/alerts/log").json()
    assert [e["alertId"] for e in theirs["entries"]] == ["b1"] and theirs["unread"] == 1
    # Filters cannot reach across: Bob asking for Alice's alert gets nothing.
    assert multi.bob.get("/api/alerts/log", params={"alertId": "a1"}).json()["entries"] == []
    assert (
        multi.bob.get("/api/alerts/log", params={"symbol": "AAPL"}).json()["entries"][0]["alertId"]
        == "b1"
    )

    # Bob marking everything read or clearing the log leaves Alice's entries alone.
    top = max(e["id"] for e in mine["entries"] + theirs["entries"])
    assert multi.bob.post("/api/alerts/log/read", json={"upTo": top}).json() == {"unread": 0}
    assert multi.alice.get("/api/alerts/log").json()["unread"] == 1
    assert multi.bob.delete("/api/alerts/log", params={"alertId": "a1"}).status_code == 204
    assert multi.bob.delete("/api/alerts/log").status_code == 204
    kept = multi.alice.get("/api/alerts/log").json()["entries"]
    assert len(kept) == 1 and kept[0]["deliveries"][0]["channel"] == "webhook"
    assert multi.bob.get("/api/alerts/log").json()["entries"] == []
    with engine_of(multi.root).connect() as conn:
        assert conn.execute(select(func.count()).select_from(m.AlertDelivery)).scalar_one() == 1


def test_service_token_sees_every_owner_with_owner_ids(multi: Multi) -> None:
    make_alert(multi.alice, "a1")
    make_alert(multi.bob, "b1")
    svc = service(multi)
    listed = svc.get("/api/alerts", headers=SVC).json()
    assert {x["id"]: x["ownerId"] for x in listed} == {
        "a1": multi.ids["alice"],
        "b1": multi.ids["bob"],
    }
    assert svc.get("/api/alerts/b1", headers=SVC).json()["ownerId"] == multi.ids["bob"]
    put = svc.put(
        "/api/alerts/states",
        json={
            "states": [
                {"alertId": "a1", "revision": 1, "state": {"n": 1}},
                {"alertId": "b1", "revision": 1, "state": {"n": 2}},
                {"alertId": "ghost", "revision": 1, "state": {}},
            ]
        },
        headers=SVC,
    )
    assert put.json() == {"written": ["a1", "b1"], "ignored": ["ghost"]}
    states = {x["alertId"]: x["ownerId"] for x in svc.get("/api/alerts/states", headers=SVC).json()}
    assert states == {"a1": multi.ids["alice"], "b1": multi.ids["bob"]}
    # Each user reads only the state of their own alerts.
    assert [x["alertId"] for x in multi.alice.get("/api/alerts/states").json()] == ["a1"]
    assert [x["alertId"] for x in multi.bob.get("/api/alerts/states").json()] == ["b1"]
    # A status write lands on the alert's owner.
    res = svc.post(
        "/api/alerts/b1/status",
        json={"revision": 1, "status": "error", "reason": "boom"},
        headers=SVC,
    )
    assert res.status_code == 200 and res.json()["ownerId"] == multi.ids["bob"]
    assert multi.bob.get("/api/alerts/b1").json()["status"] == "error"
    assert multi.alice.get("/api/alerts/a1").json()["status"] == "active"


def test_service_routes_are_not_for_users(multi: Multi) -> None:
    a = make_alert(multi.alice, "a1")
    # The token is configured: a user's cookie alone is not the service.
    assert multi.alice.post("/api/alerts/a1/fire", json=fire_body(a)).status_code == 401
    assert multi.bob.post("/api/alerts/a1/fire", json=fire_body(a)).status_code == 401
    st = {"states": [{"alertId": "a1", "revision": 1, "state": {}}]}
    assert multi.bob.put("/api/alerts/states", json=st).status_code == 401
    status = {"revision": 1, "status": "error", "reason": "x"}
    assert multi.bob.post("/api/alerts/a1/status", json=status).status_code == 401
    # Even with the token, a user's cookie keeps the user's identity: no escalation.
    res = multi.bob.post("/api/alerts/a1/fire", json=fire_body(a), headers=SVC)
    assert res.status_code == 403
    assert multi.alice.get("/api/alerts/a1").json()["fireCount"] == 0


def _service_calls(a: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    return [
        ("post", "/api/alerts/a1/fire", fire_body(a)),
        ("post", "/api/alerts/a1/status", {"revision": 1, "status": "error", "reason": "x"}),
        ("put", "/api/alerts/states", {"states": [{"alertId": "a1", "revision": 1, "state": {}}]}),
        (
            "post",
            "/api/alerts/service/heartbeat",
            {
                "version": "1",
                "startedAt": "2026-10-15T00:00:00Z",
                "series": 1,
                "liveSymbols": 0,
                "polledSeries": 0,
            },
        ),
    ]


def test_an_admin_cookie_is_not_the_service_without_a_token(multi_no_token: Multi) -> None:
    """With auth on and no ALERTS_INTERNAL_TOKEN, nobody is `SYSTEM`: an admin cannot fire,
    expire or write the state of another user's alert (or trigger its webhooks)."""
    multi = multi_no_token
    a = make_alert(multi.alice, "a1")
    for method, url, payload in _service_calls(a):
        for who in (multi.owner, multi.alice):  # the owner is an admin
            assert getattr(who, method)(url, json=payload).status_code == 403, url
        # A guessed header changes nothing: no token is configured.
        res = getattr(multi.new_client(), method)(url, json=payload, headers=SVC)
        assert res.status_code == 401, url
    after = multi.alice.get("/api/alerts/a1").json()
    assert after["fireCount"] == 0 and after["status"] == "active"
    assert multi.alice.get("/api/alerts/log").json()["entries"] == []


def test_an_admin_cookie_is_refused_on_service_routes_with_a_token(multi: Multi) -> None:
    a = make_alert(multi.alice, "a1")
    for method, url, payload in _service_calls(a):
        # Cookie and the right header: the cookie names the user, who is no service.
        res = getattr(multi.owner, method)(url, json=payload, headers=SVC)
        assert res.status_code == 403, url
        assert getattr(multi.owner, method)(url, json=payload).status_code in (401, 403), url
    # The token alone is the service.
    for method, url, payload in _service_calls(a):
        res = getattr(multi.new_client(), method)(url, json=payload, headers=SVC)
        assert res.status_code in (200, 204), (url, res.text)


def test_open_mode_service_needs_no_token(make_client: Callable[..., TestClient]) -> None:
    client = make_client()  # no auth, no token: one user, the Node service sends no header
    a = make_alert(client, "a1")
    for method, url, payload in _service_calls(a):
        res = getattr(client, method)(url, json=payload)
        assert res.status_code in (200, 204), (url, res.text)


def test_a_fire_id_never_returns_another_alerts_entry(multi: Multi) -> None:
    a = make_alert(multi.alice, "a1")
    b = make_alert(multi.bob, "b1")
    svc = service(multi)
    assert (
        svc.post("/api/alerts/a1/fire", json=fire_body(a, "same"), headers=SVC).status_code == 200
    )
    res = svc.post("/api/alerts/b1/fire", json=fire_body(b, "same"), headers=SVC)
    assert res.status_code == 409 and res.json() == {"detail": "fireId in use"}
    assert multi.bob.get("/api/alerts/log").json()["entries"] == []


def test_alert_id_collision_is_409_without_leaking(multi: Multi) -> None:
    make_alert(multi.alice, "a1", name="Alice secret")
    res = multi.bob.post("/api/alerts", json=alert_body(id="a1", name="Bob"))
    assert res.status_code == 409 and res.json() == IN_USE
    # Not found for Bob on every other route, and Alice's alert is untouched.
    assert multi.bob.get("/api/alerts/a1").status_code == 404
    assert multi.alice.get("/api/alerts/a1").json()["name"] == "Alice secret"
    # Her own duplicate keeps the old answer: 409 carrying the stored alert.
    own = multi.alice.post("/api/alerts", json=alert_body(id="a1"))
    assert own.status_code == 409 and own.json()["detail"]["current"]["id"] == "a1"
    # A concurrent claim is the same 409 (the insert, not the pre-check, lost the race).
    assert multi.bob.post("/api/alerts", json=alert_body(id="a1")).json() == IN_USE


def test_alert_cannot_use_another_users_drawing(multi: Multi) -> None:
    res = multi.alice.post(
        "/api/drawings/batch", json={"upserts": [{"drawing": drawing("d1", symbol="AAPL")}]}
    )
    assert res.status_code == 200, res.text
    ok = multi.alice.post("/api/alerts", json=alert_body(id="ad", spec=drawing_spec("d1")))
    assert ok.status_code == 201, ok.text
    bad = multi.bob.post("/api/alerts", json=alert_body(id="bd", spec=drawing_spec("d1")))
    assert bad.status_code == 422 and "not saved" in bad.json()["detail"]


def test_channel_test_is_admin_only_but_channels_are_readable(multi: Multi) -> None:
    for client in (multi.alice, multi.bob):
        assert client.post("/api/alerts/channels/webhook/test").status_code == 403
        assert client.post("/api/alerts/channels/email/test", json={}).status_code == 403
        got = client.get("/api/alerts/channels")
        assert got.status_code == 200 and got.json()["webhook"]["configured"] is False
    # The admin reaches the handler (nothing configured here: a 400, not a 403).
    assert multi.owner.post("/api/alerts/channels/webhook/test").status_code == 400


def test_service_heartbeat_hides_other_users_waiting_alerts(multi: Multi) -> None:
    make_alert(multi.alice, "a1")
    make_alert(multi.bob, "b1")
    hb = {
        "version": "1",
        "startedAt": "2026-10-15T00:00:00Z",
        "series": 2,
        "liveSymbols": 1,
        "polledSeries": 0,
        "lastError": "alert a1 broke",
        "waiting": [
            {"alertId": "a1", "reason": "script", "resumeAt": "2026-10-15T00:06:00Z"},
            {"alertId": "b1", "reason": "script", "resumeAt": "2026-10-15T00:06:00Z"},
        ],
    }
    assert (
        service(multi).post("/api/alerts/service/heartbeat", json=hb, headers=SVC).status_code
        == 204
    )
    got = multi.alice.get("/api/alerts/service").json()
    assert [w["alertId"] for w in got["waiting"]] == ["a1"] and got["lastError"] is None
    assert [w["alertId"] for w in multi.bob.get("/api/alerts/service").json()["waiting"]] == ["b1"]
    admin = multi.owner.get("/api/alerts/service").json()
    assert admin["lastError"] == "alert a1 broke"


def test_ws_alert_events_reach_only_the_owner_and_the_service(multi: Multi) -> None:
    a = make_alert(multi.alice, "a1")
    b = make_alert(multi.bob, "b1")
    root = multi.root
    with (
        root.websocket_connect("/ws", headers=multi.cookie_header(multi.alice)) as wa,
        root.websocket_connect("/ws", headers=multi.cookie_header(multi.bob)) as wb,
        root.websocket_connect("/ws?auth_token=svc-token-0123456789abcdef0123456789abcdef") as wsvc,
    ):
        for ws in (wa, wb, wsvc):
            ws.send_json({"op": "events", "topics": ["alerts"]})
        drain(wa), drain(wb), drain(wsvc)
        svc = service(multi)
        ok = svc.post("/api/alerts/b1/fire", json=fire_body(b, "fb", final=True), headers=SVC)
        assert ok.status_code == 200
        got_b = drain(wb)
        assert [f["type"] for f in got_b] == ["alert.fired", "alerts.changed"]
        assert got_b[0]["entry"]["alertId"] == "b1" and got_b[0]["alert"]["id"] == "b1"
        assert drain(wa) == []
        assert [f["type"] for f in drain(wsvc)] == ["alert.fired", "alerts.changed"]

        assert (
            svc.post("/api/alerts/a1/fire", json=fire_body(a, "fa"), headers=SVC).status_code == 200
        )
        assert [f["type"] for f in drain(wa)] == ["alert.fired"]
        assert drain(wb) == []
        # Log reads and clears are announced to their owner only.
        assert multi.bob.post("/api/alerts/log/read", json={"upTo": 10_000}).status_code == 200
        assert [f["type"] for f in drain(wb)] == ["alerts.log"]
        assert multi.alice.delete("/api/alerts/a1").status_code == 204
        assert [f["type"] for f in drain(wa)] == ["alerts.changed"]
        assert drain(wb) == []


# ------------------------------------------------------------------ screens


def make_screen(client: TestClient, sid: str, **kw: Any) -> dict[str, Any]:
    res = client.post(
        "/api/screener/screens", json={"id": sid, "name": "S", "spec": SCREEN_SPEC, **kw}
    )
    assert res.status_code == 201, res.text
    out: dict[str, Any] = res.json()
    return out


def test_screens_are_private_across_every_route(multi: Multi) -> None:
    make_screen(multi.alice, "s1", name="Alice screen", alert=SCREEN_ALERT)
    bob = multi.bob
    assert bob.get("/api/screener/screens").json() == []
    url = "/api/screener/screens/s1"
    assert bob.get(url).status_code == 404
    assert bob.put(url, json={"name": "x", "spec": SCREEN_SPEC}).status_code == 404
    assert bob.patch(url, json={"name": "x"}).status_code == 404
    assert bob.delete(url).status_code == 404
    cur = multi.alice.get(url).json()
    assert cur["name"] == "Alice screen" and cur["revision"] == 1
    # Her screen's state (a child row) stays with it when Bob's same-named calls fail.
    assert [x["id"] for x in multi.alice.get("/api/screener/screens").json()] == ["s1"]
    assert multi.alice.delete(url).status_code == 204


def test_screen_id_collision_is_409_without_leaking(multi: Multi) -> None:
    make_screen(multi.alice, "s1", name="Alice screen")
    res = multi.bob.post(
        "/api/screener/screens", json={"id": "s1", "name": "B", "spec": SCREEN_SPEC}
    )
    assert res.status_code == 409 and res.json() == IN_USE
    assert multi.bob.get("/api/screener/screens/s1").status_code == 404
    own = multi.alice.post(
        "/api/screener/screens", json={"id": "s1", "name": "A", "spec": SCREEN_SPEC}
    )
    assert own.status_code == 409 and own.json()["detail"]["current"]["name"] == "Alice screen"


def test_screen_state_is_reached_only_through_its_owned_screen(multi: Multi) -> None:
    make_screen(multi.alice, "s1", alert=SCREEN_ALERT)
    with system_session(engine_of(multi.root)) as session:
        state = m.ScreenState(
            screen_id="s1",
            as_of=date(2026, 1, 1),
            members={"members": ["AAPL"], "seen": []},
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        )
        session.add(state)
        session.commit()
    # Bob "deleting" it is a 404 and leaves the state; Alice's delete removes it with the screen.
    assert multi.bob.delete("/api/screener/screens/s1").status_code == 404
    with engine_of(multi.root).connect() as conn:
        assert conn.execute(select(func.count()).select_from(m.ScreenState)).scalar_one() == 1
    assert multi.alice.delete("/api/screener/screens/s1").status_code == 204
    with engine_of(multi.root).connect() as conn:
        assert conn.execute(select(func.count()).select_from(m.ScreenState)).scalar_one() == 0


# ------------------------------------------------------------ custom lists

LISTS = "/api/screener/lists"


def put_list(client: TestClient, lid: str, symbols: list[str], name: str = "Mine") -> Any:
    return client.put(f"{LISTS}/{lid}", json={"name": name, "asOf": "2026-11", "symbols": symbols})


def list_ids(client: TestClient) -> set[str]:
    return {x["id"] for x in client.get(LISTS).json()}


def scan_list(client: TestClient, lid: str) -> Any:
    body = {"universe": {"kind": "list", "id": lid}, "filter": None}
    return client.post("/api/screener/scan", json=body)


def test_custom_lists_are_private(multi: Multi) -> None:
    assert put_list(multi.alice, "mine", ["AAPL", "MSFT"], "Alice list").status_code == 200
    assert "mine" in list_ids(multi.alice) and "mine" not in list_ids(multi.bob)
    # The bundled (shared) lists are everyone's.
    assert {"sp500", "ndx100"} <= list_ids(multi.bob)
    # Bob cannot scan, delete or overwrite it; he is told only that the id is taken.
    assert scan_list(multi.bob, "mine").status_code == 404
    assert multi.bob.delete(f"{LISTS}/mine").status_code == 404
    res = put_list(multi.bob, "mine", ["TSLA"], "Bob list")
    assert res.status_code == 409 and res.json() == IN_USE
    # Nothing of Alice's list changed: name and members.
    mine = {x["id"]: x for x in multi.alice.get(LISTS).json()}["mine"]
    assert mine["name"] == "Alice list" and mine["count"] == 2
    assert [r["symbol"] for r in scan_list(multi.alice, "mine").json()["rows"]] == ["AAPL", "MSFT"]
    # Bob's own list under another id never shows up for Alice.
    assert put_list(multi.bob, "bobs", ["NVDA"]).status_code == 200
    assert "bobs" not in list_ids(multi.alice)
    assert scan_list(multi.alice, "bobs").status_code == 404
    assert multi.alice.delete(f"{LISTS}/bobs").status_code == 404
    assert multi.bob.delete(f"{LISTS}/bobs").json() == {"status": "removed"}
    with engine_of(multi.root).connect() as conn:
        members = conn.execute(
            select(m.ScreenerListMember.list_id, m.ScreenerListMember.symbol)
            .where(m.ScreenerListMember.list_id == "mine")
            .order_by(m.ScreenerListMember.symbol)
        ).all()
    assert [tuple(r) for r in members] == [("mine", "AAPL"), ("mine", "MSFT")]


def test_scan_etag_does_not_cross_users_lists(multi: Multi) -> None:
    assert put_list(multi.alice, "mine", ["AAPL"]).status_code == 200
    mine = scan_list(multi.alice, "mine")
    assert mine.status_code == 200
    again = multi.bob.post(
        "/api/screener/scan",
        json={"universe": {"kind": "list", "id": "mine"}, "filter": None},
        headers={"If-None-Match": mine.headers["ETag"]},
    )
    assert again.status_code == 404


def test_shared_lists_are_written_by_admins_only(multi: Multi) -> None:
    for client in (multi.alice, multi.bob):
        assert put_list(client, "sp500", ["AAPL"]).status_code == 403
        assert client.delete(f"{LISTS}/sp500").status_code == 403
    sp = {x["id"]: x for x in multi.alice.get(LISTS).json()}["sp500"]
    assert sp["source"] == "bundled"
    # The admin's override of a shared list is seen by everyone; reverting too.
    assert put_list(multi.owner, "sp500", ["AAPL"], "Owner S&P").status_code == 200
    seen = {x["id"]: x for x in multi.bob.get(LISTS).json()}["sp500"]
    assert seen["source"] == "upload" and seen["count"] == 1
    assert scan_list(multi.bob, "sp500").status_code == 200
    assert multi.bob.delete(f"{LISTS}/sp500").status_code == 403
    assert multi.owner.delete(f"{LISTS}/sp500").json() == {"status": "reverted"}
    with engine_of(multi.root).connect() as conn:
        owners = set(conn.execute(select(m.ScreenerList.owner_id)).scalars())
    assert owners == {None}


def test_admin_cannot_clobber_a_users_list_through_the_shared_path(multi: Multi) -> None:
    assert put_list(multi.alice, "mine", ["AAPL"], "Alice list").status_code == 200
    # An admin writing the same id writes the admin's own list: taken, so 409, nothing changed.
    res = put_list(multi.owner, "mine", ["TSLA"], "Owner list")
    assert res.status_code == 409 and res.json() == IN_USE
    assert multi.owner.delete(f"{LISTS}/mine").status_code == 404
    assert {x["id"]: x for x in multi.alice.get(LISTS).json()}["mine"]["name"] == "Alice list"
