"""Saved screener screens: CRUD with revisions, spec/alert validation, presets, bundle."""

from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from test_userdata import NullProvider

from tickerglass_api import models as m
from tickerglass_api.app import create_app
from tickerglass_api.services.screener.presets import PRESETS
from tickerglass_api.userdata import screens as sc

SPEC: dict[str, Any] = {
    "schemaVersion": 1,
    "universe": {"kind": "class", "cls": "stocks"},
    "filter": {"op": "and", "rules": [{"field": "rsi14", "op": "<", "value": 30}]},
    "sort": {"field": "rsi14", "dir": "asc"},
}
ALERT = {"enabled": True, "notify": {"webhook": False, "telegram": False, "email": False}}


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(provider=NullProvider(), database_url=f"sqlite:///{tmp_path}/s.db")
    with TestClient(app) as c:
        yield c


def make(client: TestClient, name: str = "S", **kw: Any) -> Any:
    res = client.post("/api/screener/screens", json={"name": name, "spec": SPEC, **kw})
    assert res.status_code == 201, res.text
    return res.json()


def test_crud_round_trip(client: TestClient) -> None:
    assert client.get("/api/screener/screens").json() == []
    created = make(client, " Oversold ")
    assert created["name"] == "Oversold" and created["revision"] == 1
    assert created["spec"] == SPEC and created["alert"] is None
    assert {"createdAt", "updatedAt"} <= set(created)
    sid = created["id"]
    assert client.get(f"/api/screener/screens/{sid}").json() == created
    assert client.get("/api/screener/screens").json() == [created]

    spec2 = {**SPEC, "sort": {"field": "mcap", "dir": "desc"}, "columns": ["last", "rsi14"]}
    res = client.put(
        f"/api/screener/screens/{sid}",
        json={"name": "Two", "spec": spec2, "alert": ALERT, "revision": 1},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["revision"] == 2 and body["name"] == "Two" and body["spec"] == spec2
    assert body["alert"] == ALERT and body["createdAt"] == created["createdAt"]

    assert client.delete(f"/api/screener/screens/{sid}").status_code == 204
    assert client.delete(f"/api/screener/screens/{sid}").status_code == 404
    assert client.get(f"/api/screener/screens/{sid}").status_code == 404
    put = client.put(f"/api/screener/screens/{sid}", json={"name": "x", "spec": SPEC})
    assert put.status_code == 404
    assert client.patch(f"/api/screener/screens/{sid}", json={"name": "x"}).status_code == 404


def test_filter_null_and_columns_are_stored_normalized(client: TestClient) -> None:
    spec = {"schemaVersion": 1, "universe": {"kind": "symbols", "symbols": [" aapl "]},
            "filter": None, "sort": {"field": "last", "dir": "desc"}}  # fmt: skip
    out = make(client, spec=spec)
    assert out["spec"]["filter"] is None and "columns" not in out["spec"]
    assert out["spec"]["universe"]["symbols"] == ["AAPL"]


def test_post_with_client_id_conflicts_on_reuse(client: TestClient) -> None:
    first = make(client, "A", id="client-id_1")
    assert first["id"] == "client-id_1"
    res = client.post(
        "/api/screener/screens", json={"id": "client-id_1", "name": "B", "spec": SPEC}
    )
    assert res.status_code == 409
    assert res.json()["detail"]["current"] == first
    assert client.get("/api/screener/screens/client-id_1").json()["name"] == "A"
    for bad in ("a/b", "x" * 37, "", "a b"):
        res = client.post("/api/screener/screens", json={"id": bad, "name": "B", "spec": SPEC})
        assert res.status_code == 422, bad


def test_put_and_patch_stale_revision(client: TestClient) -> None:
    sid = make(client)["id"]
    url = f"/api/screener/screens/{sid}"
    ok = client.put(url, json={"name": "v2", "spec": SPEC, "revision": 1})
    assert ok.status_code == 200
    stale = client.put(url, json={"name": "stale", "spec": SPEC, "revision": 1})
    assert stale.status_code == 409
    current = stale.json()["detail"]["current"]
    assert current["revision"] == 2 and current["name"] == "v2"
    stale_patch = client.patch(url, json={"name": "stale", "revision": 1})
    assert stale_patch.status_code == 409
    assert stale_patch.json()["detail"]["current"]["name"] == "v2"
    assert client.get(url).json()["name"] == "v2"
    forced = client.put(url, json={"name": "forced", "spec": SPEC})
    assert forced.status_code == 200 and forced.json()["revision"] == 3


def test_patch_changes_only_given_keys(client: TestClient) -> None:
    sid = make(client, alert=ALERT)["id"]
    url = f"/api/screener/screens/{sid}"
    renamed = client.patch(url, json={"name": "New", "revision": 1}).json()
    assert renamed["name"] == "New" and renamed["alert"] == ALERT and renamed["spec"] == SPEC
    assert renamed["revision"] == 2
    off = client.patch(url, json={"alert": None}).json()
    assert off["alert"] is None and off["name"] == "New" and off["revision"] == 3
    spec2 = {**SPEC, "sort": {"field": "last", "dir": "asc"}}
    assert client.patch(url, json={"spec": spec2}).json()["spec"] == spec2


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: {**s, "schemaVersion": 2},
        lambda s: {k: v for k, v in s.items() if k != "sort"},
        lambda s: {**s, "extra": 1},
        lambda s: {**s, "universe": {"kind": "class", "cls": "bonds"}},
        lambda s: {**s, "sort": {"field": "nope", "dir": "asc"}},
        lambda s: {**s, "sort": {"field": "last", "dir": "up"}},
        lambda s: {
            **s,
            "filter": {"op": "and", "rules": [{"field": "nope", "op": ">", "value": 1}]},
        },
        lambda s: {
            **s,
            "filter": {"op": "and", "rules": [{"field": "rsi14", "op": "~", "value": 1}]},
        },
        lambda s: {
            **s,
            "filter": {"op": "and", "rules": [{"field": "rsi14", "op": ">", "value": "x"}]},
        },
        lambda s: {**s, "columns": ["last"] * 2},
        lambda s: {**s, "columns": ["nope"]},
        lambda s: {**s, "columns": ["last"] * 41},
        lambda s: {**s, "columns": [f"c{i}" for i in range(41)]},
    ],
)
def test_invalid_specs_are_422(client: TestClient, mutate: Any) -> None:
    res = client.post("/api/screener/screens", json={"name": "S", "spec": mutate(SPEC)})
    assert res.status_code == 422, res.text
    assert client.get("/api/screener/screens").json() == []


def test_columns_cap_is_forty_known_fields(client: TestClient) -> None:
    from tickerglass_api.services.screener.fields import FIELDS

    cols = list(FIELDS)[:40]
    out = make(client, spec={**SPEC, "columns": cols})
    assert out["spec"]["columns"] == cols


def test_invalid_names_and_alerts(client: TestClient) -> None:
    def post(**kw: Any) -> int:
        body = {"name": "S", "spec": SPEC, **kw}
        return client.post("/api/screener/screens", json=body).status_code

    assert post(name="") == 422 and post(name="   ") == 422 and post(name="x" * 201) == 422
    assert post(name="x" * 200) == 201
    notify = ALERT["notify"]
    assert post(alert={"enabled": "yes", "notify": notify}) == 422
    assert post(alert={"enabled": True, "notify": {**notify, "webhook": 1}}) == 422
    assert post(alert={"enabled": True, "notify": {**notify, "sms": True}}) == 422
    assert post(alert={"enabled": True, "notify": {**notify, "webhookUrl": "ftp://x"}}) == 422
    assert post(alert={"notify": notify}) == 422
    # webhookUrl is checked by the SSRF guard like an alert's.
    private = {
        "enabled": True,
        "notify": {**notify, "webhook": True, "webhookUrl": "http://127.0.0.1/h"},
    }
    assert post(alert=private) == 422
    good = {
        "enabled": True,
        "notify": {**notify, "webhook": True, "webhookUrl": "https://example.com/h"},
    }
    res = client.post("/api/screener/screens", json={"name": "W", "spec": SPEC, "alert": good})
    assert res.status_code == 201 and res.json()["alert"] == good
    assert client.post(
        "/api/screener/screens", json={"name": "W", "spec": SPEC, "alert": {"enabled": False}}
    ).json()["alert"] == {
        "enabled": False,
        "notify": {"webhook": False, "telegram": False, "email": False},
    }


def test_screen_cap_is_200(client: TestClient) -> None:
    maker = client.app.state.sessionmaker  # type: ignore[attr-defined]
    with maker() as session:
        t = datetime.now(UTC)
        for i in range(sc.MAX_SCREENS):
            session.add(
                m.Screen(
                    id=f"s{i}",
                    name=f"S{i}",
                    spec=SPEC,
                    schema_version=1,
                    alert=None,
                    revision=1,
                    created_at=t,
                    updated_at=t,
                )  # fmt: skip
            )
        session.commit()
    res = client.post("/api/screener/screens", json={"name": "one more", "spec": SPEC})
    assert res.status_code == 422 and "200" in res.json()["detail"]


def test_presets_are_valid_specs(client: TestClient) -> None:
    res = client.get("/api/screener/presets")
    assert res.status_code == 200
    body = res.json()
    assert [p["id"] for p in body] == [
        "oversold-large-caps",
        "golden-cross-5d",
        "new-52w-highs",
        "unusual-volume",
        "above-sma200-near-high",
        "high-dividend",
    ]
    for p in body:
        assert p["name"]
        assert sc.dump_spec(sc.check_spec(p["spec"])) == p["spec"]
        saved = client.post("/api/screener/screens", json={"name": p["name"], "spec": p["spec"]})
        assert saved.status_code == 201, (p["id"], saved.text)
    assert len(PRESETS) == 6


def test_spec_change_and_alert_on_reset_the_baseline(client: TestClient) -> None:
    maker = client.app.state.sessionmaker  # type: ignore[attr-defined]
    sid = make(client, alert=ALERT)["id"]

    def seed_state() -> None:
        with maker() as session:
            session.merge(
                m.ScreenState(
                    screen_id=sid,
                    as_of=date(2026, 1, 2),
                    members=["A"],
                    updated_at=datetime.now(UTC),
                )  # type: ignore[attr-defined]  # fmt: skip
            )
            session.commit()

    def has_state() -> bool:
        with maker() as session:
            return session.get(m.ScreenState, sid) is not None

    url = f"/api/screener/screens/{sid}"
    seed_state()
    client.patch(url, json={"name": "renamed"})
    assert has_state()
    client.put(url, json={"name": "same", "spec": SPEC, "alert": ALERT})
    assert has_state()
    client.patch(url, json={"spec": {**SPEC, "sort": {"field": "last", "dir": "asc"}}})
    assert not has_state()
    seed_state()
    client.patch(url, json={"alert": {**ALERT, "enabled": False}})
    assert has_state()
    client.patch(url, json={"alert": ALERT})
    assert not has_state()
    seed_state()
    client.delete(url)
    assert not has_state()


def test_export_import_and_counts(client: TestClient) -> None:
    a = make(client, "A", id="aaa", alert=ALERT)
    b = make(client, "B", id="bbb")
    bundle = client.get("/api/export").json()
    assert [x["id"] for x in bundle["screens"]] == ["aaa", "bbb"]
    exported = bundle["screens"][0]
    assert sc.dump_spec(sc.check_spec(exported["spec"])) == SPEC  # nulls are optional keys
    assert exported["alert"]["enabled"] is True

    # merge: matches by id are overwritten (revision bumped), the rest created.
    first = {**bundle["screens"][0], "name": "A2"}
    second = {**bundle["screens"][1], "id": "ccc", "name": "C"}
    edited = {**bundle, "screens": [first, second]}
    res = client.post("/api/import", json=edited)
    assert res.status_code == 200, res.text
    assert res.json()["screens"] == {"created": 1, "updated": 1, "deleted": 0}
    got = {x["id"]: x for x in client.get("/api/screener/screens").json()}
    assert set(got) == {"aaa", "bbb", "ccc"}
    assert got["aaa"]["name"] == "A2" and got["aaa"]["revision"] == a["revision"] + 1
    assert got["bbb"]["revision"] == b["revision"]

    # replace needs the section; a bundle without it leaves screens alone.
    assert (
        client.post(
            "/api/import?mode=replace&confirm=true", json={"version": 1, "app": "tickerglass"}
        ).status_code
        == 200
    )
    assert len(client.get("/api/screener/screens").json()) == 3
    res = client.post(
        "/api/import?mode=replace&confirm=true",
        json={"version": 1, "app": "tickerglass", "screens": [bundle["screens"][1]]},
    )
    assert res.json()["screens"] == {"created": 1, "updated": 0, "deleted": 3}
    assert [x["id"] for x in client.get("/api/screener/screens").json()] == ["bbb"]

    # dry run changes nothing; invalid specs and duplicate ids are rejected.
    res = client.post("/api/import?dryRun=true", json={**bundle, "screens": bundle["screens"]})
    assert res.json()["screens"]["created"] == 1 and res.json()["dryRun"] is True
    assert len(client.get("/api/screener/screens").json()) == 1
    bad = {**bundle["screens"][0], "spec": {**SPEC, "sort": {"field": "nope", "dir": "asc"}}}
    assert client.post("/api/import", json={**bundle, "screens": [bad]}).status_code == 422
    dup = client.post("/api/import", json={**bundle, "screens": [bundle["screens"][0]] * 2})
    assert dup.status_code == 422

    status = client.get("/api/server/status").json()
    assert status["counts"]["screens"] == 1


def test_screens_in_database_count(client: TestClient) -> None:
    make(client)
    maker = client.app.state.sessionmaker  # type: ignore[attr-defined]
    with maker() as session:
        assert session.scalar(select(func.count()).select_from(m.Screen)) == 1
