"""`/api/backups`: admin-only, runs, listing, download, restore staging and upload.

Apps come from `make_client` (database `<tmp_path>/a0.db`, so the data folder is `tmp_path`);
S3 is the in-memory fake of test_backups. Restores are only ever *staged* here; applying is
covered in test_backups_restore.py.
"""

import hashlib
import json
import sqlite3
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from multiuser import Multi
from multiuser import _build as _build_multi
from pydantic import SecretStr
from test_backups import PASSPHRASE, S3_KEY_ID, S3_SECRET, FakeS3, gunzip

from tickerglass_api.backups import restore
from tickerglass_api.backups.runner import BackupService

UPLOAD_HEADER = "X-TickerGlass-Request"


def _build(make_client: Callable[..., TestClient], **settings: str) -> Multi:
    """The `multiuser` app; the owner's client sends the upload header (see
    `test_upload_needs_the_request_header`)."""
    multi = _build_multi(make_client, **settings)
    multi.owner.headers[UPLOAD_HEADER] = "1"
    return multi


S3_ENV = {
    "backup_s3_endpoint": "http://minio:9000",
    "backup_s3_bucket": "tg",
    "backup_s3_access_key_id": S3_KEY_ID,
    "backup_s3_secret_access_key": S3_SECRET,
}


@pytest.fixture
def mu(make_client: Callable[..., TestClient], tmp_path: Path) -> Multi:
    """Owner (admin) + alice + bob, with a local backup target."""
    return _build(make_client, backup_dir=str(tmp_path / "bk"))


def leftovers(data: Path) -> list[Path]:
    work = data / "backups-tmp"
    return list(work.iterdir()) if work.exists() else []


def service_of(client: TestClient) -> BackupService:
    svc: BackupService = client.app.state.backups  # type: ignore[attr-defined]
    return svc


def run_backup(client: TestClient) -> dict[str, Any]:
    res = client.post("/api/backups/run")
    assert res.status_code == 202, res.text
    service_of(client).join(60)
    run = client.get(f"/api/backups/runs/{res.json()['runId']}").json()
    assert run["status"] in ("ok", "partial"), run
    return run  # type: ignore[no-any-return]


# ---------------------------------------------------------------- admin only

ROUTES: list[tuple[str, str, dict[str, Any]]] = [
    ("GET", "/api/backups", {}),
    ("POST", "/api/backups/run", {}),
    ("GET", "/api/backups/runs/1", {}),
    ("POST", "/api/backups/test", {}),
    ("POST", "/api/backups/restore", {"json": {"target": "local", "name": "x"}}),
    ("POST", "/api/backups/restore/upload", {"files": {"file": ("a.db", b"x")}}),
    ("DELETE", "/api/backups/restore", {}),
    ("GET", "/api/backups/files/local/tickerglass-20261113T033000Z.db.gz", {}),
]


@pytest.mark.parametrize(("method", "path", "kw"), ROUTES)
def test_every_route_is_admin_only(mu: Multi, method: str, path: str, kw: dict[str, Any]) -> None:
    for user in (mu.alice, mu.bob):
        assert user.request(method, path, **kw).status_code == 403
    anonymous = mu.new_client()
    assert anonymous.request(method, path, **kw).status_code == 401
    # Nothing was started or staged by the refused requests.
    assert mu.owner.get("/api/backups").json()["runs"] == []
    assert mu.owner.get("/api/backups").json()["pending"] is None


def test_open_mode_has_an_owner_admin(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    client = make_client(backup_dir=str(tmp_path / "bk"))
    assert client.get("/api/backups").status_code == 200


def test_server_status_shows_a_backup_block_to_admins_only(mu: Multi) -> None:
    body = mu.owner.get("/api/server/status").json()
    assert body["backup"] == {"enabled": True, "lastStatus": None, "lastAt": None, "pending": None}
    assert "backup" not in mu.alice.get("/api/server/status").json()
    run_backup(mu.owner)
    block = mu.owner.get("/api/server/status").json()["backup"]
    assert block["lastStatus"] == "ok" and block["lastAt"]


# ------------------------------------------------------------------- status


def test_status_shape_before_any_run(mu: Multi, tmp_path: Path) -> None:
    body = mu.owner.get("/api/backups").json()
    assert body["enabled"] is True and body["supported"] is True
    assert body["schedule"]["at"] == "03:30" and body["schedule"]["tz"] == "UTC"
    assert body["schedule"]["next"]
    assert [(t["kind"], t["configured"]) for t in body["targets"]] == [
        ("local", True),
        ("s3", False),
    ]
    assert body["targets"][0]["label"] == str(tmp_path / "bk")
    assert "same disk" in body["targets"][0]["warning"]
    assert body["encrypted"] is False and body["last"] is None and body["runs"] == []
    assert body["files"] == [] and body["pending"] is None and body["running"] is False
    assert body["retention"] == {"daily": 7, "weekly": 4, "monthly": 6}
    assert body["fileErrors"] == [] and body["lastRestore"] is None


def test_status_without_a_target_is_disabled(make_client: Callable[..., TestClient]) -> None:
    body = make_client().get("/api/backups").json()
    assert body["enabled"] is False and body["schedule"]["next"] is None
    assert [t["configured"] for t in body["targets"]] == [False, False]
    assert make_client().post("/api/backups/run").status_code == 409


def test_unsupported_database_reports_supported_false(mu: Multi) -> None:
    """Postgres: a clear status, 501 on every action (`db_path` is None there too)."""
    service_of(mu.owner).db_path = None
    body = mu.owner.get("/api/backups").json()
    assert body["supported"] is False and body["enabled"] is False
    assert body["targets"] == [] and body["files"] == [] and body["pending"] is None
    for method, path, kw in ROUTES:
        if path.endswith("/runs/1") or "/files/" in path or method == "GET":
            continue
        res = mu.owner.request(method, path, **kw)
        assert res.status_code == 501, (method, path, res.text)
        assert "pg_dump" in res.json()["detail"]
    assert (
        mu.owner.get("/api/backups/files/local/tickerglass-20261113T033000Z.db.gz").status_code
        == 501
    )


# --------------------------------------------------------------------- runs


def test_run_now_then_list_and_download(mu: Multi, tmp_path: Path) -> None:
    run = run_backup(mu.owner)
    assert run["trigger"] == "manual" and run["fileName"].endswith(".db.gz")
    assert run["results"] == [{"target": "local", "ok": True, "error": None, "deleted": 0}]
    assert set(run) == {
        "id",
        "startedAt",
        "finishedAt",
        "trigger",
        "status",
        "fileName",
        "size",
        "results",
        "error",
    }
    body = mu.owner.get("/api/backups").json()
    assert body["last"]["id"] == run["id"] and body["runs"][0]["id"] == run["id"]
    (entry,) = body["files"]
    assert entry["target"] == "local" and entry["name"] == run["fileName"]
    assert entry["size"] == run["size"] and entry["encrypted"] is False and entry["createdAt"]
    res = mu.owner.get(f"/api/backups/files/local/{run['fileName']}")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/octet-stream"
    assert (
        hashlib.sha256(res.content).hexdigest()
        == json.loads((tmp_path / "bk" / run["fileName"].replace(".db.gz", ".json")).read_text())[
            "sha256"
        ]
    )
    out = tmp_path / "dl.db.gz"
    out.write_bytes(res.content)
    con = sqlite3.connect(gunzip(out, tmp_path / "dl.db"))
    assert con.execute("SELECT count(*) FROM users").fetchone()[0] >= 3  # every user's data
    con.close()


def test_unknown_run_is_404(mu: Multi) -> None:
    assert mu.owner.get("/api/backups/runs/999").status_code == 404
    assert mu.owner.get("/api/backups/runs/abc").status_code == 422


def test_second_run_while_one_is_running_is_409(mu: Multi, monkeypatch: pytest.MonkeyPatch) -> None:
    svc = service_of(mu.owner)
    started, proceed = threading.Event(), threading.Event()
    real = svc._work

    def slow() -> dict[str, Any]:
        started.set()
        proceed.wait(10)
        return real()

    monkeypatch.setattr(svc, "_work", slow)
    first = mu.owner.post("/api/backups/run")
    assert first.status_code == 202
    assert started.wait(10)
    assert mu.owner.get("/api/backups").json()["running"] is True
    assert mu.owner.get(f"/api/backups/runs/{first.json()['runId']}").json()["status"] == "running"
    again = mu.owner.post("/api/backups/run")
    assert again.status_code == 409 and "already running" in again.json()["detail"]
    proceed.set()
    svc.join(60)
    assert mu.owner.get(f"/api/backups/runs/{first.json()['runId']}").json()["status"] == "ok"
    assert mu.owner.post("/api/backups/run").status_code == 202  # free again
    svc.join(60)


def test_test_endpoint_reports_each_target(
    make_client: Callable[..., TestClient], tmp_path: Path, fake_s3: type[FakeS3]
) -> None:
    mu = _build(make_client, backup_dir=str(tmp_path / "bk"), **S3_ENV)
    res = mu.owner.post("/api/backups/test")
    assert res.status_code == 200
    kinds = {t["kind"]: t for t in res.json()["targets"]}
    assert kinds["local"]["ok"] and kinds["s3"]["ok"] and kinds["s3"]["error"] is None
    fake_s3.fail = {"head": "NoSuchBucket"}
    kinds = {t["kind"]: t for t in mu.owner.post("/api/backups/test").json()["targets"]}
    assert kinds["s3"]["ok"] is False and kinds["s3"]["error"] == "S3 NoSuchBucket"
    assert S3_SECRET not in json.dumps(kinds)


# ------------------------------------------------------------------- s3


def test_s3_download_leaves_no_temp_file_even_if_the_client_walks_away(
    make_client: Callable[..., TestClient], fake_s3: type[FakeS3], tmp_path: Path
) -> None:
    mu = _build(make_client, **S3_ENV)
    run = run_backup(mu.owner)
    path = f"/api/backups/files/s3/{run['fileName']}"
    stored = fake_s3.objects["tickerglass/" + run["fileName"]]
    # The client reads the headers and disconnects: nothing is left, and nothing was ever
    # waiting for a background task that a disconnect skips.
    with mu.owner.stream("GET", path) as res:
        assert res.status_code == 200
        assert f'filename="{run["fileName"]}"' in res.headers["content-disposition"]
        assert leftovers(tmp_path) == []
    assert leftovers(tmp_path) == []
    full = mu.owner.get(path)
    assert full.content == stored and leftovers(tmp_path) == []


def test_s3_run_list_and_download(
    make_client: Callable[..., TestClient], fake_s3: type[FakeS3]
) -> None:
    mu = _build(make_client, **S3_ENV)
    run = run_backup(mu.owner)
    assert [r["target"] for r in run["results"]] == ["s3"]
    (entry,) = mu.owner.get("/api/backups").json()["files"]
    assert entry["target"] == "s3"
    res = mu.owner.get(f"/api/backups/files/s3/{entry['name']}")
    assert res.status_code == 200 and res.content == fake_s3.objects["tickerglass/" + entry["name"]]
    # A failing listing shows up as an error, not a failed page.
    fake_s3.fail = {"list": "AccessDenied"}
    body = mu.owner.get("/api/backups").json()
    assert body["files"] == [] and body["fileErrors"] == [
        {"target": "s3", "error": "S3 AccessDenied"}
    ]
    fake_s3.fail = {"get": "AccessDenied"}
    assert mu.owner.get(f"/api/backups/files/s3/{entry['name']}").status_code == 502
    fake_s3.fail = {}
    missing = mu.owner.get("/api/backups/files/s3/tickerglass-20200101T000000Z.db.gz")
    assert missing.status_code == 404


def test_secrets_never_appear_in_responses(
    make_client: Callable[..., TestClient], tmp_path: Path, fake_s3: type[FakeS3]
) -> None:
    mu = _build(
        make_client, backup_dir=str(tmp_path / "bk"), backup_passphrase=PASSPHRASE, **S3_ENV
    )
    fake_s3.fail = {"put": "AccessDenied"}
    run_backup(mu.owner)
    fake_s3.fail = {}
    fake_s3.fail = {"head": "AccessDenied"}
    blobs = [
        mu.owner.get("/api/backups").text,
        mu.owner.post("/api/backups/test").text,
        mu.owner.get("/api/server/status").text,
        mu.owner.get("/api/backups/runs/1").text,
        mu.owner.post("/api/backups/restore", json={"target": "local", "name": "../../x"}).text,
        mu.owner.post(
            "/api/backups/restore",
            json={"target": "s3", "name": "tickerglass-20200101T000000Z.db.gz.enc"},
        ).text,
    ]
    for blob in blobs:
        for secret in (S3_SECRET, PASSPHRASE, S3_KEY_ID):
            assert secret not in blob
    assert '"encrypted":true' in blobs[0].replace(" ", "")


# ------------------------------------------------------------------ restore


def test_restore_from_a_local_backup_stages_it_and_can_be_cancelled(
    mu: Multi, tmp_path: Path
) -> None:
    run = run_backup(mu.owner)
    res = mu.owner.post("/api/backups/restore", json={"target": "local", "name": run["fileName"]})
    assert res.status_code == 200, res.text
    pending = res.json()["pending"]
    assert pending["source"] == f"local:{run['fileName']}" and pending["revision"]
    assert pending["stagedAt"]
    assert mu.owner.get("/api/backups").json()["pending"] == pending
    assert mu.owner.get("/api/server/status").json()["backup"]["pending"] == pending
    assert (tmp_path / restore.PENDING_DB).exists()
    # The live database is untouched by staging.
    assert mu.owner.get("/api/server/status").status_code == 200
    assert mu.owner.delete("/api/backups/restore").json() == {"cancelled": True}
    assert mu.owner.get("/api/backups").json()["pending"] is None
    assert not (tmp_path / restore.PENDING_DB).exists()
    assert mu.owner.delete("/api/backups/restore").json() == {"cancelled": False}


@pytest.mark.parametrize(
    "name",
    [
        "../a0.db",
        "../../etc/passwd",
        "..%2F..%2Fetc%2Fpasswd",
        "tickerglass-20261113T033000Z.db.gz/../../a0.db",
        "/etc/passwd",
        "sub/tickerglass-20261113T033000Z.db.gz",
        "tickerglass-20261113T033000Z.json",
        "a0.db",
        "",
        "tickerglass-20261113T033000Z.db.gz\x00.db",
    ],
)
def test_restore_name_traversal_is_a_400(mu: Multi, tmp_path: Path, name: str) -> None:
    (tmp_path / "bk").mkdir(exist_ok=True)
    res = mu.owner.post("/api/backups/restore", json={"target": "local", "name": name})
    assert res.status_code == 400, res.text
    assert res.json()["detail"] == "invalid backup name"
    assert restore.pending_info(tmp_path) is None


def test_restore_unknown_target_and_missing_file(mu: Multi) -> None:
    bad = mu.owner.post(
        "/api/backups/restore", json={"target": "ftp", "name": "tickerglass-20261113T033000Z.db.gz"}
    )
    assert bad.status_code == 422
    s3 = mu.owner.post(
        "/api/backups/restore", json={"target": "s3", "name": "tickerglass-20261113T033000Z.db.gz"}
    )
    assert s3.status_code == 404 and "not configured" in s3.json()["detail"]
    gone = mu.owner.post(
        "/api/backups/restore",
        json={"target": "local", "name": "tickerglass-20200101T000000Z.db.gz"},
    )
    assert gone.status_code == 404


def test_restore_of_a_damaged_backup_is_refused(mu: Multi, tmp_path: Path) -> None:
    bk = tmp_path / "bk"
    bk.mkdir()
    name = "tickerglass-20260101T000000Z.db.gz"
    (bk / name).write_bytes(b"\x1f\x8b" + b"garbage" * 30)
    res = mu.owner.post("/api/backups/restore", json={"target": "local", "name": name})
    assert res.status_code == 400 and "damaged" in res.json()["detail"]
    assert mu.owner.get("/api/backups").json()["pending"] is None


def test_restore_of_an_encrypted_backup_uses_the_configured_passphrase(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    mu = _build(make_client, backup_dir=str(tmp_path / "bk"), backup_passphrase=PASSPHRASE)
    run = run_backup(mu.owner)
    assert run["fileName"].endswith(".enc")
    ok = mu.owner.post("/api/backups/restore", json={"target": "local", "name": run["fileName"]})
    assert ok.status_code == 200
    mu.owner.delete("/api/backups/restore")
    service_of(mu.owner).settings = service_of(mu.owner).settings.model_copy(
        update={"backup_passphrase": SecretStr("a different passphrase")}
    )
    bad = mu.owner.post("/api/backups/restore", json={"target": "local", "name": run["fileName"]})
    assert bad.status_code == 400 and "wrong passphrase" in bad.json()["detail"]
    assert mu.owner.get("/api/backups").json()["pending"] is None
    service_of(mu.owner).settings = service_of(mu.owner).settings.model_copy(
        update={"backup_passphrase": None}
    )
    none = mu.owner.post("/api/backups/restore", json={"target": "local", "name": run["fileName"]})
    assert none.status_code == 400 and "encrypted" in none.json()["detail"]


# ------------------------------------------------------------------- upload


def backup_bytes(mu: Multi, tmp_path: Path) -> bytes:
    run = run_backup(mu.owner)
    return (tmp_path / "bk" / run["fileName"]).read_bytes()


def test_upload_needs_the_request_header(mu: Multi, tmp_path: Path) -> None:
    """A multipart POST is a "simple" cross-site request: only a custom header makes a browser
    preflight it, so the route insists on one."""
    data = backup_bytes(mu, tmp_path)
    files = {"file": ("my.db.gz", data)}
    del mu.owner.headers[UPLOAD_HEADER]
    res = mu.owner.post("/api/backups/restore/upload", files=files)
    assert res.status_code == 403 and UPLOAD_HEADER in res.json()["detail"]
    wrong = mu.owner.post(
        "/api/backups/restore/upload", files=files, headers={UPLOAD_HEADER: "yes"}
    )
    assert wrong.status_code == 403
    assert restore.pending_info(tmp_path) is None and leftovers(tmp_path) == []
    ok = mu.owner.post("/api/backups/restore/upload", files=files, headers={UPLOAD_HEADER: "1"})
    assert ok.status_code == 200, ok.text


def test_upload_stages_a_backup(mu: Multi, tmp_path: Path) -> None:
    data = backup_bytes(mu, tmp_path)
    res = mu.owner.post(
        "/api/backups/restore/upload", files={"file": ("my.db.gz", data, "application/gzip")}
    )
    assert res.status_code == 200, res.text
    assert res.json()["pending"]["source"] == "upload"
    assert restore.pending_info(tmp_path) is not None
    assert leftovers(tmp_path) == []  # upload copy removed
    # A raw database file works too.
    mu.owner.delete("/api/backups/restore")
    raw = tmp_path / "raw.db"
    gunzip_to = tmp_path / "raw.db.gz"
    gunzip_to.write_bytes(data)
    gunzip(gunzip_to, raw)
    res = mu.owner.post("/api/backups/restore/upload", files={"file": ("a.db", raw.read_bytes())})
    assert res.status_code == 200, res.text


def test_upload_of_an_encrypted_backup_takes_the_passphrase_from_the_request(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    mu = _build(make_client, backup_dir=str(tmp_path / "bk"), backup_passphrase=PASSPHRASE)
    data = backup_bytes(mu, tmp_path)
    # The upload may come from another install: no server passphrase.
    service_of(mu.owner).settings = service_of(mu.owner).settings.model_copy(
        update={"backup_passphrase": None}
    )
    none = mu.owner.post("/api/backups/restore/upload", files={"file": ("a.enc", data)})
    assert none.status_code == 400 and "encrypted" in none.json()["detail"]
    wrong = mu.owner.post(
        "/api/backups/restore/upload",
        files={"file": ("a.enc", data)},
        data={"passphrase": "not the passphrase!!"},
    )
    assert wrong.status_code == 400 and "wrong passphrase" in wrong.json()["detail"]
    assert "not the passphrase" not in wrong.text
    assert restore.pending_info(tmp_path) is None
    assert leftovers(tmp_path) == []
    good = mu.owner.post(
        "/api/backups/restore/upload",
        files={"file": ("a.enc", data)},
        data={"passphrase": PASSPHRASE},
    )
    assert good.status_code == 200, good.text
    assert PASSPHRASE not in good.text


def test_upload_size_limit(make_client: Callable[..., TestClient], tmp_path: Path) -> None:
    mu = _build(make_client, backup_dir=str(tmp_path / "bk"), backup_upload_max_mb=1)
    big = b"x" * (2 << 20)
    res = mu.owner.post("/api/backups/restore/upload", files={"file": ("a.db.gz", big)})
    assert res.status_code == 413
    assert restore.pending_info(tmp_path) is None
    assert leftovers(tmp_path) == []
    # Without a Content-Length header the limit is still enforced while streaming.
    stream = mu.owner.post(
        "/api/backups/restore/upload",
        content=iter([_multipart_head(), big[: 1 << 20], big[: 1 << 20], b"\r\n--BOUND--\r\n"]),
        headers={"content-type": "multipart/form-data; boundary=BOUND"},
    )
    assert stream.status_code == 413
    assert leftovers(tmp_path) == []


def _multipart_head() -> bytes:
    return (
        b'--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.gz"\r\n'
        b"Content-Type: application/octet-stream\r\n\r\n"
    )


def test_upload_rejects_malformed_requests(mu: Multi, tmp_path: Path) -> None:
    owner = mu.owner
    assert owner.post("/api/backups/restore/upload", json={"a": 1}).status_code == 400
    assert owner.post("/api/backups/restore/upload", data={"passphrase": "x"}).status_code == 400
    no_file = owner.post(
        "/api/backups/restore/upload",
        content=b'--B\r\nContent-Disposition: form-data; name="passphrase"\r\n\r\nx\r\n--B--\r\n',
        headers={"content-type": "multipart/form-data; boundary=B"},
    )
    assert no_file.status_code == 400 and "no file" in no_file.json()["detail"]
    truncated = owner.post(
        "/api/backups/restore/upload",
        content=_multipart_head() + b"abc",
        headers={"content-type": "multipart/form-data; boundary=BOUND"},
    )
    assert truncated.status_code == 400
    two = owner.post(
        "/api/backups/restore/upload",
        files=[("file", ("a", b"1")), ("file", ("b", b"2"))],
    )
    assert two.status_code == 400
    junk = owner.post("/api/backups/restore/upload", files={"file": ("a.db", b"not a database")})
    assert junk.status_code == 400 and "not a TickerGlass backup" in junk.json()["detail"]
    assert restore.pending_info(tmp_path) is None
    assert leftovers(tmp_path) == []


def test_upload_is_not_applied_until_restart(mu: Multi, tmp_path: Path) -> None:
    """Staging never touches the live database file."""
    before = (tmp_path / "a0.db").stat().st_mtime_ns
    data = backup_bytes(mu, tmp_path)
    mu.owner.post("/api/backups/restore/upload", files={"file": ("a.db.gz", data)})
    assert mu.owner.get("/api/backups").json()["pending"] is not None
    assert (tmp_path / "a0.db").exists()
    assert not list(tmp_path.glob("pre-restore-*"))
    assert before <= (tmp_path / "a0.db").stat().st_mtime_ns  # only normal app writes


# ------------------------------------------------------------- download names


@pytest.mark.parametrize(
    "path",
    [
        "/api/backups/files/local/notes.txt",
        "/api/backups/files/local/..%2Fa0.db",
        "/api/backups/files/local/tickerglass-20261113T033000Z.json",
        "/api/backups/files/ftp/tickerglass-20261113T033000Z.db.gz",
        "/api/backups/files/s3/tickerglass-20261113T033000Z.db.gz",
    ],
)
def test_download_refuses_foreign_names_and_targets(mu: Multi, tmp_path: Path, path: str) -> None:
    (tmp_path / "bk").mkdir(exist_ok=True)
    (tmp_path / "bk" / "notes.txt").write_text("private")
    res = mu.owner.get(path)
    assert res.status_code in (400, 404)
    assert "private" not in res.text


def test_legacy_download_endpoint_still_works(mu: Multi, tmp_path: Path) -> None:
    res = mu.owner.get("/api/server/backup")
    assert res.status_code == 200 and res.headers["content-type"].startswith(
        "application/x-sqlite3"
    )
    assert res.content.startswith(b"SQLite format 3\x00")
