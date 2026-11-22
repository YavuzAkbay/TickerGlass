"""Multi-user isolation of the user-data routes (docs/design/multi-user.md): two users, every
resource, through the HTTP API. Alice owns the data, Bob must never see, change or delete it,
and nothing but "id in use" tells him an id is taken."""

import base64
from typing import Any

from fastapi.testclient import TestClient
from multiuser import Multi
from test_alerts import drawing_spec
from test_portfolio import PNG, buy, mk_note, mk_portfolio, post_tx
from test_userdata import STATE, drawing, engine_of

SVC = {"X-Alerts-Token": "svc-token-0123456789abcdef0123456789abcdef"}


def batch(client: TestClient, *drawings: dict[str, Any], **kw: Any) -> Any:
    body = {"upserts": [{"drawing": d, "baseRevision": None} for d in drawings], **kw}
    return client.post("/api/drawings/batch", json=body)


# ------------------------------------------------------------------ layouts


def test_layouts_are_private_and_last_used_is_per_user(multi: Multi) -> None:
    a = multi.alice.post("/api/layouts", json={"name": "A", "state": STATE}).json()
    b = multi.bob.post("/api/layouts", json={"name": "B", "state": STATE}).json()
    assert multi.alice.put("/api/layouts/last-used", json={"id": a["id"]}).status_code == 204
    assert multi.bob.put("/api/layouts/last-used", json={"id": b["id"]}).status_code == 204
    # Setting Bob's flag did not clear Alice's, and each reads only their own.
    assert multi.alice.get("/api/layouts/last-used").json()["id"] == a["id"]
    assert multi.bob.get("/api/layouts/last-used").json()["id"] == b["id"]
    assert [x["id"] for x in multi.alice.get("/api/layouts").json()] == [a["id"]]
    assert [x["id"] for x in multi.bob.get("/api/layouts").json()] == [b["id"]]
    # Bob cannot point his flag at, or touch, Alice's layout by id.
    url = f"/api/layouts/{a['id']}"
    assert multi.bob.put("/api/layouts/last-used", json={"id": a["id"]}).status_code == 404
    assert multi.bob.get(url).status_code == 404
    assert multi.bob.put(url, json={"state": STATE, "revision": 1}).status_code == 404
    assert multi.bob.patch(url, json={"name": "x"}).status_code == 404
    assert multi.bob.post(f"{url}/duplicate", json={"name": "x"}).status_code == 404
    assert multi.bob.get(f"{url}/export").status_code == 404
    assert multi.bob.delete(url).status_code == 404
    got = multi.alice.get(url).json()
    assert got["name"] == "A" and got["revision"] == 1 and got["isLastUsed"] is True
    assert multi.bob.get("/api/layouts/last-used").json()["id"] == b["id"]
    # Bob's failed attempt left his own flag alone as well (unknown id: nothing changes).


# ---------------------------------------------------------------- drawings


def test_drawings_are_private_and_ids_are_global(multi: Multi) -> None:
    assert batch(multi.alice, drawing("d1"), drawing("sync", scope="all")).status_code == 200
    assert batch(multi.bob, drawing("d2", "MSFT")).status_code == 200
    assert [d["id"] for d in multi.bob.get("/api/drawings").json()["drawings"]] == ["d2"]
    assert {d["id"] for d in multi.alice.get("/api/drawings").json()["drawings"]} == {"d1", "sync"}
    assert multi.bob.get("/api/drawings", params={"symbol": "AAPL"}).json()["drawings"] == []

    # An id Bob does not own is "in use", with or without a base revision / force; nothing changes.
    for kw in ({}, {"force": True}):
        res = batch(multi.bob, drawing("d1", text="mine"), **kw)
        assert res.status_code == 409 and res.json() == {"detail": "id in use"}, res.text
    res = multi.bob.post(
        "/api/drawings/batch",
        json={"upserts": [{"drawing": drawing("d1"), "baseRevision": 1}]},
    )
    assert res.status_code == 409 and res.json() == {"detail": "id in use"}
    # Deleting a foreign drawing deletes nothing and reveals nothing (checked or not).
    for d in ({"id": "d1"}, {"id": "d1", "baseRevision": 1}):
        res = multi.bob.post("/api/drawings/batch", json={"deletes": [d]})
        assert res.status_code == 200 and res.json()["deleted"] == [], res.text
    mine = {d["id"]: d for d in multi.alice.get("/api/drawings").json()["drawings"]}
    assert mine["d1"]["revision"] == 1 and mine["d1"]["data"]["text"] == ""
    # One bad id fails the whole batch: Bob's other drawing was not written either.
    res = batch(multi.bob, drawing("d3"), drawing("d1"))
    assert res.status_code == 409
    assert [d["id"] for d in multi.bob.get("/api/drawings").json()["drawings"]] == ["d2"]

    # Everyone can reuse the right to their own ids.
    assert batch(multi.alice, drawing("d1", text="v2"), baseRevision=1).status_code in (200, 422)


def test_drawings_carry_owner_id_and_the_service_sees_all(multi: Multi) -> None:
    batch(multi.alice, drawing("d1"))
    batch(multi.bob, drawing("d2"))
    mine = multi.alice.get("/api/drawings").json()["drawings"]
    assert [(d["id"], d["ownerId"]) for d in mine] == [("d1", multi.ids["alice"])]
    svc = multi.new_client().get("/api/drawings", headers=SVC).json()["drawings"]
    assert {(d["id"], d["ownerId"]) for d in svc} == {
        ("d1", multi.ids["alice"]),
        ("d2", multi.ids["bob"]),
    }
    # The service token reads only the two lists the alerts service needs.
    for path in ("/api/layouts", "/api/notes", "/api/watchlists", "/api/settings", "/api/flags"):
        assert multi.new_client().get(path, headers=SVC).status_code == 403, path
    # ... and cannot write user data.
    assert batch(multi.new_client(), drawing("x")).status_code == 401
    res = multi.new_client().post("/api/drawings/batch", json={}, headers=SVC)
    assert res.status_code == 401  # the token covers the service's own write routes only
    # The export bundle does not carry the owner.
    assert "ownerId" not in multi.alice.get("/api/export").json()["drawings"][0]


# ------------------------------------------------------------------- notes


def test_notes_and_journal_notes_are_private(multi: Multi) -> None:
    n = multi.alice.post("/api/notes", json={"text": "mine", "symbol": "AAPL"}).json()
    j = mk_note(multi.alice)
    assert [x["id"] for x in multi.alice.get("/api/notes", params={"kind": "all"}).json()] == [
        n["id"],
        j["id"],
    ]
    assert multi.bob.get("/api/notes", params={"kind": "all"}).json() == []
    assert multi.bob.get("/api/notes", params={"kind": "journal"}).json() == []
    url = f"/api/notes/{n['id']}"
    assert multi.bob.get(url).status_code == 404
    assert multi.bob.put(url, json={"text": "x"}).status_code == 404
    assert multi.bob.put(url, json={"text": "x", "revision": 1}).status_code == 404
    assert multi.bob.delete(url).status_code == 404
    assert multi.bob.get(f"/api/notes/{j['id']}").status_code == 404
    assert multi.bob.delete(f"/api/notes/{j['id']}").status_code == 404
    assert multi.alice.get(url).json()["text"] == "mine"


# --------------------------------------------------------------- templates


def test_templates_are_per_user(multi: Multi) -> None:
    ind = {"name": "Trend", "instances": [{"type": "sma"}]}
    chart = {"name": "Dark", "data": {"theme": "dark"}}
    # The same names are free for every user.
    for client in (multi.alice, multi.bob):
        assert client.post("/api/indicator-templates", json=ind).status_code == 201
        assert client.post("/api/chart-templates", json=chart).status_code == 201
    a_ind = multi.alice.get("/api/indicator-templates").json()
    b_ind = multi.bob.get("/api/indicator-templates").json()
    assert len(a_ind) == len(b_ind) == 1 and a_ind[0]["id"] != b_ind[0]["id"]
    # Replace-by-name touches only the caller's row.
    assert (
        multi.bob.post("/api/indicator-templates", json={**ind, "instances": []}).status_code == 200
    )
    assert multi.alice.get("/api/indicator-templates").json()[0]["instances"] == [{"type": "sma"}]
    # By id: not found for the other user, for every verb.
    for kind, body in (("indicator", ind), ("chart", chart)):
        tid = multi.alice.get(f"/api/{kind}-templates").json()[0]["id"]
        url = f"/api/{kind}-templates/{tid}"
        assert multi.bob.get(url).status_code == 404
        assert multi.bob.put(url, json=body).status_code == 404
        assert multi.bob.delete(url).status_code == 404
        assert multi.alice.get(url).status_code == 200

    # Drawing templates: the default flag is cleared per user and tool only.
    def post(client: TestClient, name: str, default: bool) -> dict[str, Any]:
        res = client.post(
            "/api/drawing-templates",
            json={"toolType": "trend-line", "name": name, "style": {}, "isDefault": default},
        )
        assert res.status_code in (200, 201), res.text
        out: dict[str, Any] = res.json()
        return out

    a1 = post(multi.alice, "Thick", True)
    post(multi.bob, "Thick", True)  # same name, same tool: fine
    b2 = post(multi.bob, "Thin", True)
    assert [t["isDefault"] for t in multi.alice.get("/api/drawing-templates").json()] == [True]
    assert {t["name"]: t["isDefault"] for t in multi.bob.get("/api/drawing-templates").json()} == {
        "Thick": False,
        "Thin": True,
    }
    assert multi.bob.get(f"/api/drawing-templates/{a1['id']}").status_code == 404
    assert multi.bob.delete(f"/api/drawing-templates/{a1['id']}").status_code == 404
    assert multi.alice.get(f"/api/drawing-templates/{b2['id']}").status_code == 404


# ---------------------------------------------------------------- settings


def test_settings_are_per_user(multi: Multi) -> None:
    assert multi.alice.put("/api/settings/theme", json={"value": "dark"}).status_code == 204
    assert multi.bob.put("/api/settings/theme", json={"value": "light"}).status_code == 204
    assert multi.alice.get("/api/settings/theme").json() == "dark"
    assert multi.bob.get("/api/settings/theme").json() == "light"
    assert multi.bob.patch("/api/settings", json={"theme": None, "other": 1}).json() == {"other": 1}
    assert multi.alice.get("/api/settings").json() == {"theme": "dark"}
    assert multi.bob.delete("/api/settings/theme").status_code == 204
    assert multi.alice.get("/api/settings/theme").json() == "dark"
    assert multi.bob.get("/api/settings/theme").status_code == 404


# -------------------------------------------- watchlists, scripts, flags


def test_watchlists_are_private_and_ids_are_global(multi: Multi) -> None:
    a = multi.alice.post("/api/watchlists", json={"id": "wl-1", "name": "A", "items": []})
    assert a.status_code == 201
    # Bob learns nothing but "id in use" (not the stored list the owner's own conflict returns).
    res = multi.bob.post("/api/watchlists", json={"id": "wl-1", "name": "B", "items": []})
    assert res.status_code == 409 and res.json() == {"detail": "id in use"}
    own = multi.alice.post("/api/watchlists", json={"id": "wl-1", "name": "A2", "items": []})
    assert own.status_code == 409 and own.json()["detail"]["current"]["name"] == "A"
    assert multi.bob.get("/api/watchlists").json() == []
    url = "/api/watchlists/wl-1"
    assert multi.bob.get(url).status_code == 404
    assert multi.bob.put(url, json={"name": "x", "items": []}).status_code == 404
    assert multi.bob.put(url, json={"name": "x", "items": [], "revision": 1}).status_code == 404
    assert multi.bob.delete(url).status_code == 404
    assert multi.alice.get(url).json()["name"] == "A"


def script(**kw: Any) -> dict[str, Any]:
    return {"name": "S", "source": "plot(close)", "apiVersion": 1, **kw}


def test_user_scripts_are_private_and_carry_owner_id(multi: Multi) -> None:
    assert multi.alice.post("/api/user-scripts", json=script(id="us-1")).status_code == 201
    res = multi.bob.post("/api/user-scripts", json=script(id="us-1", name="theirs"))
    assert res.status_code == 409 and res.json() == {"detail": "id in use"}
    assert multi.bob.post("/api/user-scripts", json=script(id="us-2")).status_code == 201
    assert [x["id"] for x in multi.bob.get("/api/user-scripts").json()] == ["us-2"]
    url = "/api/user-scripts/us-1"
    assert multi.bob.get(url).status_code == 404
    assert multi.bob.put(url, json=script()).status_code == 404
    assert multi.bob.put(url, json=script(revision=1)).status_code == 404
    assert multi.bob.delete(url).status_code == 404
    assert multi.alice.get(url).json()["ownerId"] == multi.ids["alice"]
    svc = multi.new_client().get("/api/user-scripts", headers=SVC).json()
    assert {(x["id"], x["ownerId"]) for x in svc} == {
        ("us-1", multi.ids["alice"]),
        ("us-2", multi.ids["bob"]),
    }


def test_symbol_flags_are_per_user(multi: Multi) -> None:
    assert multi.alice.patch("/api/flags", json={"AAPL": "red", "MSFT": "blue"}).status_code == 200
    assert multi.bob.patch("/api/flags", json={"AAPL": "green"}).status_code == 200
    assert {f["symbol"]: f["color"] for f in multi.alice.get("/api/flags").json()} == {
        "AAPL": "red",
        "MSFT": "blue",
    }
    assert {f["symbol"]: f["color"] for f in multi.bob.get("/api/flags").json()} == {
        "AAPL": "green"
    }
    # Removing a flag removes the caller's only.
    assert multi.bob.patch("/api/flags", json={"AAPL": None, "MSFT": None}).json() == []
    assert len(multi.alice.get("/api/flags").json()) == 2


# --------------------------------------------------------------- portfolios


def test_portfolio_data_is_private(multi: Multi) -> None:
    pa = mk_portfolio(multi.alice)["id"]
    pb = mk_portfolio(multi.bob, name="Bobs")["id"]
    tx = post_tx(multi.alice, pa, externalId="e1")
    note = mk_note(multi.alice)
    eid = multi.alice.post(
        f"/api/portfolios/{pa}/journal", json={"transactionId": tx["id"], "noteId": note["id"]}
    ).json()["id"]
    shot = multi.alice.put(
        f"/api/journal/{eid}/screenshot", content=PNG, headers={"content-type": "image/png"}
    )
    assert shot.status_code == 200
    assert [p["id"] for p in multi.bob.get("/api/portfolios").json()] == [pb]
    base = f"/api/portfolios/{pa}"
    for res in (
        multi.bob.get(base),
        multi.bob.put(base, json={"name": "x"}),
        multi.bob.delete(base),
        multi.bob.get(f"{base}/transactions"),
        multi.bob.post(f"{base}/transactions", json=buy()),
        multi.bob.post(
            f"{base}/transactions/import",
            json={"transactions": [buy()], "source": "import:generic"},
        ),
        multi.bob.delete(f"{base}/imports/anything"),
        multi.bob.get(f"{base}/journal"),
        multi.bob.post(f"{base}/journal", json={}),
        multi.bob.put(f"/api/transactions/{tx['id']}", json=buy()),
        multi.bob.delete(f"/api/transactions/{tx['id']}"),
        multi.bob.put(f"/api/journal/{eid}", json={}),
        multi.bob.put(
            f"/api/journal/{eid}/screenshot", content=PNG, headers={"content-type": "image/png"}
        ),
        multi.bob.get(f"/api/journal/{eid}/screenshot"),
        multi.bob.delete(f"/api/journal/{eid}/screenshot"),
        multi.bob.delete(f"/api/journal/{eid}"),
    ):
        assert res.status_code == 404, (res.request.method, res.request.url, res.text)
    # Links to another user's note / transaction are refused like a missing one.
    for body in ({"noteId": note["id"]}, {"transactionId": tx["id"]}):
        assert multi.bob.post(f"/api/portfolios/{pb}/journal", json=body).status_code == 422
    mine = multi.bob.post(f"/api/portfolios/{pb}/journal", json={}).json()["id"]
    for body in ({"noteId": note["id"]}, {"transactionId": tx["id"]}):
        assert multi.bob.put(f"/api/journal/{mine}", json=body).status_code == 422
    # Alice's data is all still there (and the same external id is free for Bob).
    assert len(multi.alice.get(f"{base}/transactions").json()) == 1
    assert multi.alice.get(f"/api/journal/{eid}/screenshot").content == PNG
    assert (
        multi.bob.post(f"/api/portfolios/{pb}/transactions", json=buy(externalId="e1")).status_code
        == 201
    )


# ------------------------------------------------------------ export / import


def full_bundle(client: TestClient, alice_id: str) -> dict[str, Any]:
    """Alice's data: one of each resource whose ids are client-visible."""
    assert client.post("/api/layouts", json={"name": "L", "state": STATE}).status_code == 201
    client.put("/api/layouts/last-used", json={"id": client.get("/api/layouts").json()[0]["id"]})
    assert batch(client, drawing("dr-1")).status_code == 200
    assert client.post("/api/notes", json={"text": "n", "symbol": "AAPL"}).status_code == 201
    assert (
        client.post("/api/watchlists", json={"id": "wl-1", "name": "W", "items": []}).status_code
        == 201
    )
    assert client.put("/api/settings/k", json={"value": 1}).status_code == 204
    assert client.patch("/api/flags", json={"AAPL": "red"}).status_code == 200
    assert (
        client.post("/api/indicator-templates", json={"name": "T", "instances": []}).status_code
        == 201
    )
    pid = mk_portfolio(client)["id"]
    tx = post_tx(client, pid, externalId="e1")
    jn = mk_note(client)
    entry = client.post(
        f"/api/portfolios/{pid}/journal", json={"transactionId": tx["id"], "noteId": jn["id"]}
    ).json()
    shot = client.put(
        f"/api/journal/{entry['id']}/screenshot", content=PNG, headers={"content-type": "image/png"}
    )
    assert shot.status_code == 200
    spec = drawing_spec("dr-1")
    alert = client.post(
        "/api/alerts", json={"name": "A", "symbol": "AAPL", "interval": "1D", "spec": spec}
    )
    assert alert.status_code == 201, alert.text
    bundle: dict[str, Any] = client.get("/api/export").json()
    return bundle


def test_a_bundle_of_one_user_imports_under_another(multi: Multi) -> None:
    bundle = full_bundle(multi.alice, multi.ids["alice"])
    before = multi.alice.get("/api/export").json()
    # Alice's scripts would collide (references to them cannot follow a new id): see below.
    assert bundle["userScripts"] == []

    res = multi.bob.post("/api/import", json=bundle)
    assert res.status_code == 200, res.text
    summary = res.json()
    for section in ("layouts", "drawings", "notes", "watchlists", "portfolios", "alerts"):
        assert summary[section]["created"] >= 1, section
    # It all landed under Bob, under new ids where Alice's were taken.
    got = multi.bob.get("/api/export").json()
    for key in ("layouts", "notes", "watchlists", "portfolios", "alerts", "drawings"):
        theirs = {x["id"] for x in got[key]}
        hers = {x["id"] for x in bundle[key]}
        assert len(theirs) == len(hers) and not theirs & hers, key
    assert got["settings"] == {"k": 1} and [f["symbol"] for f in got["flags"]] == ["AAPL"]
    assert len(got["portfolioTransactions"]) == 1 and len(got["journalEntries"]) == 1
    entry = got["journalEntries"][0]
    assert entry["portfolioId"] == got["portfolios"][0]["id"]
    assert entry["transactionId"] == got["portfolioTransactions"][0]["id"]
    assert entry["noteId"] in {
        n["id"] for n in multi.bob.get("/api/notes", params={"kind": "all"}).json()
    }
    assert base64.b64decode(entry["screenshot"]["data"]) == PNG
    # The alert follows its drawing to the new id.
    alert = got["alerts"][0]
    assert alert["spec"]["condition"]["right"]["drawingId"] == got["drawings"][0]["id"]
    assert got["drawings"][0]["data"]["id"] == got["drawings"][0]["id"]
    # Bob has his own last-used layout; Alice's data did not change at all.
    assert [x["isLastUsed"] for x in got["layouts"]] == [True]
    after = multi.alice.get("/api/export").json()
    after.pop("exportedAt"), before.pop("exportedAt")
    assert after == before
    assert len(multi.alice.get("/api/portfolios").json()) == 1


def test_importing_a_script_of_another_user_is_refused(multi: Multi) -> None:
    assert multi.alice.post("/api/user-scripts", json=script(id="us-1")).status_code == 201
    bundle = multi.alice.get("/api/export").json()
    assert [x["id"] for x in bundle["userScripts"]] == ["us-1"]
    assert "ownerId" not in bundle["userScripts"][0]
    res = multi.bob.post("/api/import", json=bundle)
    assert res.status_code == 409 and res.json() == {"detail": "id in use"}
    assert multi.bob.get("/api/user-scripts").json() == []
    # A bundle that names no script imports fine, and Alice can re-import her own.
    assert multi.alice.post("/api/import", json=bundle).status_code == 200


def test_replace_import_deletes_only_own_rows(multi: Multi) -> None:
    alice_bundle = full_bundle(multi.alice, multi.ids["alice"])
    multi.alice.post("/api/user-scripts", json=script(id="us-1"))
    before = multi.alice.get("/api/export").json()
    full_bundle_b = {k: v for k, v in alice_bundle.items() if k not in ("userScripts",)}
    assert multi.bob.post("/api/import", json=full_bundle_b).status_code == 200
    # Bob replaces every section (an empty bundle that names each of them).
    empty: dict[str, Any] = {"version": 1, "app": "tickerglass"}
    for key in [
        "layouts",
        "drawings",
        "indicatorTemplates",
        "drawingTemplates",
        "chartTemplates",
        "notes",
        "watchlists",
        "flags",
        "alerts",
        "userScripts",
        "screens",
        "portfolios",
        "portfolioTransactions",
        "journalEntries",
    ]:
        empty[key] = []
    empty["settings"] = {}
    res = multi.bob.post("/api/import?mode=replace&confirm=true", json=empty)
    assert res.status_code == 200, res.text
    gone = multi.bob.get("/api/export").json()
    for key, value in gone.items():
        if isinstance(value, list):
            assert value == [], key
    after = multi.alice.get("/api/export").json()
    after.pop("exportedAt"), before.pop("exportedAt")
    assert after == before
    with engine_of(multi.root).connect() as conn:
        # Alice's alert state / children are intact at the table level as well.
        n = conn.exec_driver_sql(
            "SELECT count(*) FROM alerts WHERE owner_id = ?", (multi.ids["alice"],)
        )
        assert n.scalar_one() == 1
        n = conn.exec_driver_sql(
            "SELECT count(*) FROM alerts WHERE owner_id = ?", (multi.ids["bob"],)
        )
        assert n.scalar_one() == 0


def test_import_conflict_does_not_echo_the_database_error(multi: Multi) -> None:
    from sqlalchemy.exc import IntegrityError

    from tickerglass_api.userdata import store

    original = store.import_bundle

    def boom(*_a: Any, **_k: Any) -> Any:
        raise IntegrityError(
            "INSERT secret", {}, Exception("UNIQUE failed: layouts.id 'someone-elses'")
        )

    store.import_bundle = boom  # type: ignore[assignment]
    try:
        res = multi.alice.post("/api/import", json={"version": 1, "app": "tickerglass"})
    finally:
        store.import_bundle = original
    assert res.status_code == 409 and res.json() == {"detail": "import conflicts with stored data"}


# ------------------------------------------------------------------ providers


def test_provider_listing_exposes_no_secrets(multi: Multi, monkeypatch: Any) -> None:
    monkeypatch.setenv("TWELVEDATA_API_KEY", "sk-secret-123")
    for client in (multi.alice, multi.owner):
        for path in ("/api/providers", "/api/providers/usage"):
            res = client.get(path)
            assert res.status_code == 200, path
            assert "sk-secret-123" not in res.text
    cfg = multi.alice.get("/api/providers").json()["providers"]
    for p in cfg:
        for field in p["config"]:
            if field["secret"]:
                assert field["value"] is None
    # Admin-only writes.
    assert multi.alice.post("/api/providers/active", json={"id": "demo"}).status_code == 403
    assert multi.alice.post("/api/providers/test").status_code == 403
