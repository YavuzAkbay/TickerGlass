"""Phase 7 user data endpoints: layouts, drawings, templates, settings, notes,
import/export, and the migration."""

from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect

from investopen_api import models
from investopen_api.app import create_app
from investopen_api.db import Base
from investopen_api.providers.base import BAR_COLUMNS, SymbolNotFound
from investopen_api.userdata.schemas import MAX_STATE_BYTES


class NullProvider:
    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        return pd.DataFrame(columns=BAR_COLUMNS)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        raise SymbolNotFound(symbol)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return []


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(provider=NullProvider(), database_url=f"sqlite:///{tmp_path}/u.db")
    with TestClient(app) as c:
        yield c


def drawing(did: str, symbol: str = "AAPL", **kw: Any) -> dict[str, Any]:
    return {
        "id": did,
        "type": "trend-line",
        "points": [{"time": 1, "price": 2.5}],
        "style": {"lineColor": "#f00"},
        "text": "",
        "locked": False,
        "hidden": False,
        "zIndex": 0,
        "visibility": None,
        "scope": "symbol",
        "symbol": symbol,
        "paneId": "main",
        **kw,
    }


STATE = {"version": 1, "chart": {"symbol": "AAPL", "interval": "1D"}, "indicators": []}

# ------------------------------------------------------------------ layouts


def test_layout_crud_and_revision_conflict(client: TestClient) -> None:
    assert client.get("/api/layouts").json() == []
    assert client.get("/api/layouts/last-used").json() is None

    res = client.post("/api/layouts", json={"name": "  Main ", "state": STATE})
    assert res.status_code == 201
    lay = res.json()
    assert lay["name"] == "Main" and lay["revision"] == 1 and lay["schemaVersion"] == 1
    assert lay["state"] == STATE and lay["isLastUsed"] is False
    lid = lay["id"]

    new_state = {**STATE, "chart": {"symbol": "MSFT", "interval": "1h"}}
    res = client.put(f"/api/layouts/{lid}", json={"state": new_state, "revision": 1})
    assert res.status_code == 200 and res.json()["revision"] == 2

    # A second device still on revision 1 loses.
    res = client.put(f"/api/layouts/{lid}", json={"state": STATE, "revision": 1})
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["current"]["revision"] == 2 and detail["current"]["state"] == new_state

    # Rename keeps the revision.
    res = client.patch(f"/api/layouts/{lid}", json={"name": "Renamed"})
    assert res.status_code == 200
    assert res.json()["name"] == "Renamed" and res.json()["revision"] == 2
    assert "state" not in res.json()

    got = client.get(f"/api/layouts/{lid}").json()
    assert got["state"] == new_state and got["name"] == "Renamed"

    res = client.post(f"/api/layouts/{lid}/duplicate", json={"name": "Copy"})
    assert res.status_code == 201
    copy = res.json()
    assert copy["id"] != lid and copy["state"] == new_state and copy["revision"] == 1

    summaries = client.get("/api/layouts").json()
    assert {x["name"] for x in summaries} == {"Renamed", "Copy"}
    assert all("state" not in x for x in summaries)

    assert client.delete(f"/api/layouts/{copy['id']}").status_code == 204
    assert client.get(f"/api/layouts/{copy['id']}").status_code == 404
    assert client.delete(f"/api/layouts/{copy['id']}").status_code == 404
    assert client.put("/api/layouts/nope", json={"state": STATE, "revision": 1}).status_code == 404


def test_layout_last_used(client: TestClient) -> None:
    a = client.post("/api/layouts", json={"name": "A", "state": STATE}).json()
    b = client.post("/api/layouts", json={"name": "B", "state": STATE}).json()
    assert client.put("/api/layouts/last-used", json={"id": a["id"]}).status_code == 204
    assert client.get("/api/layouts/last-used").json()["id"] == a["id"]
    assert client.put("/api/layouts/last-used", json={"id": b["id"]}).status_code == 204
    assert client.get("/api/layouts/last-used").json()["id"] == b["id"]
    flags = {x["id"]: x["isLastUsed"] for x in client.get("/api/layouts").json()}
    assert flags == {a["id"]: False, b["id"]: True}
    assert client.put("/api/layouts/last-used", json={"id": "missing"}).status_code == 404
    client.delete(f"/api/layouts/{b['id']}")
    assert client.get("/api/layouts/last-used").json() is None


def test_layout_validation(client: TestClient) -> None:
    def post(body: dict[str, Any]) -> int:
        return client.post("/api/layouts", json=body).status_code

    assert post({"name": "", "state": STATE}) == 422
    assert post({"name": "   ", "state": STATE}) == 422
    assert post({"name": "x" * 201, "state": STATE}) == 422
    assert post({"name": "x", "state": [1, 2]}) == 422
    assert post({"name": "x", "state": STATE, "schemaVersion": 0}) == 422
    assert post({"name": "x", "state": STATE, "bogus": 1}) == 422
    assert post({"name": "x", "state": {"blob": "a" * MAX_STATE_BYTES}}) == 422
    assert post({"name": "x", "state": STATE, "schemaVersion": 3}) == 201


def test_layout_export_import(client: TestClient) -> None:
    lay = client.post("/api/layouts", json={"name": "Mine", "state": STATE}).json()
    exported = client.get(f"/api/layouts/{lay['id']}/export").json()
    assert exported["version"] == 1 and exported["kind"] == "layout"
    assert exported["layout"] == {"name": "Mine", "state": STATE, "schemaVersion": 1}

    res = client.post("/api/layouts/import", json=exported)
    assert res.status_code == 201
    imp = res.json()
    assert imp["id"] != lay["id"] and imp["name"] == "Mine" and imp["state"] == STATE

    res = client.post("/api/layouts/import", params={"name": "Other"}, json=exported)
    assert res.json()["name"] == "Other"
    assert client.post("/api/layouts/import", json={**exported, "version": 99}).status_code == 422
    assert client.post("/api/layouts/import", json={**exported, "kind": "x"}).status_code == 422


# ----------------------------------------------------------------- drawings


def batch(client: TestClient, **body: Any) -> Any:
    return client.post("/api/drawings/batch", json=body)


def test_drawings_batch_and_query(client: TestClient) -> None:
    res = batch(
        client,
        upserts=[
            {"drawing": drawing("d1", "aapl", zIndex=3)},
            {"drawing": drawing("d2", "MSFT")},
            {"drawing": drawing("s1", scope="all")},
        ],
    )
    assert res.status_code == 200
    out = {d["id"]: d for d in res.json()["drawings"]}
    assert out["d1"]["symbol"] == "AAPL" and out["d1"]["z"] == 3 and out["d1"]["revision"] == 1
    assert out["s1"]["symbol"] is None and out["s1"]["paneId"] == "main"
    assert out["d1"]["data"] == drawing("d1", "aapl", zIndex=3)

    ids = lambda r: sorted(d["id"] for d in r.json()["drawings"])  # noqa: E731
    assert ids(client.get("/api/drawings", params={"symbol": "aapl"})) == ["d1", "s1"]
    assert ids(client.get("/api/drawings", params={"symbol": "AAPL", "synced": False})) == ["d1"]
    assert ids(client.get("/api/drawings")) == ["d1", "d2", "s1"]

    # Update d1 (moves it to synced) and delete d2 in one request.
    res = batch(
        client,
        upserts=[{"drawing": drawing("d1", scope="all"), "baseRevision": 1}],
        deletes=[{"id": "d2", "baseRevision": 1}, {"id": "never-existed"}],
    )
    assert res.status_code == 200
    assert res.json()["deleted"] == ["d2"]
    assert res.json()["drawings"][0]["revision"] == 2
    assert res.json()["drawings"][0]["symbol"] is None
    assert ids(client.get("/api/drawings", params={"symbol": "MSFT"})) == ["d1", "s1"]


def test_drawings_conflicts_are_all_or_nothing(client: TestClient) -> None:
    batch(client, upserts=[{"drawing": drawing("d1")}, {"drawing": drawing("d2")}])
    batch(client, upserts=[{"drawing": drawing("d1", text="other device"), "baseRevision": 1}])

    res = batch(
        client,
        upserts=[
            {"drawing": drawing("d1", text="mine"), "baseRevision": 1},  # stale
            {"drawing": drawing("d2", text="ok"), "baseRevision": 1},
            {"drawing": drawing("d3")},
        ],
        deletes=[],
    )
    assert res.status_code == 409
    conflicts = res.json()["detail"]["conflicts"]
    assert [c["id"] for c in conflicts] == ["d1"]
    assert conflicts[0]["revision"] == 2
    assert conflicts[0]["drawing"]["data"]["text"] == "other device"
    stored = {d["id"]: d for d in client.get("/api/drawings").json()["drawings"]}
    assert set(stored) == {"d1", "d2"} and stored["d2"]["revision"] == 1

    # Creating an existing id, updating a deleted one, stale delete: all conflicts.
    batch(client, deletes=[{"id": "d2"}])
    res = batch(
        client,
        upserts=[
            {"drawing": drawing("d1")},
            {"drawing": drawing("d2"), "baseRevision": 1},
        ],
    )
    assert res.status_code == 409
    by_id = {c["id"]: c for c in res.json()["detail"]["conflicts"]}
    assert by_id["d1"]["revision"] == 2 and by_id["d2"] == {
        "id": "d2",
        "revision": None,
        "drawing": None,
    }
    assert batch(client, deletes=[{"id": "d1", "baseRevision": 1}]).status_code == 409

    # force = last writer wins.
    res = batch(client, upserts=[{"drawing": drawing("d1", text="mine")}], force=True)
    assert res.status_code == 200 and res.json()["drawings"][0]["revision"] == 3


def test_drawings_validation(client: TestClient) -> None:
    def status(**body: Any) -> int:
        return int(batch(client, **body).status_code)

    bad = drawing("x")
    del bad["paneId"]
    assert status(upserts=[{"drawing": bad}]) == 422
    assert status(upserts=[{"drawing": {**drawing("x"), "id": 5}}]) == 422
    assert status(upserts=[{"drawing": drawing("x" * 65)}]) == 422
    assert status(upserts=[{"drawing": drawing("a")}], deletes=[{"id": "a"}]) == 422
    assert status(upserts=[{"drawing": {**drawing("a"), "big": "x" * 600_000}}]) == 422
    assert status(upserts=[{"drawing": drawing("a"), "baseRevision": 0}]) == 422
    assert status(deletes=[{"id": str(i)} for i in range(5001)]) == 422
    assert status() == 200


# ---------------------------------------------------------------- templates


def test_indicator_templates(client: TestClient) -> None:
    body = {"name": "Trend", "instances": [{"type": "sma", "inputs": {"length": 20}}]}
    res = client.post("/api/indicator-templates", json=body)
    assert res.status_code == 201
    tpl = res.json()
    # Same name: replaced in place.
    res = client.post("/api/indicator-templates", json={**body, "instances": []})
    assert res.status_code == 200 and res.json()["id"] == tpl["id"]
    assert res.json()["instances"] == []

    other = client.post("/api/indicator-templates", json={**body, "name": "Osc"}).json()
    assert [t["name"] for t in client.get("/api/indicator-templates").json()] == ["Osc", "Trend"]
    res = client.put(f"/api/indicator-templates/{other['id']}", json={**body, "name": "Trend"})
    assert res.status_code == 409
    res = client.put(f"/api/indicator-templates/{other['id']}", json={**body, "name": "Osc 2"})
    assert res.status_code == 200 and res.json()["name"] == "Osc 2"
    assert client.get(f"/api/indicator-templates/{tpl['id']}").json()["name"] == "Trend"
    assert client.delete(f"/api/indicator-templates/{tpl['id']}").status_code == 204
    assert client.get(f"/api/indicator-templates/{tpl['id']}").status_code == 404
    assert (
        client.post("/api/indicator-templates", json={"name": "x", "instances": {}}).status_code
        == 422
    )


def test_drawing_templates_and_defaults(client: TestClient) -> None:
    def post(name: str, tool: str = "trend-line", default: bool = False) -> Any:
        return client.post(
            "/api/drawing-templates",
            json={"toolType": tool, "name": name, "style": {"lineWidth": 2}, "isDefault": default},
        )

    a = post("Thick", default=True)
    assert a.status_code == 201 and a.json()["isDefault"] is True
    b = post("Thin", default=True).json()
    post("Other tool", tool="ray", default=True)
    tpls = client.get("/api/drawing-templates", params={"toolType": "trend-line"}).json()
    assert {t["name"]: t["isDefault"] for t in tpls} == {"Thick": False, "Thin": True}
    assert len(client.get("/api/drawing-templates").json()) == 3
    # Same name, same tool: replaced; same name on another tool is separate.
    assert post("Thin").status_code == 200
    assert post("Thin", tool="ray").status_code == 201

    res = client.put(
        f"/api/drawing-templates/{b['id']}",
        json={"toolType": "trend-line", "name": "Thick", "style": {}},
    )
    assert res.status_code == 409
    res = client.put(
        f"/api/drawing-templates/{b['id']}",
        json={"toolType": "trend-line", "name": "Thin", "style": {"x": 1}, "isDefault": True},
    )
    assert res.status_code == 200 and res.json()["style"] == {"x": 1}
    assert client.get(f"/api/drawing-templates/{a.json()['id']}").json()["isDefault"] is False
    assert client.delete(f"/api/drawing-templates/{b['id']}").status_code == 204
    assert client.get(f"/api/drawing-templates/{b['id']}").status_code == 404


def test_chart_templates(client: TestClient) -> None:
    res = client.post("/api/chart-templates", json={"name": "Dark", "data": {"bg": "#000"}})
    assert res.status_code == 201
    tid = res.json()["id"]
    assert client.post("/api/chart-templates", json={"name": "Dark", "data": {}}).status_code == 200
    client.post("/api/chart-templates", json={"name": "Light", "data": {}})
    res = client.put(f"/api/chart-templates/{tid}", json={"name": "Light", "data": {}})
    assert res.status_code == 409
    res = client.put(f"/api/chart-templates/{tid}", json={"name": "Night", "data": {"a": 1}})
    assert res.json()["name"] == "Night"
    assert [t["name"] for t in client.get("/api/chart-templates").json()] == ["Light", "Night"]
    assert client.get(f"/api/chart-templates/{tid}").json()["data"] == {"a": 1}
    assert client.delete(f"/api/chart-templates/{tid}").status_code == 204
    assert client.delete(f"/api/chart-templates/{tid}").status_code == 404


# ----------------------------------------------------------------- settings


def test_settings(client: TestClient) -> None:
    assert client.get("/api/settings").json() == {}
    assert client.put("/api/settings/favorites", json={"value": ["rsi"]}).status_code == 204
    assert client.get("/api/settings/favorites").json() == ["rsi"]
    res = client.patch("/api/settings", json={"theme": "dark", "favorites": None, "n": 3})
    assert res.json() == {"theme": "dark", "n": 3}
    assert client.get("/api/settings/favorites").status_code == 404
    assert client.put("/api/settings/bad key", json={"value": 1}).status_code == 422
    assert client.put("/api/settings/k", json={"value": None}).status_code == 422
    assert client.patch("/api/settings", json={"bad key": 1}).status_code == 422
    assert client.patch("/api/settings", json={"k": "x" * 600_000}).status_code == 422
    assert client.delete("/api/settings/theme").status_code == 204
    assert client.delete("/api/settings/theme").status_code == 204
    assert client.get("/api/settings").json() == {"n": 3}


# -------------------------------------------------------------------- notes


def test_notes(client: TestClient) -> None:
    general = client.post("/api/notes", json={"text": "hello"}).json()
    assert general["symbol"] is None and general["revision"] == 1
    sym = client.post("/api/notes", json={"symbol": " aapl ", "text": "buy"}).json()
    assert sym["symbol"] == "AAPL"
    assert [n["id"] for n in client.get("/api/notes", params={"symbol": "aapl"}).json()] == [
        sym["id"]
    ]
    assert len(client.get("/api/notes").json()) == 2

    res = client.put(f"/api/notes/{general['id']}", json={"text": "v2", "revision": 1})
    assert res.status_code == 200 and res.json()["revision"] == 2
    res = client.put(f"/api/notes/{general['id']}", json={"text": "stale", "revision": 1})
    assert res.status_code == 409 and res.json()["detail"]["current"]["text"] == "v2"
    res = client.put(f"/api/notes/{general['id']}", json={"text": "forced"})
    assert res.status_code == 200 and res.json()["revision"] == 3
    assert client.get(f"/api/notes/{general['id']}").json()["text"] == "forced"
    assert client.post("/api/notes", json={"text": "x" * 200_001}).status_code == 422
    assert client.delete(f"/api/notes/{sym['id']}").status_code == 204
    assert client.get(f"/api/notes/{sym['id']}").status_code == 404


# ------------------------------------------------------------ import/export


def seed(client: TestClient) -> None:
    lay = client.post("/api/layouts", json={"name": "L", "state": STATE}).json()
    client.put("/api/layouts/last-used", json={"id": lay["id"]})
    batch(client, upserts=[{"drawing": drawing("d1")}, {"drawing": drawing("s1", scope="all")}])
    client.post("/api/indicator-templates", json={"name": "I", "instances": [{"type": "sma"}]})
    client.post(
        "/api/drawing-templates",
        json={"toolType": "ray", "name": "R", "style": {"a": 1}, "isDefault": True},
    )
    client.post("/api/chart-templates", json={"name": "C", "data": {"bg": "#111"}})
    client.patch("/api/settings", json={"favorites": ["sma"], "ui": {"x": 1}})
    client.post("/api/notes", json={"text": "note", "symbol": "AAPL"})


def strip_volatile(bundle: dict[str, Any]) -> dict[str, Any]:
    out = dict(bundle)
    out.pop("exportedAt")
    for key in ("layouts", "drawings", "indicatorTemplates", "drawingTemplates",
                "chartTemplates", "notes"):  # fmt: skip
        out[key] = [
            {k: v for k, v in x.items() if k not in ("updatedAt", "revision")} for x in out[key]
        ]
    return out


def test_export_import_round_trip(client: TestClient, tmp_path: Path) -> None:
    seed(client)
    bundle = client.get("/api/export").json()
    assert bundle["version"] == 1 and bundle["app"] == "investopen"
    assert len(bundle["layouts"]) == 1 and bundle["layouts"][0]["isLastUsed"] is True
    assert {d["id"] for d in bundle["drawings"]} == {"d1", "s1"}
    assert bundle["settings"] == {"favorites": ["sma"], "ui": {"x": 1}}

    # Into an empty instance: everything is created, and exports match.
    app2 = create_app(provider=NullProvider(), database_url=f"sqlite:///{tmp_path}/other.db")
    with TestClient(app2) as c2:
        res = c2.post("/api/import", json=bundle)
        assert res.status_code == 200
        summary = res.json()
        assert summary["mode"] == "merge" and summary["dryRun"] is False
        assert summary["drawings"] == {"created": 2, "updated": 0, "deleted": 0}
        assert summary["settings"]["created"] == 2
        again = c2.get("/api/export").json()
        assert strip_volatile(again) == strip_volatile(bundle)
        assert c2.get("/api/layouts/last-used").json()["id"] == bundle["layouts"][0]["id"]

    # Merge into itself: everything matches and is updated (revisions bumped).
    res = client.post("/api/import", json=bundle).json()
    assert res["layouts"] == {"created": 0, "updated": 1, "deleted": 0}
    assert res["drawingTemplates"]["updated"] == 1
    assert client.get("/api/layouts").json()[0]["revision"] == 2


def test_import_dry_run_and_replace(client: TestClient) -> None:
    seed(client)
    bundle = client.get("/api/export").json()
    client.post("/api/layouts", json={"name": "Extra", "state": STATE})
    client.post("/api/notes", json={"text": "extra"})

    small = {**bundle, "drawings": bundle["drawings"][:1], "notes": []}
    res = client.post("/api/import", params={"mode": "replace", "dryRun": True}, json=small)
    assert res.status_code == 200
    summary = res.json()
    assert summary["dryRun"] is True
    assert summary["layouts"] == {"created": 1, "updated": 0, "deleted": 2}
    assert summary["notes"] == {"created": 0, "updated": 0, "deleted": 2}
    assert len(client.get("/api/layouts").json()) == 2  # rolled back

    res = client.post("/api/import", params={"mode": "replace"}, json=small)
    assert res.status_code == 200
    assert len(client.get("/api/layouts").json()) == 1
    assert client.get("/api/notes").json() == []
    assert len(client.get("/api/drawings").json()["drawings"]) == 1
    assert client.get("/api/layouts/last-used").json() is not None


def test_import_validation(client: TestClient) -> None:
    def status(body: dict[str, Any], **params: Any) -> int:
        return int(client.post("/api/import", params=params, json=body).status_code)

    assert status({"version": 2}) == 422
    assert status({"version": 1, "app": "other"}) == 422
    assert status({"version": 1}, mode="wipe") == 422
    assert status({"version": 1, "drawings": [{"data": {"id": "x"}}]}) == 422
    dup = {"id": "a", "name": "n", "state": {}}
    assert status({"version": 1, "layouts": [dup, dup]}) == 422
    assert status({"version": 1, "settings": {"bad key": 1}}) == 422
    assert status({"version": 1}) == 200


# ---------------------------------------------------------------- migration


def alembic_config(url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(Path(models.__file__).parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


USER_TABLES = {
    "layouts",
    "drawings",
    "indicator_templates",
    "drawing_templates",
    "chart_templates",
    "settings",
    "notes",
}


def test_migration_upgrade_downgrade(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path}/m.db"
    cfg = alembic_config(url)
    engine = create_engine(url)
    command.upgrade(cfg, "head")
    tables = set(inspect(engine).get_table_names())
    assert tables >= USER_TABLES and "bars" in tables
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == [], diff

    command.downgrade(cfg, "ab134c579451")
    tables = set(inspect(engine).get_table_names())
    assert not tables & USER_TABLES and "bars" in tables
    command.upgrade(cfg, "head")
    assert set(inspect(engine).get_table_names()) >= USER_TABLES
    engine.dispose()
