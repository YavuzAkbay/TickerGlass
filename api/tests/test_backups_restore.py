"""Backup restore: staging validations, startup apply, multipart reader, server lock, CLI.

Fail-closed behaviour is what matters here: nothing replaces the live database unless the staged
file validates, twice (docs/design/scheduled-backups.md "Restore").
"""

import gzip
import json
import shutil
import sqlite3
from collections.abc import Callable
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_backups import NOW, PASSPHRASE, Env

from tickerglass_api.backups import cli, restore
from tickerglass_api.backups.multipart import (
    MultipartError,
    MultipartReader,
    PartInfo,
    boundary_of,
)
from tickerglass_api.backups.restore import RestoreError, ServerLock
from tickerglass_api.backups.snapshot import make_snapshot
from tickerglass_api.db import migration_revisions
from tickerglass_api.settings import get_settings

# ------------------------------------------------------------------ helpers


def marker(db: Path, value: str | None = None) -> str | None:
    """Read (or, with `value`, write) the `marker` row of app_meta."""
    con = sqlite3.connect(db)
    try:
        if value is not None:
            con.execute("DELETE FROM app_meta WHERE key = 'marker'")
            con.execute(
                "INSERT INTO app_meta (key, value, updated_at) VALUES ('marker', ?, ?)",
                (json.dumps(value), "2026-01-01 00:00:00"),
            )
            con.commit()
            return None
        row = con.execute("SELECT value FROM app_meta WHERE key = 'marker'").fetchone()
        return json.loads(row[0]) if row else None
    finally:
        con.close()


def backup_file(env: Env, *, passphrase: str | None = None, mark: str = "backed-up") -> Path:
    """A real backup file of the live database, carrying `mark`."""
    marker(env.db, mark)
    snap = make_snapshot(
        env.db, env.data, include_cache=False, passphrase=passphrase, app_version="x", now=NOW
    )
    out = env.data.parent / snap.name
    shutil.move(snap.path, out)
    return out


def stage(env: Env, src: Path, **kw: object) -> dict[str, object]:
    args: dict[str, object] = {"passphrase": None, "source": "test", "restore_max_mb": 8192}
    args.update(kw)
    return restore.stage_file(src, env.data, **args)  # type: ignore[arg-type]


def refused(env: Env, src: Path, match: str, **kw: object) -> None:
    with pytest.raises(RestoreError, match=match):
        stage(env, src, **kw)
    assert restore.pending_info(env.data) is None
    assert not (env.data / restore.PENDING_DB).exists()
    assert list((env.data / "backups-tmp").iterdir()) == []  # nothing left behind


def set_revision(db: Path, revision: str) -> None:
    con = sqlite3.connect(db)
    con.execute("UPDATE alembic_version SET version_num = ?", (revision,))
    con.commit()
    con.close()


def gz_of(db: Path, out: Path) -> Path:
    with db.open("rb") as fin, gzip.open(out, "wb") as fout:
        shutil.copyfileobj(fin, fout)
    return out


# ------------------------------------------------------------------ staging


def test_stage_plain_gz_and_raw_db(env: Env) -> None:
    src = backup_file(env)
    info = stage(env, src, source="local:x")
    assert info["source"] == "local:x" and info["revision"] in migration_revisions()
    pending = restore.pending_info(env.data)
    assert pending is not None and pending["source"] == "local:x"
    assert marker(env.data / restore.PENDING_DB) == "backed-up"
    assert (env.data / restore.PENDING_DB).stat().st_mode & 0o077 == 0
    # The file the user gave us is untouched; nothing else lingers.
    assert src.exists()
    assert list((env.data / "backups-tmp").iterdir()) == []
    # A raw `.db` (the "Download backup" file, WAL flag and all) restores too.
    restore.cancel_pending(env.data)
    raw = env.data.parent / "download.db"
    shutil.copyfile(env.db, raw)
    con = sqlite3.connect(raw)
    con.execute("PRAGMA journal_mode=WAL")
    con.close()
    stage(env, raw)
    assert (
        sqlite3.connect(env.data / restore.PENDING_DB).execute("PRAGMA journal_mode").fetchone()[0]
        == "delete"
    )


def test_stage_encrypted_needs_the_right_passphrase(env: Env) -> None:
    src = backup_file(env, passphrase=PASSPHRASE)
    refused(env, src, "encrypted", passphrase=None)
    refused(env, src, "wrong passphrase", passphrase="not the passphrase!!")
    stage(env, src, passphrase=PASSPHRASE)
    assert marker(env.data / restore.PENDING_DB) == "backed-up"


def test_wrong_passphrase_leaves_no_plaintext_prefix(env: Env) -> None:
    """decrypt_stream writes authenticated chunks as it goes; they must not survive a failure."""
    src = backup_file(env, passphrase=PASSPHRASE)
    refused(env, src, "wrong passphrase", passphrase="not the passphrase!!")
    assert [p.name for p in env.data.iterdir() if "restore" in p.name] == []


def test_stage_a_truncated_encrypted_file(env: Env) -> None:
    src = backup_file(env, passphrase=PASSPHRASE)
    cut = env.data.parent / "cut.enc"
    cut.write_bytes(src.read_bytes()[:-40])
    refused(env, cut, "wrong passphrase|not a valid", passphrase=PASSPHRASE)


def test_stage_refuses_a_bad_header(env: Env) -> None:
    junk = env.data.parent / "junk"
    junk.write_bytes(b"this is not a database at all" * 100)
    refused(env, junk, "not a TickerGlass backup")
    empty = env.data.parent / "empty"
    empty.write_bytes(b"")
    refused(env, empty, "not a TickerGlass backup")
    bad_gz = env.data.parent / "bad.gz"
    bad_gz.write_bytes(b"\x1f\x8b" + b"nonsense" * 20)
    refused(env, bad_gz, "damaged")
    # gzip of something that is not SQLite.
    not_sqlite = env.data.parent / "x.db.gz"
    with gzip.open(not_sqlite, "wb") as fh:
        fh.write(b"hello world" * 100)
    refused(env, not_sqlite, "not a SQLite database")


def test_stage_refuses_a_damaged_database(env: Env) -> None:
    src = env.data.parent / "damaged.db"
    shutil.copyfile(env.db, src)
    data = src.read_bytes()
    src.write_bytes(data[: len(data) // 2])  # header intact, pages missing
    refused(env, src, "damaged")


def test_stage_refuses_a_failed_integrity_check(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    src = backup_file(env)
    monkeypatch.setattr(restore, "integrity_error", lambda _p: "integrity check failed: row 7")
    refused(env, src, "integrity check failed")


def test_stage_refuses_a_newer_schema(env: Env) -> None:
    marker(env.db, "x")
    set_revision(env.db, "ffffffffffff")
    refused(env, env.db, "newer TickerGlass")


def test_stage_refuses_a_database_that_is_not_ours(env: Env) -> None:
    other = env.data.parent / "other.db"
    con = sqlite3.connect(other)
    con.execute("CREATE TABLE alembic_version (version_num TEXT)")
    con.execute("INSERT INTO alembic_version VALUES ('x')")
    con.commit()
    con.close()
    refused(env, other, "unknown to this version|newer")  # a revision that is not ours
    con = sqlite3.connect(other)
    con.execute("DROP TABLE alembic_version")
    con.commit()
    con.close()
    refused(env, other, "alembic_version table missing")
    con = sqlite3.connect(other)
    con.execute("CREATE TABLE alembic_version (version_num TEXT)")
    con.commit()
    con.close()
    refused(env, other, "no schema revision")


def test_stage_refuses_a_decompression_bomb(env: Env) -> None:
    bomb = env.data.parent / "bomb.db.gz"
    with gzip.open(bomb, "wb") as fh:
        for _ in range(20):
            fh.write(b"\0" * (1 << 20))  # 20 MiB of zeros, a few KB compressed
    refused(env, bomb, "once decompressed", restore_max_mb=16)


def test_cancel_removes_the_staged_files(env: Env) -> None:
    stage(env, backup_file(env))
    assert restore.cancel_pending(env.data) is True
    assert restore.pending_info(env.data) is None
    assert not (env.data / restore.PENDING_META).exists()
    assert restore.cancel_pending(env.data) is False


def test_staging_again_replaces_the_pending_restore(env: Env) -> None:
    stage(env, backup_file(env, mark="first"), source="one")
    stage(env, backup_file(env, mark="second"), source="two")
    pending = restore.pending_info(env.data)
    assert pending is not None and pending["source"] == "two"
    assert marker(env.data / restore.PENDING_DB) == "second"


# ------------------------------------------------------------------- apply


def test_apply_swaps_the_database_and_keeps_the_old_one(env: Env) -> None:
    src = backup_file(env, mark="backup")
    stage(env, src, source="local:x")
    marker(env.db, "live-after-backup")
    result = restore.apply_pending(env.db, NOW)
    assert result is not None and result.status == "applied"
    assert marker(env.db) == "backup"
    assert result.pre_restore == "pre-restore-20261113T033000Z.db"
    assert marker(env.data / result.pre_restore) == "live-after-backup"
    assert restore.pending_info(env.data) is None
    assert (
        not (env.data / restore.PENDING_DB).exists()
        and not (env.data / restore.PENDING_META).exists()
    )
    recorded = restore.last_result(env.data)
    assert (
        recorded is not None and recorded["status"] == "applied" and recorded["source"] == "local:x"
    )
    # Nothing pending: a no-op.
    assert restore.apply_pending(env.db, NOW) is None


def test_apply_moves_wal_and_shm_with_the_old_database(env: Env) -> None:
    stage(env, backup_file(env))
    (env.data / "tickerglass.db-wal").write_bytes(b"wal")
    (env.data / "tickerglass.db-shm").write_bytes(b"shm")
    restore.apply_pending(env.db, NOW)
    assert (env.data / "pre-restore-20261113T033000Z.db-wal").read_bytes() == b"wal"
    assert (env.data / "pre-restore-20261113T033000Z.db-shm").read_bytes() == b"shm"
    assert not (env.data / "tickerglass.db-wal").exists()  # a stale WAL must not meet the new file


def test_apply_keeps_only_the_last_two_pre_restore_copies(env: Env) -> None:
    for i in range(4):
        stage(env, backup_file(env, mark=f"b{i}"))
        marker(env.db, f"live{i}")
        restore.apply_pending(env.db, NOW + timedelta(days=i))
    copies = sorted(p.name for p in env.data.glob("pre-restore-*.db"))
    assert copies == ["pre-restore-20261115T033000Z.db", "pre-restore-20261116T033000Z.db"]
    assert marker(env.data / copies[1]) == "live3"


def test_apply_into_an_empty_data_folder(env: Env) -> None:
    stage(env, backup_file(env, mark="fresh"))
    env.db.unlink()
    result = restore.apply_pending(env.db, NOW)
    assert result is not None and result.status == "applied" and result.pre_restore is None
    assert marker(env.db) == "fresh"


@pytest.mark.parametrize(
    "garbage",
    [b"not sqlite", b"SQLite format 3\x00" + b"\0" * 5000, b""],
    ids=["text", "header-only", "empty"],
)
def test_invalid_pending_leaves_the_database_untouched(env: Env, garbage: bytes) -> None:
    marker(env.db, "live")
    before = env.db.read_bytes()
    (env.data / restore.PENDING_DB).write_bytes(garbage)
    (env.data / restore.PENDING_META).write_text(json.dumps({"source": "upload"}))
    result = restore.apply_pending(env.db, NOW)
    assert result is not None and result.status == "failed" and result.error
    assert env.db.read_bytes() == before
    assert not list(env.data.glob("pre-restore-*"))
    assert restore.pending_info(env.data) is None  # discarded
    recorded = restore.last_result(env.data)
    assert (
        recorded is not None and recorded["status"] == "failed" and recorded["source"] == "upload"
    )


def test_pending_that_turned_newer_is_refused_at_apply(env: Env) -> None:
    stage(env, backup_file(env))
    set_revision(env.data / restore.PENDING_DB, "ffffffffffff")  # changed after staging
    before = env.db.read_bytes()
    result = restore.apply_pending(env.db, NOW)
    assert result is not None and result.status == "failed" and "newer" in (result.error or "")
    assert env.db.read_bytes() == before


def test_failed_swap_puts_the_live_database_back(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    stage(env, backup_file(env))
    marker(env.db, "live")
    real = restore.os.replace
    calls = {"n": 0}

    def flaky(src: object, dst: object) -> None:
        calls["n"] += 1
        if str(src).endswith(restore.PENDING_DB):
            raise OSError(28, "No space left on device")
        real(src, dst)  # type: ignore[arg-type]

    monkeypatch.setattr(restore.os, "replace", flaky)
    result = restore.apply_pending(env.db, NOW)
    assert result is not None and result.status == "failed"
    assert marker(env.db) == "live"
    assert not list(env.data.glob("pre-restore-*"))


# ------------------------------------------------------ startup (app lifespan)


def test_startup_applies_the_restore_then_migrates(
    make_client: Callable[..., TestClient], tmp_path: Path, template_db: Path
) -> None:
    live = tmp_path / "a0.db"  # where `make_client` puts its first database
    shutil.copyfile(template_db, live)
    marker(live, "live")
    # A backup from one revision back: no backup_runs table yet.
    older = tmp_path / "older.db"
    shutil.copyfile(template_db, older)
    con = sqlite3.connect(older)
    con.execute("DROP TABLE backup_runs")
    con.execute("UPDATE alembic_version SET version_num = 'a91c4d7e2b60'")
    con.commit()
    con.close()
    marker(older, "restored")
    shutil.copyfile(older, tmp_path / restore.PENDING_DB)
    (tmp_path / restore.PENDING_META).write_text(json.dumps({"source": "upload", "stagedAt": ""}))

    client = make_client(auth_password="sesame")
    assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    assert marker(live) == "restored"
    assert len(list(tmp_path.glob("pre-restore-*.db"))) == 1
    con = sqlite3.connect(live)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    con.close()
    assert "backup_runs" in tables  # the migrations ran on the restored file
    assert version == "b5e2f19c7a31"
    body = client.get("/api/backups").json()
    assert body["pending"] is None
    assert body["lastRestore"]["status"] == "applied" and body["lastRestore"]["source"] == "upload"


def test_startup_with_an_invalid_pending_file_keeps_the_database(
    make_client: Callable[..., TestClient], tmp_path: Path, template_db: Path
) -> None:
    live = tmp_path / "a0.db"
    shutil.copyfile(template_db, live)
    marker(live, "live")
    (tmp_path / restore.PENDING_DB).write_bytes(b"garbage")
    client = make_client(auth_password="sesame")
    assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    assert marker(live) == "live"
    body = client.get("/api/backups").json()
    assert body["pending"] is None
    assert body["lastRestore"]["status"] == "failed" and body["lastRestore"]["error"]


def test_startup_cleans_the_work_folder(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    (tmp_path / "backups-tmp").mkdir()
    (tmp_path / "backups-tmp" / "leftover.db").write_bytes(b"x")
    make_client()
    assert not (tmp_path / "backups-tmp" / "leftover.db").exists()


def stage_in(data: Path, db: Path, source: str = "upload") -> None:
    """Put `db` where a staged restore lives (as the stage step leaves it)."""
    shutil.copyfile(db, data / restore.PENDING_DB)
    (data / restore.PENDING_META).write_text(json.dumps({"source": source, "stagedAt": ""}))


def test_startup_without_the_lock_neither_cleans_nor_applies(
    make_client: Callable[..., TestClient],
    tmp_path: Path,
    template_db: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Another process holds the data folder: its temp files and its database are not ours to
    touch. The server still starts; the staged restore stays and the status says why."""
    live = tmp_path / "a0.db"
    shutil.copyfile(template_db, live)
    marker(live, "live")
    restored = tmp_path / "restored.db"
    shutil.copyfile(template_db, restored)
    marker(restored, "restored")
    stage_in(tmp_path, restored, source="local:x")
    (tmp_path / "backups-tmp").mkdir()
    (tmp_path / "backups-tmp" / "in-use.tmp").write_bytes(b"another process's temp file")
    other = ServerLock(tmp_path)
    assert other.acquire()
    try:
        client = make_client(auth_password="sesame")
        assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
        assert (tmp_path / "backups-tmp" / "in-use.tmp").exists()
        assert marker(live) == "live" and not list(tmp_path.glob("pre-restore-*"))
        body = client.get("/api/backups").json()
        assert body["pending"] is not None and body["pending"]["source"] == "local:x"
        last = body["lastRestore"]
        assert last["status"] == "failed" and "another process" in last["error"]
        assert last["source"] == "local:x"
        assert any(
            r.levelname == "ERROR" and "could not lock" in r.getMessage() for r in caplog.records
        )
    finally:
        other.release()


def test_startup_that_holds_the_lock_still_cleans_and_applies(
    make_client: Callable[..., TestClient], tmp_path: Path, template_db: Path
) -> None:
    live = tmp_path / "a0.db"
    shutil.copyfile(template_db, live)
    restored = tmp_path / "restored.db"
    shutil.copyfile(template_db, restored)
    marker(restored, "restored")
    stage_in(tmp_path, restored)
    (tmp_path / "backups-tmp").mkdir()
    (tmp_path / "backups-tmp" / "leftover.tmp").write_bytes(b"x")
    make_client()
    assert marker(live) == "restored"
    assert not (tmp_path / "backups-tmp" / "leftover.tmp").exists()


def test_failed_migrations_after_a_restore_roll_back(
    make_client: Callable[..., TestClient],
    tmp_path: Path,
    template_db: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    live = tmp_path / "a0.db"
    shutil.copyfile(template_db, live)
    marker(live, "live")
    restored = tmp_path / "restored.db"
    shutil.copyfile(template_db, restored)
    marker(restored, "restored")
    stage_in(tmp_path, restored, source="local:x")
    (tmp_path / "a0.db-wal").write_bytes(b"")  # must travel with the live database both ways

    def boom(_url: str) -> None:
        # What the restored file looked like to the migrations: it is the swapped-in one.
        assert marker(live) == "restored"
        raise RuntimeError("migration blew up on /secret/path/with/detail")

    monkeypatch.setattr("tickerglass_api.app.run_migrations", boom)
    with pytest.raises(RuntimeError, match="blew up"):
        make_client()
    assert marker(live) == "live"  # the previous database is back
    assert not list(tmp_path.glob("pre-restore-*"))
    assert not (tmp_path / restore.PENDING_DB).exists()
    last = restore.last_result(tmp_path)
    assert last is not None and last["status"] == "failed" and last["source"] == "local:x"
    assert "RuntimeError" in last["error"] and "secret/path" not in last["error"]
    assert "previous database was put back" in last["error"]
    # The lock is free again for the next start.
    again = ServerLock(tmp_path)
    assert again.acquire()
    again.release()


# ------------------------------------------------------- crafted databases (active content)


def crafted(env: Env, name: str, sql: str) -> Path:
    out = env.data.parent / name
    shutil.copyfile(env.db, out)
    con = sqlite3.connect(out)
    con.executescript(sql)
    con.commit()
    con.close()
    return out


CRAFTED = {
    "trigger": (
        "CREATE TRIGGER evil AFTER INSERT ON users BEGIN "
        "UPDATE users SET name = name WHERE id = NEW.id; END;",
        "trigger",
    ),
    "view": ("CREATE VIEW evil_view AS SELECT * FROM users;", "view"),
    "expression-index": ("CREATE INDEX evil_ix ON app_meta (lower(key));", "expression"),
    "partial-index": ("CREATE INDEX evil_ix ON app_meta (key) WHERE key != 'x';", "partial index"),
    "generated-column": (
        "ALTER TABLE app_meta ADD COLUMN evil INTEGER GENERATED ALWAYS AS (1) VIRTUAL;",
        "generated column",
    ),
}


@pytest.mark.parametrize("kind", list(CRAFTED))
def test_stage_refuses_active_content(env: Env, kind: str) -> None:
    sql, match = CRAFTED[kind]
    refused(env, crafted(env, "crafted.db", sql), match)


def test_stage_refuses_a_virtual_table(env: Env) -> None:
    try:
        src = crafted(env, "crafted.db", "CREATE VIRTUAL TABLE evil USING fts5(body);")
    except sqlite3.OperationalError:
        pytest.skip("this SQLite has no fts5")
    refused(env, src, "virtual table")


def test_apply_validates_again_and_refuses_active_content(env: Env) -> None:
    """A file that got into the pending slot some other way is checked at apply time too."""
    marker(env.db, "live")
    before = env.db.read_bytes()
    evil = crafted(
        env,
        "crafted.db",
        "CREATE TRIGGER evil AFTER INSERT ON users BEGIN UPDATE users SET name = name; END;",
    )
    shutil.copyfile(evil, env.data / restore.PENDING_DB)
    result = restore.apply_pending(env.db, NOW)
    assert result is not None and result.status == "failed" and "trigger" in (result.error or "")
    assert env.db.read_bytes() == before
    assert not (env.data / restore.PENDING_DB).exists()


def test_the_real_schema_passes_the_active_content_checks(env: Env) -> None:
    assert restore.validate_db(env.db) in migration_revisions()


def test_validation_opens_the_candidate_read_only_without_trusting_its_schema(
    env: Env,
) -> None:
    con = restore._hardened(env.db)
    try:
        assert con.execute("PRAGMA trusted_schema").fetchone()[0] == 0
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            con.execute("DELETE FROM app_meta")
    finally:
        con.close()


# ------------------------------------------------------------- older backups (pre-2.2)


def old_db(path: Path, revision: str = "e7b3c05a9d14") -> Path:
    """A database as an older release left it: migrated to `revision`, one watchlist in it."""
    from alembic import command
    from alembic.config import Config

    import tickerglass_api.db as db_module

    cfg = Config()
    cfg.set_main_option("script_location", str(Path(db_module.__file__).parent / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{path}")
    command.upgrade(cfg, revision)
    con = sqlite3.connect(path)
    con.execute(
        "INSERT INTO watchlists (id, name, items, revision, created_at, updated_at) "
        "VALUES ('w1', 'Old list', '[]', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')"
    )
    con.commit()
    con.execute("PRAGMA journal_mode=DELETE")
    con.close()
    return path


def test_a_backup_from_before_multi_user_is_accepted(env: Env, tmp_path: Path) -> None:
    old = old_db(tmp_path / "old.db")
    info = stage(env, old)
    assert info["revision"] == "e7b3c05a9d14"
    # Any known revision is fine; `users` is only required from the multi-user revision on.
    assert restore.validate_db(old) == "e7b3c05a9d14"
    restore.cancel_pending(env.data)
    set_revision(old, restore.MULTI_USER_REVISION)  # claims to be multi-user, has no users table
    refused(env, old, "users table missing")


def test_a_pre_multi_user_backup_is_upgraded_and_owned_by_the_owner(
    make_client: Callable[..., TestClient], tmp_path: Path
) -> None:
    old = old_db(tmp_path / "old.db")
    live = tmp_path / "a0.db"
    shutil.copyfile(old, live)  # a live database of that age too, so there is a pre-restore copy
    # Staged the real way (validation, normalization) from a "Download backup" style file.
    restore.stage_file(old, tmp_path, passphrase=None, source="upload", restore_max_mb=8192)
    con = sqlite3.connect(live)
    con.execute("DELETE FROM watchlists")
    con.commit()
    con.close()
    client = make_client(auth_password="sesame")
    assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    con = sqlite3.connect(live)
    try:
        owner = json.loads(
            con.execute("SELECT value FROM app_meta WHERE key = 'owner_user_id'").fetchone()[0]
        )
        rows = con.execute("SELECT id, owner_id FROM watchlists").fetchall()
        name = con.execute("SELECT name FROM users WHERE id = ?", (owner,)).fetchone()[0]
        version = con.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    finally:
        con.close()
    assert rows == [("w1", owner)] and name == "Owner"
    assert version == migration_head()
    lists = client.get("/api/watchlists").json()
    assert [w["name"] for w in lists] == ["Old list"]
    assert client.get("/api/backups").json()["lastRestore"]["status"] == "applied"


def migration_head() -> str:
    from tickerglass_api.db import migration_chain

    return migration_chain()[-1]


# ----------------------------------------------------------- limits, space, concurrency


def test_the_restore_limit_applies_to_the_file_as_read(env: Env) -> None:
    big = env.data.parent / "big.bin"
    big.write_bytes(b"x" * (2 << 20))
    refused(env, big, "restore limit", restore_max_mb=1)


def test_fetching_from_a_target_stops_at_the_restore_limit(env: Env) -> None:
    from tickerglass_api.backups.naming import make_name
    from tickerglass_api.backups.targets import LocalTarget

    env.backups.mkdir()
    name = make_name(NOW, encrypted=False)
    (env.backups / name).write_bytes(b"x" * (3 << 20))
    with pytest.raises(RestoreError, match="restore limit") as exc:
        restore.stage_from_target(
            LocalTarget(str(env.backups)), name, env.data, passphrase=None, restore_max_mb=1
        )
    assert exc.value.status == 400
    assert list((env.data / "backups-tmp").iterdir()) == []  # the partial fetch is removed
    assert restore.pending_info(env.data) is None


def test_staging_needs_free_disk_space(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    src = backup_file(env)
    import collections

    usage = collections.namedtuple("usage", "total used free")  # noqa: PYI024

    monkeypatch.setattr(restore.shutil, "disk_usage", lambda _p: usage(10**9, 10**9 - 1000, 1000))
    with pytest.raises(RestoreError, match="free disk space") as exc:
        stage(env, src)
    assert exc.value.status == restore.NO_SPACE_STATUS
    assert restore.pending_info(env.data) is None
    assert list((env.data / "backups-tmp").iterdir()) == []
    monkeypatch.undo()
    stage(env, src)  # plenty of space: fine


def test_the_space_needed_is_capped_by_the_restore_limit(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bogus gzip size claim cannot demand more than the limit."""
    src = backup_file(env)
    seen: list[int] = []
    monkeypatch.setattr(restore, "_ensure_space", lambda _w, need: seen.append(need))
    stage(env, src, restore_max_mb=1)
    assert seen and max(seen) <= 1 << 20


def test_concurrent_staging_never_mixes_meta_and_database(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading
    import time

    slow_src = backup_file(env, mark="slow")
    fast_src = env.data.parent / "fast.db.gz"
    marker(env.db, "fast")
    fast_snap = make_snapshot(
        env.db, env.data, include_cache=False, passphrase=None, app_version="x", now=NOW
    )
    shutil.move(fast_snap.path, fast_src)
    entered = threading.Event()
    real = restore.os.replace

    def replace(src: object, dst: object) -> None:
        if threading.current_thread().name == "slow" and str(dst).endswith(restore.PENDING_DB):
            entered.set()  # the other staging starts now, in the middle of this one
            time.sleep(0.4)
        real(src, dst)  # type: ignore[arg-type]

    monkeypatch.setattr(restore.os, "replace", replace)
    errors: list[BaseException] = []

    def go(src: Path, source: str, wait: bool) -> None:
        try:
            if wait:
                assert entered.wait(5)
            stage(env, src, source=source)
        except BaseException as exc:
            errors.append(exc)

    slow = threading.Thread(target=go, args=(slow_src, "slow", False), name="slow")
    fast = threading.Thread(target=go, args=(fast_src, "fast", True), name="fast")
    slow.start()
    fast.start()
    slow.join(20)
    fast.join(20)
    assert not errors, errors
    pending = restore.pending_info(env.data)
    assert pending is not None
    assert marker(env.data / restore.PENDING_DB) == pending["source"]  # one staging's pair
    assert not (env.data / restore.STAGE_LOCK_FILE).exists()


def test_a_stale_stage_lock_file_is_taken_over(env: Env) -> None:
    import os
    import time

    lock = env.data / restore.STAGE_LOCK_FILE
    lock.write_bytes(b"")
    old = time.time() - 3600
    os.utime(lock, (old, old))
    stage(env, backup_file(env))
    assert restore.pending_info(env.data) is not None and not lock.exists()


def test_pre_restore_copies_are_pruned_by_stamp_and_counter_not_by_text(env: Env) -> None:
    names = [
        "pre-restore-20261113T033000Z.db",
        "pre-restore-20261113T033000Z-1.db",  # '-' sorts before '.': a text sort calls it older
        "pre-restore-20261113T033000Z-2.db",
        "pre-restore-20261113T033000Z-10.db",  # the newest; text order puts it before -2
        "pre-restore-20261112T033000Z.db",
    ]
    for n in names:
        (env.data / n).write_bytes(b"x")
        (env.data / (n + "-wal")).write_bytes(b"w")
    (env.data / "pre-restore-notes.db").write_bytes(b"not ours")  # not our name: never pruned
    restore._prune_pre_restore(env.data)
    left = sorted(p.name for p in env.data.glob("pre-restore-*.db"))
    assert left == [
        "pre-restore-20261113T033000Z-10.db",
        "pre-restore-20261113T033000Z-2.db",
        "pre-restore-notes.db",
    ]
    assert not (env.data / "pre-restore-20261113T033000Z.db-wal").exists()  # siblings go along
    assert (env.data / "pre-restore-20261113T033000Z-10.db-wal").exists()


# ------------------------------------------------------------ server lock / CLI


def test_server_lock_is_exclusive(tmp_path: Path) -> None:
    a, b = ServerLock(tmp_path), ServerLock(tmp_path)
    assert a.acquire()
    assert not b.acquire()
    a.release()
    assert b.acquire()
    b.release()


@pytest.fixture
def cli_env(env: Env, monkeypatch: pytest.MonkeyPatch) -> Env:
    monkeypatch.setenv("DATABASE_URL", env.url)
    monkeypatch.setenv("BACKUP_DIR", str(env.backups))
    for name in ("BACKUP_PASSPHRASE", "BACKUP_S3_ENDPOINT"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.chdir(env.data.parent)  # no stray .env
    get_settings.cache_clear()
    return env


def test_cli_run_and_list(cli_env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["list"]) == 0
    assert "no backups found" in capsys.readouterr().out
    assert cli.main(["run"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("ok: tickerglass-") and "local: ok" in out
    assert cli.main(["list"]) == 0
    assert ".db.gz" in capsys.readouterr().out
    assert len(list(cli_env.backups.glob("*.db.gz"))) == 1


def test_cli_run_without_a_target(
    cli_env: Env, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("BACKUP_DIR")
    get_settings.cache_clear()
    assert cli.main(["run"]) == 1
    assert "no backup target" in capsys.readouterr().err


def test_cli_restore_stages_a_file(cli_env: Env, capsys: pytest.CaptureFixture[str]) -> None:
    src = backup_file(cli_env)
    assert cli.main(["restore", str(src)]) == 0
    assert "restart the server" in capsys.readouterr().out
    assert restore.pending_info(cli_env.data) is not None
    assert cli.main(["restore", str(cli_env.data.parent / "missing.db.gz")]) == 1
    junk = cli_env.data.parent / "junk"
    junk.write_bytes(b"nope")
    assert cli.main(["restore", str(junk)]) == 1
    assert "not a TickerGlass backup" in capsys.readouterr().err
    assert cli.main(["restore", "s3://tickerglass-20261113T033000Z.db.gz"]) == 1
    assert "S3 backup target is not configured" in capsys.readouterr().err
    assert cli.main(["restore", "s3://../../etc/passwd"]) == 1


def test_cli_restore_apply_now_refuses_while_the_server_runs(
    cli_env: Env, capsys: pytest.CaptureFixture[str]
) -> None:
    src = backup_file(cli_env, mark="backup")
    lock = ServerLock(cli_env.data)
    assert lock.acquire()  # "the server"
    marker(cli_env.db, "live")
    assert cli.main(["restore", str(src), "--apply-now"]) == 1
    assert "server appears to be running" in capsys.readouterr().err
    assert marker(cli_env.db) == "live" and restore.pending_info(cli_env.data) is not None
    lock.release()
    assert cli.main(["restore", str(src), "--apply-now"]) == 0
    assert "restore applied" in capsys.readouterr().out
    assert marker(cli_env.db) == "backup"
    assert restore.pending_info(cli_env.data) is None


def test_cli_decrypt(
    cli_env: Env, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    enc = backup_file(cli_env, passphrase=PASSPHRASE)
    out = cli_env.data.parent / "plain.db.gz"
    assert cli.main(["decrypt", str(enc), str(out)]) == 1  # no passphrase, no terminal
    assert "BACKUP_PASSPHRASE" in capsys.readouterr().err
    monkeypatch.setenv("BACKUP_PASSPHRASE", "wrong passphrase here")
    get_settings.cache_clear()
    assert cli.main(["decrypt", str(enc), str(out)]) == 1
    assert "wrong passphrase" in capsys.readouterr().err
    assert not out.exists() and not out.with_name(out.name + ".part").exists()
    monkeypatch.setenv("BACKUP_PASSPHRASE", PASSPHRASE)
    get_settings.cache_clear()
    assert cli.main(["decrypt", str(enc), str(out)]) == 0
    assert out.read_bytes()[:2] == b"\x1f\x8b"
    assert cli.main(["decrypt", str(enc), str(out)]) == 1  # exists
    assert cli.main(["decrypt", str(out), str(out) + "2"]) == 1  # not encrypted
    assert "not an encrypted" in capsys.readouterr().err


def test_cli_decrypt_matches_the_restore_path(
    cli_env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    enc = backup_file(cli_env, passphrase=PASSPHRASE, mark="roundtrip")
    monkeypatch.setenv("BACKUP_PASSPHRASE", PASSPHRASE)
    get_settings.cache_clear()
    out = cli_env.data.parent / "o.gz"
    assert cli.main(["decrypt", str(enc), str(out)]) == 0
    stage(cli_env, out)
    assert marker(cli_env.data / restore.PENDING_DB) == "roundtrip"


def test_main_dispatches_the_backup_subcommand(
    cli_env: Env, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from tickerglass_api import __main__ as entry

    monkeypatch.setattr("sys.argv", ["tickerglass-api", "backup", "list"])
    with pytest.raises(SystemExit) as exit_info:
        entry.main()
    assert exit_info.value.code == 0
    assert "no backups found" in capsys.readouterr().out


# --------------------------------------------------------------- multipart


def body_of(boundary: str, parts: list[tuple[str, str | None, bytes]]) -> bytes:
    out = b""
    for name, filename, data in parts:
        disp = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else "")
        out += f"--{boundary}\r\nContent-Disposition: {disp}\r\n".encode()
        if filename:
            out += b"Content-Type: application/octet-stream\r\n"
        out += b"\r\n" + data + b"\r\n"
    return out + f"--{boundary}--\r\n".encode()


def read_parts(body: bytes, boundary: str, step: int) -> list[tuple[PartInfo, bytes]]:
    parts: list[tuple[PartInfo, bytes]] = []
    current: list[bytes] = []
    infos: list[PartInfo] = []

    def on_start(info: PartInfo) -> None:
        infos.append(info)
        current.clear()

    def on_end() -> None:
        parts.append((infos[-1], b"".join(current)))

    reader = MultipartReader(boundary.encode(), on_start, current.append, on_end)
    for i in range(0, len(body), step):
        reader.feed(body[i : i + step])
    reader.close()
    return parts


@pytest.mark.parametrize("step", [1, 2, 3, 7, 64, 100_000])
def test_multipart_any_chunking(step: int) -> None:
    payload = bytes(range(256)) * 50 + b"\r\n--A\r\n-"
    body = body_of(
        "B", [("passphrase", None, b"pw 1"), ("file", "x.gz", payload), ("z", None, b"")]
    )
    parts = read_parts(body, "B", step)
    assert [(p.name, p.filename, data) for p, data in parts] == [
        ("passphrase", None, b"pw 1"),
        ("file", "x.gz", payload),
        ("z", None, b""),
    ]


def test_multipart_preamble_and_epilogue_are_ignored() -> None:
    body = b"preamble\r\n" + body_of("B", [("a", None, b"1")]) + b"epilogue"
    assert [(p.name, d) for p, d in read_parts(body, "B", 5)] == [("a", b"1")]


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b'--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nno end',
        b'--B\r\nContent-Disposition: form-data; name="a"\r\n\r\nx\r\n--B',
        b"--Bxx\r\n",
        b"--B\r\nContent-Type: text/plain\r\n\r\nx\r\n--B--\r\n",
        b'--B\r\nContent-Disposition: attachment; name="a"\r\n\r\nx\r\n--B--\r\n',
        b"--B\r\nContent-Disposition: form-data\r\n\r\nx\r\n--B--\r\n",
        b"--B\r\n" + b"X: y\r\n" * 3000,
    ],
)
def test_multipart_rejects_malformed_bodies(body: bytes) -> None:
    with pytest.raises(MultipartError):
        read_parts(body, "B", 4)


def test_boundary_parsing() -> None:
    assert boundary_of("multipart/form-data; boundary=abc123") == b"abc123"
    assert boundary_of('multipart/form-data; boundary="a b"') == b"a b"
    for bad in (
        None,
        "",
        "application/json",
        "multipart/form-data",
        'multipart/form-data; boundary=""',
    ):
        with pytest.raises(MultipartError):
            boundary_of(bad)
