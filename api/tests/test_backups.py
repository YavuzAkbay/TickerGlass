"""Scheduled backups: snapshot, targets, retention, runs, schedule (design: scheduled-backups.md).

Real SQLite files in tmp_path (migrated once, copied per test), the real crypto module, a fake S3
client behind `targets.S3Client`, injected clocks. No network.
"""

import asyncio
import gzip
import io
import json
import logging
import shutil
import sqlite3
import stat
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from tickerglass_api import models as m
from tickerglass_api.backups import retention, snapshot, targets
from tickerglass_api.backups.crypto import BackupCryptoError, decrypt_stream
from tickerglass_api.backups.instance import instance_id
from tickerglass_api.backups.naming import make_name, meta_name, parse_name
from tickerglass_api.backups.runner import (
    KEEP_RUNS,
    BackupService,
    NoTargets,
    NotSupported,
    RunInProgress,
)
from tickerglass_api.backups.s3 import S3Config, S3Error, S3Object
from tickerglass_api.backups.scheduler import BackupScheduler, next_run_at
from tickerglass_api.backups.snapshot import SnapshotError, make_snapshot
from tickerglass_api.backups.targets import (
    BackupFile,
    LocalTarget,
    NotFound,
    S3Target,
    TargetError,
)
from tickerglass_api.db import make_engine, run_migrations
from tickerglass_api.settings import Settings

NOW = datetime(2026, 11, 13, 3, 30, tzinfo=UTC)
PASSPHRASE = "correct horse battery staple"
S3_SECRET = "s3-secret-zzz-0123456789"
S3_KEY_ID = "AKIAEXAMPLEKEYID"


# ----------------------------------------------------------------- helpers


@pytest.fixture(scope="session")
def template_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A migrated database (owner user, `alembic_version` at head), copied per test."""
    path = tmp_path_factory.mktemp("template") / "tickerglass.db"
    run_migrations(f"sqlite:///{path}")
    con = sqlite3.connect(path)
    con.execute("PRAGMA journal_mode=DELETE")
    con.close()
    return path


class Env:
    """A data folder with a live database."""

    def __init__(self, root: Path, template: Path) -> None:
        self.data = root / "data"
        self.data.mkdir()
        self.db = self.data / "tickerglass.db"
        shutil.copyfile(template, self.db)
        self.url = f"sqlite:///{self.db}"
        self.backups = root / "backups"
        self.engine: Engine = make_engine(self.url)
        self.engines = [self.engine]

    def settings(self, **kw: Any) -> Settings:
        kw.setdefault("database_url", self.url)
        return Settings(_env_file=None, **kw)  # type: ignore[call-arg]

    def service(
        self, settings: Settings | None = None, *, at: datetime = NOW, owner: str | None = None
    ) -> BackupService:
        settings = settings or self.settings(backup_dir=str(self.backups))
        return BackupService(self.engine, settings, clock=lambda: at, owner=owner)

    def add_cache(self) -> None:
        with Session(self.engine) as session, session.begin():
            session.add(
                m.Bar(
                    symbol="AAPL",
                    interval="1D",
                    prepost=False,
                    ts=1,
                    open=1,
                    high=1,
                    low=1,
                    close=1,
                    adj_close=1,
                    volume=1,
                )
            )
            session.add(m.SymbolMeta(symbol="AAPL", data={"x": 1}, fetched_at=NOW))
            session.add(m.AppMeta(key="marker", value="live", updated_at=NOW))

    def counts(self, path: Path) -> dict[str, int]:
        con = sqlite3.connect(path)
        try:
            return {
                t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]  # noqa: S608
                for t in ("bars", "symbol_meta", "users", "app_meta")
            }
        finally:
            con.close()


@pytest.fixture
def env(tmp_path: Path, template_db: Path) -> Env:
    return Env(tmp_path, template_db)


class FakeS3:
    """In-memory bucket behind `targets.S3Client`; `fail` maps an operation to an S3 error code."""

    objects: dict[str, bytes] = {}
    fail: dict[str, str] = {}
    configs: list[S3Config] = []
    timeouts: list[float] = []

    def __init__(self, config: S3Config, *, timeout: float = 60.0) -> None:
        FakeS3.configs.append(config)
        FakeS3.timeouts.append(timeout)
        self._cfg = config

    def _check(self, op: str) -> None:
        if op in FakeS3.fail:
            raise S3Error(FakeS3.fail[op])

    def full_key(self, name: str) -> str:
        return self._cfg.prefix + name

    def put_object(self, key: str, fileobj: BinaryIO, size: int, sha256_hex: str) -> None:
        self._check("put")
        data = fileobj.read()
        assert len(data) == size
        import hashlib

        assert hashlib.sha256(data).hexdigest() == sha256_hex
        FakeS3.objects[key] = data

    def list_objects(self, prefix: str) -> list[S3Object]:
        self._check("list")
        return [
            S3Object(k, len(v), NOW)
            for k, v in sorted(FakeS3.objects.items())
            if k.startswith(prefix)
        ]

    def get_object(self, key: str, dst: BinaryIO) -> None:
        self._check("get")
        if key not in FakeS3.objects:
            raise S3Error("NoSuchKey")
        dst.write(FakeS3.objects[key])

    def delete_object(self, key: str) -> None:
        self._check("delete")
        FakeS3.objects.pop(key, None)

    def head_bucket(self) -> None:
        self._check("head")


@pytest.fixture
def fake_s3(monkeypatch: pytest.MonkeyPatch) -> type[FakeS3]:
    FakeS3.objects = {}
    FakeS3.fail = {}
    FakeS3.configs = []
    FakeS3.timeouts = []
    monkeypatch.setattr(targets, "S3Client", FakeS3)
    return FakeS3


def s3_settings(env: Env, **kw: Any) -> Settings:
    return env.settings(
        backup_s3_endpoint="http://minio:9000",
        backup_s3_bucket="tg",
        backup_s3_access_key_id=S3_KEY_ID,
        backup_s3_secret_access_key=S3_SECRET,
        **kw,
    )


def gunzip(path: Path, out: Path) -> Path:
    with gzip.open(path, "rb") as fin, out.open("wb") as fout:
        shutil.copyfileobj(fin, fout)
    return out


def plant(env: Env, name: str, fake_s3: type[FakeS3] | None = None) -> None:
    """An old backup of this server (its `.json` carries the instance id) in the local folder, or
    in the fake bucket when `fake_s3` is given."""
    meta = json.dumps({"instanceId": instance_id(env.engine)}).encode()
    if fake_s3 is not None:
        fake_s3.objects["tickerglass/" + name] = b"x"
        fake_s3.objects["tickerglass/" + meta_name(name)] = meta
    else:
        env.backups.mkdir(exist_ok=True)
        (env.backups / name).write_bytes(b"x")
        (env.backups / meta_name(name)).write_bytes(meta)


def file_at(day: datetime, target: str = "local") -> BackupFile:
    return BackupFile(target, make_name(day, encrypted=False), 10, day, False)


# ------------------------------------------------------------------ naming


def test_names_roundtrip_and_reject_everything_else() -> None:
    name = make_name(NOW, encrypted=False)
    assert name == "tickerglass-20261113T033000Z.db.gz"
    parsed = parse_name(name)
    assert parsed is not None and parsed.created_at == NOW and not parsed.encrypted
    enc = parse_name(make_name(NOW, encrypted=True))
    assert enc is not None and enc.encrypted
    assert meta_name(name) == "tickerglass-20261113T033000Z.json"
    assert meta_name(name + ".enc") == "tickerglass-20261113T033000Z.json"
    for bad in (
        "",
        "../tickerglass-20261113T033000Z.db.gz",
        "tickerglass-20261113T033000Z.db.gz/",
        "sub/tickerglass-20261113T033000Z.db.gz",
        "tickerglass-20261113T033000Z.json",
        "tickerglass-20261113T033000Z.db",
        "tickerglass-20261313T033000Z.db.gz",
        "tickerglass-20261113T033000Z.db.gz.enc.bak",
        "notes.txt",
    ):
        assert parse_name(bad) is None
    with pytest.raises(ValueError):
        meta_name("notes.txt")


# ---------------------------------------------------------------- snapshot


def test_snapshot_clears_the_cache_on_the_copy_only(env: Env) -> None:
    env.add_cache()
    snap = make_snapshot(
        env.db, env.data, include_cache=False, passphrase=None, app_version="1.2.3", now=NOW
    )
    assert snap.name == "tickerglass-20261113T033000Z.db.gz"
    assert snap.path.parent == env.data / "backups-tmp"
    assert not snap.encrypted and not snap.includes_cache
    out = gunzip(snap.path, env.data / "copy.db")
    counts = env.counts(out)
    assert counts["bars"] == 0 and counts["symbol_meta"] == 0
    assert counts["users"] >= 1  # user data stays
    assert counts["app_meta"] >= 1  # app_meta (cache source etc.) stays
    # The live database still has its cache.
    assert env.counts(env.db)["bars"] == 1
    # Revision recorded, checks passed, self-contained single file.
    assert snap.revision == snapshot.read_revision(out)
    assert snapshot.integrity_error(out) is None
    assert snap.metadata()["appVersion"] == "1.2.3"
    assert snap.size == snap.path.stat().st_size
    assert stat.S_IMODE(snap.path.stat().st_mode) == 0o600
    assert sqlite3.connect(out).execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    # Only the final file is left in the work folder.
    assert [p.name for p in (env.data / "backups-tmp").iterdir()] == [snap.path.name]


def test_snapshot_can_include_the_cache(env: Env) -> None:
    env.add_cache()
    snap = make_snapshot(
        env.db, env.data, include_cache=True, passphrase=None, app_version="x", now=NOW
    )
    out = gunzip(snap.path, env.data / "copy.db")
    assert env.counts(out)["bars"] == 1
    assert snap.includes_cache


def test_snapshot_integrity_failure_leaves_nothing(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(snapshot, "integrity_error", lambda _p: "integrity check failed: row 1")
    with pytest.raises(SnapshotError, match="integrity"):
        make_snapshot(
            env.db, env.data, include_cache=False, passphrase=None, app_version="x", now=NOW
        )
    assert list((env.data / "backups-tmp").iterdir()) == []


def test_snapshot_of_a_missing_database(env: Env) -> None:
    with pytest.raises(SnapshotError):
        make_snapshot(
            env.data / "nope.db",
            env.data,
            include_cache=False,
            passphrase=None,
            app_version="x",
            now=NOW,
        )


def test_snapshot_encrypted_roundtrip(env: Env) -> None:
    snap = make_snapshot(
        env.db, env.data, include_cache=False, passphrase=PASSPHRASE, app_version="x", now=NOW
    )
    assert snap.name.endswith(".db.gz.enc") and snap.encrypted
    assert snap.path.read_bytes().startswith(b"TGBK1\0")
    dec = env.data / "dec.gz"
    with snap.path.open("rb") as fin, dec.open("wb") as fout:
        decrypt_stream(fin, fout, PASSPHRASE)
    assert snapshot.integrity_error(gunzip(dec, env.data / "copy.db")) is None
    with snap.path.open("rb") as fin, pytest.raises(BackupCryptoError):
        decrypt_stream(fin, io.BytesIO(), "another passphrase!!")


def test_clean_tmp_removes_leftovers(env: Env) -> None:
    work = snapshot.tmp_dir(env.data)
    (work / "a.db").write_bytes(b"x")
    (work / "sub").mkdir()
    (work / "sub" / "b").write_bytes(b"x")
    assert snapshot.clean_tmp(env.data) == 2
    assert list(work.iterdir()) == []
    assert snapshot.clean_tmp(env.data / "missing") == 0


# ------------------------------------------------------------ local target


def test_local_target_write_list_fetch_delete(env: Env) -> None:
    target = LocalTarget(str(env.backups / "nested"))
    src = env.data / "payload"
    src.write_bytes(b"hello")
    name = make_name(NOW, encrypted=False)
    target.put(name, src, 5, "0" * 64, b'{"a": 1}')
    assert stat.S_IMODE((env.backups / "nested").stat().st_mode) == 0o700
    files = target.list_files()
    assert [(f.target, f.name, f.size, f.created_at) for f in files] == [("local", name, 5, NOW)]
    assert (env.backups / "nested" / meta_name(name)).read_bytes() == b'{"a": 1}'
    out = io.BytesIO()
    target.fetch(name, out)
    assert out.getvalue() == b"hello"
    target.delete(name)
    assert target.list_files() == []
    assert not (env.backups / "nested" / meta_name(name)).exists()
    target.test()
    assert list((env.backups / "nested").iterdir()) == []  # probe removed


def test_local_target_lists_only_our_files(env: Env) -> None:
    env.backups.mkdir()
    (env.backups / "notes.txt").write_text("mine")
    (env.backups / "tickerglass-20261113T033000Z.db.gz.part").write_bytes(b"x")
    (env.backups / make_name(NOW, encrypted=False)).write_bytes(b"x")
    (env.backups / "tickerglass-20261113T033000Z.db.gz.link").symlink_to(env.backups / "notes.txt")
    assert [f.name for f in LocalTarget(str(env.backups)).list_files()] == [
        make_name(NOW, encrypted=False)
    ]
    assert LocalTarget(str(env.backups / "missing")).list_files() == []


@pytest.mark.parametrize("name", ["../x", "notes.txt", "a/b.db.gz", "tickerglass-1.db.gz"])
def test_local_target_refuses_foreign_names(env: Env, name: str) -> None:
    env.backups.mkdir()
    (env.backups / "notes.txt").write_text("mine")
    target = LocalTarget(str(env.backups))
    with pytest.raises(TargetError):
        target.fetch(name, io.BytesIO())
    with pytest.raises(TargetError):
        target.delete(name)
    assert (env.backups / "notes.txt").exists()


def test_local_target_missing_file_is_not_found(env: Env) -> None:
    with pytest.raises(NotFound):
        LocalTarget(str(env.backups)).fetch(make_name(NOW, encrypted=False), io.BytesIO())


def test_local_target_not_writable_is_a_clean_error(env: Env) -> None:
    blocker = env.data / "file"
    blocker.write_text("x")
    with pytest.raises(TargetError, match="backup folder"):
        LocalTarget(str(blocker / "sub")).test()


def test_local_target_warns_on_the_database_disk(env: Env) -> None:
    # tmp_path is one filesystem: the folder shares the database's disk.
    assert "same disk" in (LocalTarget(str(env.backups)).warning(env.data) or "")


# --------------------------------------------------------------- s3 target


def test_s3_target_prefix_and_listing(env: Env, fake_s3: type[FakeS3]) -> None:
    (target,) = [t for t in targets.configured_targets(s3_settings(env)) if t.kind == "s3"]
    src = env.data / "payload"
    src.write_bytes(b"hello")
    name = make_name(NOW, encrypted=True)
    fake_s3.objects["tickerglass/other.txt"] = b"x"
    fake_s3.objects["elsewhere/" + name] = b"x"
    fake_s3.objects["tickerglass/sub/" + name] = b"x"
    import hashlib

    target.put(name, src, 5, hashlib.sha256(b"hello").hexdigest(), b"{}")
    assert set(fake_s3.objects) >= {"tickerglass/" + name, "tickerglass/" + meta_name(name)}
    assert [(f.name, f.size, f.encrypted) for f in target.list_files()] == [(name, 5, True)]
    out = io.BytesIO()
    target.fetch(name, out)
    assert out.getvalue() == b"hello"
    target.delete(name)
    assert "tickerglass/" + name not in fake_s3.objects
    assert "tickerglass/" + meta_name(name) not in fake_s3.objects
    assert "tickerglass/other.txt" in fake_s3.objects and "elsewhere/" + name in fake_s3.objects
    assert "minio:9000" in target.label and S3_SECRET not in target.label


def test_s3_target_maps_errors_to_codes(env: Env, fake_s3: type[FakeS3]) -> None:
    target = S3Target(
        S3Config("http://minio:9000", "tg", "p/", "us-east-1", S3_KEY_ID, S3_SECRET, True)
    )
    fake_s3.fail = {"head": "NoSuchBucket", "get": "NoSuchKey", "list": "AccessDenied"}
    with pytest.raises(TargetError, match="NoSuchBucket"):
        target.test()
    with pytest.raises(NotFound):
        target.fetch(make_name(NOW, encrypted=False), io.BytesIO())
    with pytest.raises(TargetError, match="AccessDenied"):
        target.list_files()
    assert fake_s3.timeouts[0] < 60  # interactive calls use a short timeout


# --------------------------------------------------------------- retention


def test_retention_keeps_the_gfs_set() -> None:
    # Two backups a day for 12 days (03:30 and 15:30), then one a month for 8 months.
    files = []
    for day in range(12):
        base = datetime(2026, 11, 13, tzinfo=UTC) - timedelta(days=day)
        files += [file_at(base.replace(hour=3, minute=30)), file_at(base.replace(hour=15))]
    for month in range(1, 9):
        files.append(file_at(datetime(2026, 11 - month, 1, 3, tzinfo=UTC)))
    policy = retention.Policy(daily=7, weekly=4, monthly=6)
    dropped = set(retention.select_deletions(files, policy))
    kept = [f for f in files if f.name not in dropped]
    # The newest of each of the 7 newest days is kept, the earlier same-day ones are not.
    for day in range(7):
        base = datetime(2026, 11, 13, tzinfo=UTC) - timedelta(days=day)
        newest = max(
            (f for f in files if f.created_at.date() == base.date()), key=lambda f: f.created_at
        )
        assert newest in kept
    assert file_at(datetime(2026, 11, 13, 3, 30, tzinfo=UTC)).name in dropped  # same-day older
    # The oldest monthly (March) is outside the 6 newest months (Nov..Jun, with Jul-Oct present).
    assert file_at(datetime(2026, 3, 1, 3, tzinfo=UTC)).name in dropped
    assert len(kept) < len(files)
    # Never the newest overall, even with an empty policy.
    only = retention.select_deletions(files, retention.Policy(1, 0, 0))
    newest = max(files, key=lambda f: f.created_at)
    assert newest.name not in only
    assert len(files) - len(only) == 1


def test_retention_counts_buckets_that_exist_and_honours_protect() -> None:
    sparse = [file_at(datetime(2026, 1, 1, tzinfo=UTC) + timedelta(days=10 * i)) for i in range(5)]
    # Fewer than N days present: nothing to drop.
    assert retention.select_deletions(sparse, retention.Policy(7, 4, 6)) == []
    pol = retention.Policy(1, 0, 0)
    assert len(retention.select_deletions(sparse, pol)) == 4
    protected = sparse[0].name
    assert protected not in retention.select_deletions(sparse, pol, protect=[protected])
    assert retention.select_deletions([], pol) == []


def test_retention_weekly_and_monthly_windows() -> None:
    files = [
        file_at(datetime(2026, 11, 13, 3, tzinfo=UTC) - timedelta(days=d)) for d in range(0, 120)
    ]
    kept_names = {f.name for f in files} - set(
        retention.select_deletions(files, retention.Policy(daily=3, weekly=2, monthly=2))
    )
    kept = sorted(f.created_at for f in files if f.name in kept_names)
    # 3 newest days + latest of the 2 newest ISO weeks + latest of the 2 newest months.
    assert kept[-3:] == [datetime(2026, 11, 13 - 2 + i, 3, tzinfo=UTC) for i in range(3)]
    assert datetime(2026, 10, 31, 3, tzinfo=UTC) in kept  # latest of October
    assert len(kept) <= 3 + 2 + 2


def test_apply_retention_deletes_only_our_files(env: Env) -> None:
    env.backups.mkdir()
    (env.backups / "notes.txt").write_text("mine")
    (env.backups / "tickerglass-old.db.gz").write_text("not ours: bad stamp")
    target = LocalTarget(str(env.backups))
    names = []
    for day in range(5):
        name = make_name(NOW - timedelta(days=day), encrypted=False)
        names.append(name)
        (env.backups / name).write_bytes(b"x")
        (env.backups / meta_name(name)).write_text(json.dumps({"instanceId": "me"}))
    deleted = retention.apply_retention(
        target, retention.Policy(2, 0, 0), "me", protect=[names[-1]]
    )
    assert deleted == [names[3], names[2]]  # protected oldest stays
    left = sorted(p.name for p in env.backups.iterdir())
    assert "notes.txt" in left and "tickerglass-old.db.gz" in left
    assert names[3] not in left and meta_name(names[3]) not in left
    assert names[0] in left and names[1] in left and names[4] in left


def test_retention_never_touches_files_of_another_instance(env: Env, fake_s3: type[FakeS3]) -> None:
    """A folder/prefix shared with other servers: only files whose `.json` has our instance id
    are deleted (or even counted); no `.json`, a foreign id or a broken one means "not ours"."""
    env.backups.mkdir()
    local = LocalTarget(str(env.backups))
    s3 = S3Target(S3Config("http://minio:9000", "tg", "tickerglass/", "us-east-1", "k", "s", True))
    specs = {  # age in days -> `.json` content (None: no `.json` at all)
        1: json.dumps({"instanceId": "me"}),
        2: json.dumps({"instanceId": "me"}),
        3: json.dumps({"instanceId": "someone-else"}),
        4: None,
        5: "not json at all",
        6: json.dumps({"instanceId": "me"}),
        7: json.dumps({"name": "old backups from before the id existed"}),
    }
    names = {d: make_name(NOW - timedelta(days=d), encrypted=False) for d in specs}
    for target, put in (
        (local, lambda n, body: (env.backups / n).write_bytes(body)),
        (s3, lambda n, body: fake_s3.objects.__setitem__("tickerglass/" + n, body)),
    ):
        for day, meta in specs.items():
            put(names[day], b"x")
            if meta is not None:
                put(meta_name(names[day]), meta.encode())
        deleted = retention.apply_retention(target, retention.Policy(1, 0, 0), "me")
        # Of our own files (days 1, 2, 6) only the newest day is kept.
        assert deleted == [names[6], names[2]], target.kind
    for day in (1, 3, 4, 5, 7):
        assert (env.backups / names[day]).exists()
        assert "tickerglass/" + names[day] in fake_s3.objects
    for day in (2, 6):
        assert not (env.backups / names[day]).exists()
        assert "tickerglass/" + names[day] not in fake_s3.objects
        assert not (env.backups / meta_name(names[day])).exists()


def test_a_run_stamps_the_instance_id_and_keeps_it(env: Env) -> None:
    service = env.service()
    first = service.get_run(service.run("manual"))
    assert first is not None
    meta = json.loads((env.backups / meta_name(first["fileName"])).read_text())
    assert len(meta["instanceId"]) == 32
    again = env.service(at=NOW + timedelta(days=1))
    second = again.get_run(again.run("manual"))
    assert second is not None
    meta2 = json.loads((env.backups / meta_name(second["fileName"])).read_text())
    assert meta2["instanceId"] == meta["instanceId"]  # stored in app_meta, created once
    # The id is inside the backup too: a restored server keeps managing the same lineage.
    out = env.data.parent / "copy.db"
    gunzip(env.backups / first["fileName"], out)
    con = sqlite3.connect(out)
    stored = con.execute("SELECT value FROM app_meta WHERE key = 'instance_id'").fetchone()[0]
    con.close()
    assert json.loads(stored) == meta["instanceId"]


# ----------------------------------------------------------------- service


def test_run_writes_to_local_and_applies_retention(env: Env) -> None:
    env.backups.mkdir()
    old = [make_name(NOW - timedelta(days=d), encrypted=False) for d in range(1, 12)]
    for name in old:
        plant(env, name)
    (env.backups / "notes.txt").write_text("mine")
    service = env.service(
        env.settings(
            backup_dir=str(env.backups),
            backup_keep_daily=3,
            backup_keep_weekly=0,
            backup_keep_monthly=0,
        )
    )
    run_id = service.run("manual")
    run = service.get_run(run_id)
    assert run is not None
    assert run["status"] == "ok" and run["trigger"] == "manual"
    assert run["fileName"] == make_name(NOW, encrypted=False)
    assert run["results"] == [{"target": "local", "ok": True, "error": None, "deleted": 9}]
    assert run["finishedAt"] and run["error"] is None
    left = sorted(p.name for p in env.backups.iterdir())
    assert (
        make_name(NOW, encrypted=False) in left
        and meta_name(make_name(NOW, encrypted=False)) in left
    )
    assert "notes.txt" in left
    assert len([n for n in left if n.endswith(".db.gz")]) == 3
    meta = json.loads((env.backups / meta_name(run["fileName"])).read_text())
    assert meta["size"] == run["size"] and meta["encrypted"] is False and meta["schemaRevision"]
    # No temp file left, lease free again.
    assert list((env.data / "backups-tmp").iterdir()) == []
    assert service.lease.holder(NOW) is None and not service.running


def test_run_to_both_targets_encrypted(env: Env, fake_s3: type[FakeS3]) -> None:
    settings = s3_settings(env, backup_dir=str(env.backups), backup_passphrase=PASSPHRASE)
    service = env.service(settings)
    run = service.get_run(service.run("schedule"))
    assert run is not None and run["status"] == "ok"
    assert run["fileName"].endswith(".db.gz.enc")
    assert [r["target"] for r in run["results"]] == ["local", "s3"]
    assert (env.backups / run["fileName"]).exists()
    assert "tickerglass/" + run["fileName"] in fake_s3.objects
    assert (
        fake_s3.objects["tickerglass/" + run["fileName"]]
        == (env.backups / run["fileName"]).read_bytes()
    )


def test_one_failing_target_is_a_partial_run(env: Env, fake_s3: type[FakeS3]) -> None:
    fake_s3.fail = {"put": "AccessDenied"}
    service = env.service(s3_settings(env, backup_dir=str(env.backups)))
    run = service.get_run(service.run("manual"))
    assert run is not None
    assert run["status"] == "partial"
    local, s3 = run["results"]
    assert local["ok"] and not s3["ok"] and s3["error"] == "S3 AccessDenied"
    assert run["error"] == "s3: S3 AccessDenied"
    assert (env.backups / run["fileName"]).exists()
    assert service.last_ok_at() is not None  # partial still counts as a backup


def test_no_retention_when_the_run_fails(env: Env, fake_s3: type[FakeS3]) -> None:
    old = make_name(NOW - timedelta(days=30), encrypted=False)
    plant(env, old, fake_s3)
    fake_s3.fail = {"put": "InternalError"}
    service = env.service(
        s3_settings(
            env, backup_keep_daily=1, backup_keep_weekly=0, backup_keep_monthly=0
        ).model_copy(update={"backup_dir": None})
    )
    run = service.get_run(service.run("manual"))
    assert run is not None and run["status"] == "failed"
    assert "tickerglass/" + old in fake_s3.objects  # nothing deleted
    assert run["results"][0].get("deleted") is None
    # Partial: retention only on the target that took the file.
    fake_s3.fail = {"put": "InternalError"}
    plant(env, old)
    service = env.service(
        s3_settings(
            env,
            backup_dir=str(env.backups),
            backup_keep_daily=1,
            backup_keep_weekly=0,
            backup_keep_monthly=0,
        )
    )
    run = service.get_run(service.run("manual"))
    assert run is not None and run["status"] == "partial"
    assert run["results"][0]["deleted"] == 1 and not (env.backups / old).exists()
    assert "tickerglass/" + old in fake_s3.objects


def test_retention_error_does_not_fail_the_run(env: Env, fake_s3: type[FakeS3]) -> None:
    plant(env, make_name(NOW - timedelta(days=9), encrypted=False), fake_s3)
    fake_s3.fail = {"delete": "AccessDenied"}
    service = env.service(
        s3_settings(
            env, backup_keep_daily=1, backup_keep_weekly=0, backup_keep_monthly=0
        ).model_copy(update={"backup_dir": None})
    )
    run = service.get_run(service.run("manual"))
    assert run is not None and run["status"] == "ok"
    assert run["results"][0]["retentionError"] == "S3 AccessDenied"


def test_failed_snapshot_is_a_failed_run(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    from tickerglass_api.backups import runner

    monkeypatch.setattr(runner, "make_snapshot", _raise(SnapshotError("integrity check failed")))
    service = env.service()
    run = service.get_run(service.run("manual"))
    assert run is not None and run["status"] == "failed"
    assert "integrity check failed" in run["error"]
    assert not env.backups.exists() or list(env.backups.iterdir()) == []
    assert service.last_ok_at() is None


def _raise(exc: BaseException) -> Callable[..., Any]:
    def boom(*_a: Any, **_k: Any) -> Any:
        raise exc

    return boom


def test_claim_refuses_without_targets_or_on_postgres(env: Env) -> None:
    with pytest.raises(NoTargets):
        env.service(env.settings()).claim("manual")
    memory = BackupService(make_engine("sqlite://"), env.settings(backup_dir=str(env.backups)))
    assert not memory.supported and not memory.enabled
    with pytest.raises(NotSupported):
        memory.claim("manual")


def test_enabled_needs_a_target_and_the_flag(env: Env) -> None:
    assert not env.service(env.settings()).enabled
    assert env.service().enabled
    assert not env.service(env.settings(backup_dir=str(env.backups), backup_enabled=False)).enabled


def test_only_one_process_runs_a_backup(env: Env) -> None:
    a = env.service(owner="worker-a")
    b = env.service(owner="worker-b")
    run_id = a.claim("schedule")
    with pytest.raises(RunInProgress):
        a.claim("manual")  # same process: already running
    with pytest.raises(RunInProgress):
        b.claim("manual")  # another process: the lease is taken
    a.execute(run_id)
    assert b.claim("manual")  # free again
    assert a.get_run(run_id) is not None


def test_stale_running_rows_are_marked_failed(env: Env) -> None:
    service = env.service()
    dead = service.claim("schedule")
    service.lease.release()
    service._active = None  # the process holding it died
    fresh = service.claim("manual")
    stale = service.get_run(dead)
    assert stale is not None and stale["status"] == "failed" and "interrupted" in stale["error"]
    running = service.get_run(fresh)
    assert running is not None and running["status"] == "running"


def test_run_records_are_pruned_to_the_newest_100(env: Env) -> None:
    service = env.service()
    for _ in range(KEEP_RUNS + 7):
        service._insert_run("schedule", NOW)
    with Session(env.engine) as session:
        ids = list(session.scalars(select(m.BackupRun.id).order_by(m.BackupRun.id)))
    assert len(ids) == KEEP_RUNS
    assert ids == list(range(8, KEEP_RUNS + 8))
    assert len(service.recent_runs(10)) == 10
    assert service.recent_runs(1)[0]["id"] == ids[-1]


def test_start_runs_in_the_background(env: Env) -> None:
    service = env.service()
    run_id = service.start("manual")
    service.join(60)
    run = service.get_run(run_id)
    assert run is not None and run["status"] == "ok"


def test_listing_merges_targets_newest_first_and_reports_errors(
    env: Env, fake_s3: type[FakeS3]
) -> None:
    env.backups.mkdir()
    (env.backups / make_name(NOW - timedelta(days=2), encrypted=False)).write_bytes(b"x")
    fake_s3.objects["tickerglass/" + make_name(NOW, encrypted=False)] = b"xx"
    service = env.service(s3_settings(env, backup_dir=str(env.backups)))
    files, errors = service.list_files()
    assert [(f.target, f.created_at) for f in files] == [
        ("s3", NOW),
        ("local", NOW - timedelta(days=2)),
    ]
    assert errors == []
    fake_s3.fail = {"list": "AccessDenied"}
    files, errors = service.list_files()
    assert [f.target for f in files] == ["local"]
    assert errors == [{"target": "s3", "error": "S3 AccessDenied"}]


# ----------------------------------------------------------------- secrets


def test_secrets_never_reach_run_errors_or_logs(
    env: Env,
    fake_s3: type[FakeS3],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def leaky(self: FakeS3, key: str, *_a: Any) -> None:
        raise RuntimeError(f"boom {S3_SECRET} {PASSPHRASE} {S3_KEY_ID} for {key}")

    monkeypatch.setattr(FakeS3, "put_object", leaky)
    caplog.set_level(logging.DEBUG)
    service = env.service(
        s3_settings(env, backup_dir=str(env.backups), backup_passphrase=PASSPHRASE)
    )
    run = service.get_run(service.run("manual"))
    assert run is not None and run["status"] == "partial"
    blob = json.dumps(run) + caplog.text
    for secret in (S3_SECRET, PASSPHRASE, S3_KEY_ID):
        assert secret not in blob
    assert "[redacted]" in run["results"][1]["error"]
    assert len(service.redact("x" * 2000)) == 500


SECRET_ENV = {
    "BACKUP_PASSPHRASE": "pass-phrase-secret-zz",
    "BACKUP_S3_SECRET_ACCESS_KEY": "s3-secret-key-zz",
    "BACKUP_S3_ACCESS_KEY_ID": "s3-key-id-zz",
    "AUTH_PASSWORD": "auth-password-zz",
    "AUTH_SECRET": "auth-secret-zz",
    "OIDC_CLIENT_SECRET": "oidc-secret-zz",
    "ALERTS_INTERNAL_TOKEN": "internal-token-zz-0123456789abcdef0123456789",
    "ALERTS_WEBHOOK_SECRET": "webhook-secret-zz",
    "NTFY_TOKEN": "ntfy-token-zz",
    "GOTIFY_TOKEN": "gotify-token-zz",
    "TELEGRAM_BOT_TOKEN": "telegram-token-zz",
    "SMTP_PASSWORD": "smtp-password-zz",
    "APPRISE_URLS": "tgram://apprise-secret-zz/chat",
}


def test_secrets_never_appear_in_the_settings_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in SECRET_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("BACKUP_S3_ENDPOINT", "http://minio:9000")  # the S3 target is complete
    monkeypatch.setenv("BACKUP_S3_BUCKET", "tg")
    settings = Settings(_env_file=None)  # type: ignore[call-arg]
    shown = repr(settings) + str(settings)
    for value in SECRET_ENV.values():
        assert value not in shown, value
    # The secrets are still usable by the code that needs them.
    assert settings.backup_passphrase_value == SECRET_ENV["BACKUP_PASSPHRASE"]
    assert settings.backup_s3_secret_value == SECRET_ENV["BACKUP_S3_SECRET_ACCESS_KEY"]
    assert settings.auth_password == SECRET_ENV["AUTH_PASSWORD"]


@pytest.mark.parametrize(
    "bad",
    [
        {"BACKUP_PASSPHRASE": "short-pw-zz"},  # too short
        {"BACKUP_S3_ENDPOINT": "http://minio:9000"},  # S3 settings incomplete (model-level error)
        {"ALERTS_INTERNAL_TOKEN": "tok-short-zz"},
        {"BACKUP_AT": "99:99"},
    ],
)
def test_a_bad_config_error_does_not_echo_secrets(
    monkeypatch: pytest.MonkeyPatch, bad: dict[str, str]
) -> None:
    for name, value in SECRET_ENV.items():
        monkeypatch.setenv(name, value)
    for name, value in bad.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(ValidationError) as exc:
        Settings(_env_file=None)  # type: ignore[call-arg]
    text = str(exc.value)  # what a startup traceback prints
    for name, value in {**SECRET_ENV, **bad}.items():
        if name in ("BACKUP_AT", "BACKUP_S3_ENDPOINT"):
            continue  # not secrets
        assert value not in text, name
    assert "input_value" not in text


def test_settings_repr_keeps_working_and_validates_secrets() -> None:
    with pytest.raises(ValueError, match="at least 12"):
        Settings(_env_file=None, backup_passphrase="short")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="missing"):
        Settings(_env_file=None, backup_s3_endpoint="http://x:9000")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="absolute"):
        Settings(_env_file=None, backup_dir="relative/dir")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="HH:MM"):
        Settings(_env_file=None, backup_at="25:00")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="time zone"):
        Settings(_env_file=None, backup_tz="Mars/Base")  # type: ignore[call-arg]
    with pytest.raises(ValueError, match="http"):
        Settings(  # type: ignore[call-arg]
            _env_file=None,
            backup_s3_endpoint="ftp://x",
            backup_s3_bucket="b",
            backup_s3_access_key_id="k",
            backup_s3_secret_access_key="s",
        )
    blank = Settings(_env_file=None, backup_dir="", backup_at="", backup_keep_daily="")  # type: ignore[call-arg]
    assert blank.backup_dir is None and blank.backup_at == "03:30" and blank.backup_keep_daily == 7
    assert Settings(_env_file=None, backup_restore_max_mb="").backup_restore_max_mb == 8192  # type: ignore[call-arg]
    assert Settings(_env_file=None).backup_zone == "UTC"  # type: ignore[call-arg]
    assert Settings(_env_file=None, screener_tz="Europe/Berlin").backup_zone == "Europe/Berlin"  # type: ignore[call-arg]
    assert Settings(_env_file=None, backup_tz="Asia/Tokyo").backup_zone == "Asia/Tokyo"  # type: ignore[call-arg]


# --------------------------------------------------------------- scheduler


def test_next_run_is_daily_in_the_configured_zone() -> None:
    settings = Settings(_env_file=None, backup_at="03:30", backup_tz="Europe/Berlin")  # type: ignore[call-arg]
    berlin = ZoneInfo("Europe/Berlin")
    before = datetime(2026, 11, 13, 1, 0, tzinfo=UTC)  # 02:00 Berlin
    assert next_run_at(settings, before) == datetime(2026, 11, 13, 3, 30, tzinfo=berlin).astimezone(
        UTC
    )
    after = datetime(2026, 11, 13, 3, 0, tzinfo=UTC)  # 04:00 Berlin
    assert next_run_at(settings, after) == datetime(2026, 11, 14, 3, 30, tzinfo=berlin).astimezone(
        UTC
    )
    # Exactly at the time: the next one is tomorrow.
    at = datetime(2026, 11, 13, 3, 30, tzinfo=berlin).astimezone(UTC)
    assert next_run_at(settings, at) == at + timedelta(days=1)
    # Summer time: the UTC offset moves, the local time does not.
    summer = next_run_at(settings, datetime(2026, 7, 1, 12, 0, tzinfo=UTC))
    assert summer.astimezone(berlin).strftime("%H:%M") == "03:30"
    assert summer == datetime(2026, 7, 2, 1, 30, tzinfo=UTC)


def test_catch_up_when_the_last_success_is_older_than_26_hours(env: Env) -> None:
    service = env.service()
    scheduler = BackupScheduler(service)
    assert scheduler.needs_catch_up()  # never ran
    run_id = service.run("manual")
    assert not BackupScheduler(service).needs_catch_up()
    later = env.service(at=NOW + timedelta(hours=25))
    assert not BackupScheduler(later).needs_catch_up()
    later = env.service(at=NOW + timedelta(hours=27))
    assert BackupScheduler(later).needs_catch_up()
    # A failed run does not count.
    with Session(env.engine) as session, session.begin():
        session.get(m.BackupRun, run_id).status = "failed"  # type: ignore[union-attr]
    assert BackupScheduler(service).needs_catch_up()


class Clock:
    """Sleeping advances the clock; cancels the loop after `limit` sleeps."""

    def __init__(self, start: datetime, limit: int) -> None:
        self.t = start
        self.limit = limit
        self.sleeps: list[float] = []

    def now(self) -> datetime:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if len(self.sleeps) > self.limit:
            raise asyncio.CancelledError
        self.t += timedelta(seconds=seconds)
        await asyncio.sleep(0)


def _scheduler_with_clock(
    env: Env, clock: Clock, monkeypatch: pytest.MonkeyPatch, at: str = "03:30"
) -> tuple[BackupScheduler, list[tuple[str, datetime]]]:
    settings = env.settings(backup_dir=str(env.backups), backup_at=at, backup_tz="UTC")
    service = BackupService(env.engine, settings, clock=clock.now)
    claims: list[tuple[str, datetime]] = []

    def claim(trigger: str) -> int:
        claims.append((trigger, clock.now()))
        return 1

    monkeypatch.setattr(service, "claim", claim)
    monkeypatch.setattr(service, "execute", lambda _id: None)
    return BackupScheduler(service, sleep=clock.sleep), claims


def test_scheduler_catches_up_once_then_runs_daily(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(datetime(2026, 11, 13, 10, 0, tzinfo=UTC), limit=200)
    scheduler, claims = _scheduler_with_clock(env, clock, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(scheduler._loop())
    assert clock.sleeps[0] == 300  # the 5 minute catch-up delay
    assert claims[0] == ("schedule", datetime(2026, 11, 13, 10, 5, tzinfo=UTC))
    # Then one run a day at 03:30, sleeping in slices of at most 15 minutes.
    assert max(clock.sleeps[1:]) <= 900
    days = [when for _t, when in claims[1:]]
    assert days[0] == datetime(2026, 11, 14, 3, 30, tzinfo=UTC)
    assert days[1] == datetime(2026, 11, 15, 3, 30, tzinfo=UTC)


def test_scheduler_skips_catch_up_after_a_recent_backup(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    with Session(env.engine) as session, session.begin():
        session.add(
            m.BackupRun(
                started_at=datetime(2026, 11, 13, 3, 30, tzinfo=UTC),
                finished_at=datetime(2026, 11, 13, 3, 31, tzinfo=UTC),
                trigger="schedule",
                status="ok",
            )
        )
    clock = Clock(datetime(2026, 11, 13, 10, 0, tzinfo=UTC), limit=120)
    scheduler, claims = _scheduler_with_clock(env, clock, monkeypatch)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(scheduler._loop())
    assert claims[0][1] == datetime(2026, 11, 14, 3, 30, tzinfo=UTC)


def test_scheduler_survives_a_busy_lease_and_errors(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = Clock(datetime(2026, 11, 13, 10, 0, tzinfo=UTC), limit=120)
    scheduler, claims = _scheduler_with_clock(env, clock, monkeypatch)
    calls = {"n": 0}

    def claim(_trigger: str) -> int:
        calls["n"] += 1
        raise (
            RunInProgress("another process is running a backup")
            if calls["n"] % 2
            else RuntimeError("x")
        )

    monkeypatch.setattr(scheduler._service, "claim", claim)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(scheduler._loop())
    assert calls["n"] >= 2  # neither exception stopped the loop
    assert claims == []


def test_scheduler_is_off_without_a_target(env: Env) -> None:
    async def go() -> tuple[bool, Any]:
        scheduler = BackupScheduler(env.service(env.settings()))
        scheduler.start()
        out = (scheduler.scheduled, scheduler.next_run())
        await scheduler.stop()
        return out

    assert asyncio.run(go()) == (False, None)


def test_scheduler_start_and_stop_with_a_target(env: Env) -> None:
    async def go() -> tuple[bool, Any]:
        scheduler = BackupScheduler(env.service(), catch_up_delay_s=3600)
        scheduler.start()
        await asyncio.sleep(0.05)
        out = (scheduler.scheduled, scheduler.next_run())
        await scheduler.stop()
        return out[0], out[1]

    scheduled, nxt = asyncio.run(go())
    assert scheduled and nxt is not None


def test_lease_renewal_does_not_block_a_slow_run(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    """The run keeps its lease while working, and releases it after."""
    from tickerglass_api.backups import runner

    started, proceed = threading.Event(), threading.Event()
    real = runner.make_snapshot

    def slow(*a: Any, **k: Any) -> Any:
        started.set()
        proceed.wait(10)
        return real(*a, **k)

    monkeypatch.setattr(runner, "make_snapshot", slow)
    service = env.service(owner="a")
    run_id = service.start("manual")
    assert started.wait(10)
    assert env.service(owner="b").lease.holder(NOW) == "a"
    proceed.set()
    service.join(60)
    run = service.get_run(run_id)
    assert run is not None and run["status"] == "ok"
    assert env.service(owner="b").lease.holder(NOW) is None
