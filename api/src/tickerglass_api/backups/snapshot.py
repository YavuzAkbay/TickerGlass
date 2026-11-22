"""A consistent, compressed (and optionally encrypted) copy of the SQLite database.

`sqlite_copy` is the online copy `GET /server/backup` serves as well. `make_snapshot` adds the
steps of a scheduled backup (docs/design/scheduled-backups.md "Snapshot"): clear the market cache
on the copy, VACUUM, integrity check, gzip, encrypt. Everything is streamed through files in the
data dir's `backups-tmp/` (same filesystem as the database, never whole-file in memory)."""

import gzip
import hashlib
import logging
import os
import shutil
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from ..services.cache_source import clear_market_tables
from .crypto import encrypt_stream
from .naming import make_name

log = logging.getLogger(__name__)

TMP_DIR_NAME = "backups-tmp"
GZIP_LEVEL = 6
COPY_CHUNK = 1 << 20
#: Wait this long for a busy database (a VACUUM of the live file) before giving up.
BUSY_TIMEOUT_S = 60.0


class SnapshotError(Exception):
    """The snapshot could not be made or did not pass its checks; the message is safe to show."""


@dataclass(frozen=True)
class Snapshot:
    path: Path
    name: str
    size: int
    sha256: str
    revision: str | None
    encrypted: bool
    created_at: datetime
    app_version: str
    includes_cache: bool
    #: This server's backup identity (`backups/instance.py`); retention only deletes backups
    #: that carry it.
    instance_id: str | None = None

    def metadata(self) -> dict[str, object]:
        """The content of the `.json` stored next to the backup."""
        meta: dict[str, object] = {
            "name": self.name,
            "createdAt": self.created_at.isoformat(),
            "appVersion": self.app_version,
            "schemaRevision": self.revision,
            "sha256": self.sha256,
            "size": self.size,
            "encrypted": self.encrypted,
            "includesCache": self.includes_cache,
        }
        if self.instance_id:
            meta["instanceId"] = self.instance_id
        return meta


def tmp_dir(data_dir: Path) -> Path:
    """The working folder (created 0700)."""
    path = data_dir / TMP_DIR_NAME
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    return path


def clean_tmp(data_dir: Path) -> int:
    """Remove what an interrupted run left in `backups-tmp/` (at startup); returns the count."""
    path = data_dir / TMP_DIR_NAME
    if not path.is_dir():
        return 0
    removed = 0
    for entry in path.iterdir():
        try:
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
            removed += 1
        except OSError:
            log.warning("could not remove %s", entry)
    return removed


def sqlite_copy(src: Path, dest: Path) -> None:
    """Consistent online copy of the SQLite file `src` (WAL included) into the new file `dest`,
    through a read-only connection."""
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=BUSY_TIMEOUT_S)
    try:
        target = sqlite3.connect(dest)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()


def integrity_error(db: Path) -> str | None:
    """None when `PRAGMA integrity_check` says ok, else a short reason."""
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            con.execute("PRAGMA trusted_schema=OFF")  # the file may be an untrusted upload
            rows = [str(row[0]) for row in con.execute("PRAGMA integrity_check")]
        finally:
            con.close()
    except sqlite3.Error as exc:
        return f"not a readable SQLite database ({type(exc).__name__})"
    if rows == ["ok"]:
        return None
    return "integrity check failed: " + "; ".join(rows[:3])[:200]


def read_revision(db: Path) -> str | None:
    """The `alembic_version` of the database; None when the table is missing or empty."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        try:
            rows = con.execute("SELECT version_num FROM alembic_version").fetchall()
        except sqlite3.Error:
            return None
    finally:
        con.close()
    return str(rows[0][0]) if len(rows) == 1 else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(COPY_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def gzip_file(src: Path, dest: Path) -> None:
    with (
        src.open("rb") as fin,
        dest.open("wb") as raw,
        gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=GZIP_LEVEL, mtime=0) as fout,
    ):
        shutil.copyfileobj(fin, fout, COPY_CHUNK)


def _prepare_copy(copy: Path, *, include_cache: bool) -> None:
    """Clear the cache on the copy (as `POST /server/cache/clear` does), leave WAL mode so the
    copy is one self-contained file, VACUUM it."""
    if not include_cache:
        engine = create_engine(f"sqlite:///{copy}")
        try:
            with Session(engine) as session, session.begin():
                clear_market_tables(session)
        finally:
            engine.dispose()
    con = sqlite3.connect(copy, isolation_level=None)
    try:
        con.execute("PRAGMA journal_mode=DELETE")
        if not include_cache:
            con.execute("VACUUM")
    finally:
        con.close()


def make_snapshot(
    db_path: Path,
    data_dir: Path,
    *,
    include_cache: bool,
    passphrase: str | None,
    app_version: str,
    now: datetime | None = None,
    instance_id: str | None = None,
) -> Snapshot:
    """Snapshot `db_path` into `backups-tmp/`. The caller uploads `Snapshot.path` and deletes it.
    Raises `SnapshotError` (or `BackupCryptoError` from the encryption step) on failure; nothing
    is left behind in that case."""
    created = (now or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    if not db_path.is_file():
        raise SnapshotError("no SQLite database file found")
    work = tmp_dir(data_dir)
    token = uuid.uuid4().hex[:12]
    copy = work / f"snapshot-{token}.db"
    gz = work / f"snapshot-{token}.db.gz"
    final = work / f"snapshot-{token}.out"
    made: list[Path] = [copy, gz, final]
    try:
        try:
            sqlite_copy(db_path, copy)
            _prepare_copy(copy, include_cache=include_cache)
        except sqlite3.Error as exc:
            raise SnapshotError(f"could not copy the database: {exc}") from exc
        problem = integrity_error(copy)
        if problem is not None:
            raise SnapshotError(problem)
        revision = read_revision(copy)
        gzip_file(copy, gz)
        copy.unlink()
        if passphrase:
            with gz.open("rb") as fin, final.open("wb") as fout:
                encrypt_stream(fin, fout, passphrase)
            gz.unlink()
        else:
            gz.replace(final)
        size = final.stat().st_size
        digest = _sha256(final)
        name = make_name(created, encrypted=bool(passphrase))
        out = work / f"{token}-{name}"
        final.replace(out)
        made.append(out)
        os.chmod(out, 0o600)
    except BaseException:
        for path in made:
            path.unlink(missing_ok=True)
        raise
    return Snapshot(
        path=out,
        name=name,
        size=size,
        sha256=digest,
        revision=revision,
        encrypted=bool(passphrase),
        created_at=created,
        app_version=app_version,
        includes_cache=include_cache,
        instance_id=instance_id,
    )
