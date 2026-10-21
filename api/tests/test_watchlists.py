"""Phase 8: watchlists, symbol flags, and their bundle sections."""

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Connection, create_engine, insert, inspect, update
from test_userdata import NullProvider, alembic_config, interleave, strip_volatile

from tickerglass_api import models
from tickerglass_api.app import create_app
from tickerglass_api.userdata.schemas import MAX_WATCHLIST_ITEMS


def sym(s: str) -> dict[str, Any]:
    return {"type": "symbol", "symbol": s}


def section(sid: str, title: str = "S", collapsed: bool = False) -> dict[str, Any]:
    return {"type": "section", "id": sid, "title": title, "collapsed": collapsed}


def make(client: TestClient, name: str = "L", items: list[Any] | None = None, **kw: Any) -> Any:
    res = client.post("/api/watchlists", json={"name": name, "items": items or [], **kw})
    assert res.status_code == 201, res.text
    return res.json()


def test_crud_round_trip(client: TestClient) -> None:
    assert client.get("/api/watchlists").json() == []
    created = make(client, " Tech ", [sym(" aapl "), section("s1", " Chips "), sym("NVDA")])
    assert created["name"] == "Tech" and created["revision"] == 1
    assert created["items"] == [sym("AAPL"), section("s1", "Chips"), sym("NVDA")]
    assert {"createdAt", "updatedAt"} <= set(created)
    wid = created["id"]
    assert client.get(f"/api/watchlists/{wid}").json() == created
    assert client.get("/api/watchlists").json() == [created]

    res = client.put(
        f"/api/watchlists/{wid}", json={"name": "Tech2", "items": [sym("MSFT")], "revision": 1}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["revision"] == 2 and body["name"] == "Tech2" and body["items"] == [sym("MSFT")]
    assert body["createdAt"] == created["createdAt"]
    assert client.get(f"/api/watchlists/{wid}").json() == body

    assert client.delete(f"/api/watchlists/{wid}").status_code == 204
    assert client.delete(f"/api/watchlists/{wid}").status_code == 404
    assert client.get(f"/api/watchlists/{wid}").status_code == 404
    assert client.put(f"/api/watchlists/{wid}", json={"name": "x", "items": []}).status_code == 404


def test_post_with_client_id_conflicts_on_reuse(client: TestClient) -> None:
    first = make(client, "A", [sym("AAPL")], id="client-id_1")
    assert first["id"] == "client-id_1"
    res = client.post("/api/watchlists", json={"id": "client-id_1", "name": "B", "items": []})
    assert res.status_code == 409
    assert res.json()["detail"]["current"] == first
    assert client.get("/api/watchlists/client-id_1").json()["name"] == "A"
    for bad in ("a/b", "x" * 37, "", "a b"):
        res = client.post("/api/watchlists", json={"id": bad, "name": "B"})
        assert res.status_code == 422, bad


def test_put_stale_revision_and_overwrite(client: TestClient) -> None:
    wid = make(client)["id"]
    ok = client.put(f"/api/watchlists/{wid}", json={"name": "v2", "items": [], "revision": 1})
    assert ok.status_code == 200
    stale = client.put(f"/api/watchlists/{wid}", json={"name": "stale", "items": [], "revision": 1})
    assert stale.status_code == 409
    current = stale.json()["detail"]["current"]
    assert current["revision"] == 2 and current["name"] == "v2"
    forced = client.put(f"/api/watchlists/{wid}", json={"name": "forced", "items": []})
    assert forced.status_code == 200 and forced.json()["revision"] == 3


def test_validation_errors(client: TestClient) -> None:
    def post(**kw: Any) -> int:
        return client.post("/api/watchlists", json={"name": "L", **kw}).status_code

    assert post(items=[sym("aapl"), sym("AAPL")]) == 422
    assert post(items=[section("s"), section("s")]) == 422
    assert post(items=[sym(f"S{i}") for i in range(MAX_WATCHLIST_ITEMS + 1)]) == 422
    assert post(items=[sym(f"S{i}") for i in range(MAX_WATCHLIST_ITEMS)]) == 201
    assert post(items=[sym("A B")]) == 422
    assert post(items=[sym("")]) == 422
    assert post(items=[sym("X" * 33)]) == 422
    assert post(items=[{"type": "other"}]) == 422
    assert post(items=[section("s", "x" * 101)]) == 422
    assert client.post("/api/watchlists", json={"name": "  ", "items": []}).status_code == 422
    assert post(items=[sym("^GSPC"), sym("BTC-USD"), sym("ES=F"), sym("DX-Y.NYB")]) == 201
    res = client.post("/api/watchlists", json={"name": "L", "items": [sym("A B")]})
    assert "invalid symbol" in str(res.json()["detail"])
    res = client.post("/api/watchlists", json={"name": "L", "items": [sym("a"), sym("A")]})
    assert "duplicate symbol: A" in str(res.json()["detail"])
    wid = client.get("/api/watchlists").json()[0]["id"]
    res = client.put(f"/api/watchlists/{wid}", json={"name": "L", "items": [sym("a"), sym("A")]})
    assert res.status_code == 422


def test_put_race_is_a_conflict(race_client: TestClient) -> None:
    client = race_client
    wid = make(client, "v1")["id"]

    def other(conn: Connection) -> None:
        conn.execute(
            update(models.Watchlist)
            .where(models.Watchlist.id == wid)
            .values(name="theirs", revision=models.Watchlist.revision + 1)
        )

    with interleave(client, "UPDATE watchlists", other):
        res = client.put(
            f"/api/watchlists/{wid}", json={"name": "mine", "items": [], "revision": 1}
        )
    assert res.status_code == 409 and res.json()["detail"]["current"]["name"] == "theirs"
    assert client.get(f"/api/watchlists/{wid}").json()["name"] == "theirs"


def flags(client: TestClient) -> dict[str, dict[str, Any]]:
    return {f["symbol"]: f for f in client.get("/api/flags").json()}


def test_flags_patch(client: TestClient) -> None:
    assert client.get("/api/flags").json() == []
    res = client.patch("/api/flags", json={"aapl": "red", "MSFT": "blue"})
    assert res.status_code == 200
    got = {f["symbol"]: f for f in res.json()}
    assert {k: v["color"] for k, v in got.items()} == {"AAPL": "red", "MSFT": "blue"}
    assert set(got["AAPL"]) == {"symbol", "color", "createdAt", "updatedAt"}
    before = flags(client)

    # Same color: no-op (createdAt and updatedAt kept).
    client.patch("/api/flags", json={"AAPL": "red"})
    assert flags(client)["AAPL"] == before["AAPL"]

    # New color: createdAt reset.
    client.patch("/api/flags", json={"AAPL": "green"})
    after = flags(client)["AAPL"]
    assert after["color"] == "green" and after["createdAt"] > before["AAPL"]["createdAt"]
    assert flags(client)["MSFT"] == before["MSFT"]

    # Unflag one, a missing one is a no-op, all in one batch.
    res = client.patch("/api/flags", json={"MSFT": None, "NOPE": None, "nvda": "cyan"})
    assert [f["symbol"] for f in res.json()] == ["AAPL", "NVDA"]
    # Ordered by createdAt, symbol.
    res = client.patch("/api/flags", json={"AMD": "cyan"})
    stamps = [(f["createdAt"], f["symbol"]) for f in res.json()]
    assert stamps == sorted(stamps)


def test_flags_validation(client: TestClient) -> None:
    assert client.patch("/api/flags", json={"AAPL": "pink"}).status_code == 422
    assert client.patch("/api/flags", json={"A B": "red"}).status_code == 422
    big = {f"S{i}": "red" for i in range(5001)}
    assert client.patch("/api/flags", json=big).status_code == 422
    assert client.get("/api/flags").json() == []


# ------------------------------------------------------------------- bundle


def bundle_body(**sections: Any) -> dict[str, Any]:
    return {"version": 1, "app": "tickerglass", **sections}


def test_bundle_export_and_round_trip(client: TestClient, tmp_path: Path) -> None:
    make(client, "Tech", [sym("AAPL"), section("s1", "Chips"), sym("NVDA")], id="w1")
    client.patch("/api/flags", json={"AAPL": "red", "NVDA": "blue"})
    bundle = client.get("/api/export").json()
    assert bundle["watchlists"][0]["id"] == "w1"
    assert bundle["watchlists"][0]["items"] == [sym("AAPL"), section("s1", "Chips"), sym("NVDA")]
    assert [(f["symbol"], f["color"]) for f in bundle["flags"]] == [
        ("AAPL", "red"),
        ("NVDA", "blue"),
    ]
    assert bundle["version"] == 1

    app2 = create_app(provider=NullProvider(), database_url=f"sqlite:///{tmp_path}/other.db")
    with TestClient(app2) as c2:
        res = c2.post("/api/import", json=bundle)
        assert res.status_code == 200
        assert res.json()["watchlists"] == {"created": 1, "updated": 0, "deleted": 0}
        assert res.json()["flags"] == {"created": 2, "updated": 0, "deleted": 0}
        assert strip_volatile(c2.get("/api/export").json()) == strip_volatile(bundle)

    # Merge into itself: matches are updated, the revision is bumped.
    res = client.post("/api/import", json=bundle).json()
    assert res["watchlists"] == {"created": 0, "updated": 1, "deleted": 0}
    assert res["flags"] == {"created": 0, "updated": 2, "deleted": 0}
    assert client.get("/api/watchlists/w1").json()["revision"] == 2
    assert {f["symbol"]: f["createdAt"] for f in client.get("/api/flags").json()} == {
        f["symbol"]: f["createdAt"] for f in bundle["flags"]
    }


def test_bundle_merge_overwrites_and_flag_color_change(client: TestClient) -> None:
    make(client, "Old", [sym("AAPL")], id="w1")
    client.patch("/api/flags", json={"AAPL": "red", "MSFT": "blue"})
    old = flags(client)
    body = bundle_body(
        watchlists=[{"id": "w1", "name": "New", "items": [sym("MSFT")]}],
        flags=[{"symbol": "aapl", "color": "green"}, {"symbol": "MSFT", "color": "blue"}],
    )
    res = client.post("/api/import", json=body)
    assert res.status_code == 200
    w = client.get("/api/watchlists/w1").json()
    assert (w["name"], w["items"], w["revision"]) == ("New", [sym("MSFT")], 2)
    now = flags(client)
    assert now["AAPL"]["color"] == "green" and now["AAPL"]["createdAt"] > old["AAPL"]["createdAt"]
    assert now["MSFT"]["createdAt"] == old["MSFT"]["createdAt"]


def test_bundle_duplicates_rejected(client: TestClient) -> None:
    w = {"id": "w1", "name": "A", "items": []}
    assert client.post("/api/import", json=bundle_body(watchlists=[w, w])).status_code == 422
    f = {"symbol": "AAPL", "color": "red"}
    assert client.post("/api/import", json=bundle_body(flags=[f, f])).status_code == 422
    assert client.get("/api/watchlists").json() == [] and client.get("/api/flags").json() == []


def test_bundle_replace_and_absent_sections(client: TestClient) -> None:
    make(client, "A", id="w1")
    client.patch("/api/flags", json={"AAPL": "red"})
    before = strip_volatile(client.get("/api/export").json())
    params = {"mode": "replace", "confirm": True}

    # Old (Phase 7) bundle without the new keys: untouched.
    res = client.post("/api/import", params=params, json=bundle_body())
    assert res.status_code == 200
    assert res.json()["watchlists"]["deleted"] == 0 and res.json()["flags"]["deleted"] == 0
    assert strip_volatile(client.get("/api/export").json()) == before

    # Explicitly empty watchlists: lists wiped, flags kept.
    res = client.post("/api/import", params=params, json=bundle_body(watchlists=[]))
    assert res.json()["watchlists"]["deleted"] == 1 and res.json()["flags"]["deleted"] == 0
    assert client.get("/api/watchlists").json() == []
    assert len(client.get("/api/flags").json()) == 1

    res = client.post("/api/import", params=params, json=bundle_body(flags=[]))
    assert res.json()["flags"]["deleted"] == 1
    assert client.get("/api/flags").json() == []

    # Dry run rolls back.
    res = client.post(
        "/api/import",
        params={"dryRun": True},
        json=bundle_body(watchlists=[{"id": "w9", "name": "Z", "items": []}]),
    )
    assert res.json()["watchlists"]["created"] == 1
    assert client.get("/api/watchlists").json() == []


def test_bundle_invalid_watchlist_id_is_reissued(client: TestClient) -> None:
    body = bundle_body(
        watchlists=[
            {"id": "a/b", "name": "Odd", "items": [sym("AAPL")]},
            {"id": "keep-me", "name": "Fine", "items": []},
        ]
    )
    res = client.post("/api/import", json=body)
    assert res.status_code == 200 and res.json()["watchlists"]["created"] == 2
    ids = {w["name"]: w["id"] for w in client.get("/api/watchlists").json()}
    assert ids["Fine"] == "keep-me" and ids["Odd"] != "a/b"
    assert client.get(f"/api/watchlists/{ids['Odd']}").json()["items"] == [sym("AAPL")]
    # Imported items are validated like API input.
    bad = bundle_body(watchlists=[{"id": "x", "name": "N", "items": [sym("A B")]}])
    assert client.post("/api/import", json=bad).status_code == 422


def test_migration_adds_and_drops_only_watchlist_tables(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/m.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, "head")
    assert {"watchlists", "symbol_flags"} <= set(inspect(engine).get_table_names())
    command.downgrade(cfg, "bd686f7c13d4")
    tables = set(inspect(engine).get_table_names())
    assert not tables & {"watchlists", "symbol_flags"} and "notes" in tables
    command.upgrade(cfg, "head")
    assert {"watchlists", "symbol_flags"} <= set(inspect(engine).get_table_names())
    engine.dispose()


T = datetime(2026, 1, 1, tzinfo=UTC)


T = datetime(2026, 1, 1, tzinfo=UTC)


def test_post_race_is_a_conflict(race_client: TestClient) -> None:
    client = race_client

    def other(conn: Connection) -> None:
        conn.execute(
            insert(models.Watchlist).values(
                id="w1",
                name="theirs",
                items=[],
                revision=1,
                created_at=T,
                updated_at=T,
            )
        )

    with interleave(client, "INSERT INTO watchlists", other):
        res = client.post("/api/watchlists", json={"id": "w1", "name": "mine", "items": []})
    assert res.status_code == 409 and res.json()["detail"]["current"]["name"] == "theirs"
    assert client.get("/api/watchlists/w1").json()["name"] == "theirs"


def test_flags_patch_race_is_not_a_500(race_client: TestClient) -> None:
    client = race_client

    def other(conn: Connection) -> None:
        conn.execute(
            insert(models.SymbolFlag).values(
                symbol="AAPL", color="blue", created_at=T, updated_at=T
            )
        )

    with interleave(client, "INSERT INTO symbol_flags", other):
        res = client.patch("/api/flags", json={"AAPL": "red", "MSFT": "green"})
    assert res.status_code == 200
    assert {f["symbol"]: f["color"] for f in res.json()} == {"AAPL": "red", "MSFT": "green"}
