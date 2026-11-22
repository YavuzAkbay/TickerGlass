"""Restore, in two phases; a live database is never overwritten.

1. **Stage** (`stage_file`, `stage_from_target`): decrypt if needed (into a temp file; a failed
   decryption leaves nothing behind), gunzip with a size cap, validate, and only then put the
   result at `<data>/restore-pending.db` (+ `restore-pending.json`).
2. **Apply** (`apply_pending`, at startup before the migrations): validate the staged file
   again; move the live database (and its `-wal`/`-shm`) to `pre-restore-<ts>.db`, move the
   staged file in; the migrations then upgrade an older backup. Any failure leaves the live
   database as it was (fail closed) and is recorded in `restore-result.json`.

A backup is accepted only if it is an intact SQLite file (header, `integrity_check`) whose
`alembic_version` revision this code knows (a revision it does not know means the backup comes
from a newer TickerGlass and is refused; an older one is upgraded by the migrations), that has
the `users` table once the schema is multi-user (`MULTI_USER_REVISION`), and that holds nothing
but plain tables and plain-column indexes (see `validate_db`: no triggers, views, virtual tables,
generated columns, expression or partial indexes).
"""

import contextlib
import gzip
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import time
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO, cast

from ..db import migration_chain
from .crypto import BackupCryptoError, decrypt_stream, is_encrypted
from .snapshot import clean_tmp, integrity_error, tmp_dir
from .targets import Target

try:  # POSIX only; without it nothing can prove the server is stopped
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

PENDING_DB = "restore-pending.db"
PENDING_META = "restore-pending.json"
RESULT_FILE = "restore-result.json"
LOCK_FILE = ".tickerglass-server.lock"
STAGE_LOCK_FILE = ".restore-stage.lock"
KEEP_PRE_RESTORE = 2
SQLITE_HEADER = b"SQLite format 3\x00"
GZIP_MAGIC = b"\x1f\x8b"
COPY_CHUNK = 1 << 20
#: First revision with the `users` table (multi-user, roadmap 2.2). Older backups have none; the
#: migrations create the Owner when they upgrade them.
MULTI_USER_REVISION = "a91c4d7e2b60"
#: A stage lock file older than this is a crashed process's leftover.
STAGE_LOCK_STALE_S = 60.0
STAGE_LOCK_WAIT_S = 15.0
NO_SPACE_STATUS = 507


class RestoreError(Exception):
    """The backup cannot be restored; the message is safe to show. `status` is the HTTP code."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------- validation


def _check_header(path: Path) -> None:
    try:
        with path.open("rb") as fh:
            if fh.read(len(SQLITE_HEADER)) != SQLITE_HEADER:
                raise RestoreError("not a TickerGlass backup (not a SQLite database)")
    except OSError as exc:
        raise RestoreError(f"cannot read the backup: {exc.strerror or exc}") from exc


def _hardened(path: Path) -> sqlite3.Connection:
    """Read-only connection to an untrusted database: `trusted_schema` off (no unsafe functions
    from views/triggers/defaults) and, where Python has it (3.12+), SQLite's defensive mode."""
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        con.execute("PRAGMA trusted_schema=OFF")
        setconfig = getattr(con, "setconfig", None)
        defensive = getattr(sqlite3, "SQLITE_DBCONFIG_DEFENSIVE", None)
        if setconfig is not None and defensive is not None:
            setconfig(defensive, True)
    except BaseException:
        con.close()
        raise
    return con


def _refuse_active_content(con: sqlite3.Connection) -> None:
    """A TickerGlass database holds plain tables and plain-column indexes only. Anything that
    runs SQL by itself once the app writes to the restored file is refused: triggers (e.g.
    `AFTER INSERT ON users ... SET is_admin=1`), views, virtual tables, generated columns,
    and indexes on expressions or with a WHERE clause.

    This checks *structure* with SQLite's own parser (`index_xinfo` flags expression columns,
    `index_list` partial indexes) rather than matching names: our migrations make only
    plain-column indexes, and a name allow-list would have to enumerate every historical
    revision."""
    schema = con.execute("SELECT type, name, tbl_name, sql FROM sqlite_master").fetchall()
    for kind, name, _tbl, sql in schema:
        if kind in ("trigger", "view"):
            raise RestoreError(
                f"the backup contains a {kind} ({str(name)[:40]}), which a TickerGlass backup "
                "never has"
            )
        if kind == "table" and re.match(r"\s*create\s+virtual\s", str(sql or ""), re.IGNORECASE):
            raise RestoreError(
                f"the backup contains a virtual table ({str(name)[:40]}), which a TickerGlass "
                "backup never has"
            )
    for kind, name, tbl, _sql in schema:
        if kind == "index":
            columns = con.execute("SELECT cid FROM pragma_index_xinfo(?)", (name,)).fetchall()
            if any(cid == -2 for (cid,) in columns):
                raise RestoreError(
                    f"the backup contains an index on an expression ({str(name)[:40]}), which a "
                    "TickerGlass backup never has"
                )
            partial = con.execute(
                "SELECT partial FROM pragma_index_list(?) WHERE name = ?", (tbl, name)
            ).fetchone()
            if partial is not None and partial[0]:
                raise RestoreError(
                    f"the backup contains a partial index ({str(name)[:40]}), which a "
                    "TickerGlass backup never has"
                )
        elif kind == "table":
            generated = con.execute(
                "SELECT count(*) FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)", (name,)
            ).fetchone()
            if generated is not None and generated[0]:
                raise RestoreError(
                    f"the backup contains a generated column ({str(name)[:40]}), which a "
                    "TickerGlass backup never has"
                )


def validate_db(path: Path) -> str:
    """Check the staged/backup database `path`; returns its schema revision. Raises
    `RestoreError`. Run at staging and again at apply time."""
    _check_header(path)
    problem = integrity_error(path)
    if problem is not None:
        raise RestoreError(f"the backup is damaged: {problem}")
    try:
        con = _hardened(path)
        try:
            tables = {
                str(r[0]) for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
            if "alembic_version" not in tables:
                raise RestoreError("not a TickerGlass backup (alembic_version table missing)")
            rows = con.execute("SELECT version_num FROM alembic_version").fetchall()
            if len(rows) != 1 or not rows[0][0]:
                raise RestoreError("not a TickerGlass backup (no schema revision)")
            revision = str(rows[0][0])
            chain = migration_chain()
            if revision not in chain:
                raise RestoreError(
                    "this backup is from a newer TickerGlass (schema revision unknown to this "
                    "version); update the server first"
                )
            if chain.index(revision) >= chain.index(MULTI_USER_REVISION) and "users" not in tables:
                raise RestoreError("not a TickerGlass backup (users table missing)")
            _refuse_active_content(con)
        finally:
            con.close()
    except sqlite3.Error as exc:
        raise RestoreError(f"the backup is damaged: {exc}") from exc
    return revision


def _normalize(path: Path) -> None:
    """Leave WAL mode so the file is self-contained (a downloaded backup keeps the flag)."""
    try:
        con = sqlite3.connect(path, isolation_level=None)
        try:
            con.execute("PRAGMA trusted_schema=OFF")
            con.execute("PRAGMA journal_mode=DELETE")
        finally:
            con.close()
    except sqlite3.Error as exc:
        raise RestoreError(f"the backup is damaged: {exc}") from exc


# ------------------------------------------------------------------------ staging


def pending_db(data_dir: Path) -> Path:
    return data_dir / PENDING_DB


def pending_info(data_dir: Path) -> dict[str, Any] | None:
    """`{source, stagedAt, revision}` of the staged restore; None when nothing is staged."""
    if not pending_db(data_dir).is_file():
        return None
    try:
        meta = json.loads((data_dir / PENDING_META).read_text())
        return {
            "source": str(meta.get("source", "")),
            "stagedAt": str(meta.get("stagedAt", "")),
            "revision": meta.get("revision"),
        }
    except (OSError, ValueError, AttributeError):
        return {"source": "unknown", "stagedAt": "", "revision": None}


def last_result(data_dir: Path) -> dict[str, Any] | None:
    """Outcome of the last startup apply (`applied` / `failed`), None if there was none."""
    try:
        value = json.loads((data_dir / RESULT_FILE).read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


#: Serializes staging and cancelling inside this process; `_stage_file_lock` does it across
#: processes (the CLI and the server may both stage).
_STAGE_LOCK = threading.Lock()


@contextlib.contextmanager
def _stage_lock(data_dir: Path) -> Iterator[None]:
    """Exclusive hold on the pending-restore files while their meta and db are replaced, so
    two concurrent stagings never leave one's meta next to the other's database."""
    with _STAGE_LOCK:
        path = data_dir / STAGE_LOCK_FILE
        deadline = time.monotonic() + STAGE_LOCK_WAIT_S
        while True:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                os.close(fd)
                break
            except FileExistsError:
                try:
                    if time.time() - path.stat().st_mtime > STAGE_LOCK_STALE_S:
                        path.unlink(missing_ok=True)  # a crashed process's leftover
                        continue
                except OSError:
                    continue
                if time.monotonic() > deadline:
                    raise RestoreError("another restore is being staged; try again", 409) from None
                time.sleep(0.05)
        try:
            yield
        finally:
            path.unlink(missing_ok=True)


def cancel_pending(data_dir: Path) -> bool:
    """Delete the staged restore; True when there was one."""
    with _stage_lock(data_dir):
        existed = pending_db(data_dir).exists()
        for name in (PENDING_DB, PENDING_META, PENDING_DB + "-wal", PENDING_DB + "-shm"):
            (data_dir / name).unlink(missing_ok=True)
    return existed


def _mb(size: int) -> int:
    return max(1, round(size / (1 << 20)))


def _limit_message(restore_max_mb: int) -> str:
    return f"larger than the restore limit of {restore_max_mb} MB (BACKUP_RESTORE_MAX_MB)"


def _gunzip(src: Path, dest: Path, cap: int, restore_max_mb: int) -> None:
    total = 0
    try:
        with gzip.open(src, "rb") as fin, dest.open("wb") as fout:
            while chunk := fin.read(COPY_CHUNK):
                total += len(chunk)
                if total > cap:
                    raise RestoreError(
                        f"the backup is {_limit_message(restore_max_mb)} once decompressed"
                    )
                fout.write(chunk)
    except (OSError, EOFError, zlib.error) as exc:
        if isinstance(exc, OSError) and not isinstance(exc, gzip.BadGzipFile):
            raise RestoreError(f"cannot unpack the backup: {exc.strerror or exc}") from exc
        raise RestoreError("the backup is damaged (bad gzip data)") from None


def _expected_size(path: Path, is_gzip: bool, cap: int) -> int:
    """Size the database will have once unpacked: the gzip trailer's ISIZE (the size modulo
    4 GiB, so a value below the file's own size is a wrap-around and means "unknown": the cap)."""
    size = path.stat().st_size
    if not is_gzip:
        return size
    try:
        with path.open("rb") as fh:
            fh.seek(-4, os.SEEK_END)
            isize = int.from_bytes(fh.read(4), "little")
    except OSError:
        return cap
    return isize if isize >= size else cap


def _ensure_space(work: Path, need: int) -> None:
    """Refuse to start when the work folder's disk cannot hold `need` bytes."""
    try:
        free = shutil.disk_usage(work).free
    except OSError:
        return  # cannot tell; staging reports a full disk itself
    if free < need:
        raise RestoreError(
            f"not enough free disk space to stage the backup: about {_mb(need)} MB are needed "
            f"and {_mb(free)} MB are free",
            NO_SPACE_STATUS,
        )


class _CappedWriter:
    """File-like wrapper that refuses more than `cap` bytes (fetching from a target)."""

    def __init__(self, fh: BinaryIO, cap: int, restore_max_mb: int) -> None:
        self._fh = fh
        self._cap = cap
        self._max_mb = restore_max_mb
        self._total = 0

    def write(self, data: bytes) -> int:
        self._total += len(data)
        if self._total > self._cap:
            raise RestoreError(f"the backup file is {_limit_message(self._max_mb)}")
        return self._fh.write(data)


def stage_file(
    src: Path,
    data_dir: Path,
    *,
    passphrase: str | None,
    source: str,
    restore_max_mb: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Stage the backup file `src` (`.db.gz.enc`, `.db.gz` or a plain `.db`, detected by content)
    as the pending restore. Returns the `pending_info`. Raises `RestoreError`. `restore_max_mb`
    caps the backup's size as read and once decompressed; free disk space is checked first."""
    work = tmp_dir(data_dir)
    scratch: list[Path] = []
    cap = restore_max_mb << 20

    def scratch_file(suffix: str) -> Path:
        path = work / f"restore-{os.urandom(6).hex()}{suffix}"
        scratch.append(path)
        return path

    try:
        current = src
        if src.stat().st_size > cap:
            raise RestoreError(f"the backup file is {_limit_message(restore_max_mb)}")
        with current.open("rb") as fh:
            head = fh.read(len(SQLITE_HEADER))
        if is_encrypted(head):
            if not passphrase:
                raise RestoreError(
                    "this backup is encrypted: set BACKUP_PASSPHRASE (or enter the passphrase)"
                )
            _ensure_space(work, src.stat().st_size)  # the decrypted copy
            decrypted = scratch_file(".dec")
            try:
                with current.open("rb") as fin, decrypted.open("wb") as fout:
                    decrypt_stream(fin, fout, passphrase)
            except BackupCryptoError as exc:
                raise RestoreError(str(exc)) from None
            except OSError as exc:
                raise RestoreError(f"cannot read the backup: {exc.strerror or exc}") from exc
            current = decrypted
            with current.open("rb") as fh:
                head = fh.read(len(SQLITE_HEADER))
        is_gzip = head.startswith(GZIP_MAGIC)
        if not is_gzip and head != SQLITE_HEADER:
            raise RestoreError("not a TickerGlass backup")
        # The unpacked database, plus the same again for the checks that follow.
        _ensure_space(work, min(cap, 2 * _expected_size(current, is_gzip, cap)))
        staged = scratch_file(".db")
        if is_gzip:
            _gunzip(current, staged, cap, restore_max_mb)
        else:
            shutil.copyfile(current, staged)
        _check_header(staged)
        _normalize(staged)
        revision = validate_db(staged)
        info = {
            "source": source,
            "stagedAt": (now or datetime.now(UTC)).astimezone(UTC).isoformat(),
            "revision": revision,
        }
        meta = scratch_file(".json")
        meta.write_text(json.dumps(info))
        os.chmod(staged, 0o600)
        with _stage_lock(data_dir):
            # Meta first: a pending db without its meta is shown as "unknown source", never the
            # other way round.
            os.replace(meta, data_dir / PENDING_META)
            os.replace(staged, pending_db(data_dir))
        return info
    except OSError as exc:
        raise RestoreError(f"cannot stage the backup: {exc.strerror or exc}", 500) from exc
    finally:
        for path in scratch:
            path.unlink(missing_ok=True)


def stage_from_target(
    target: Target,
    name: str,
    data_dir: Path,
    *,
    passphrase: str | None,
    restore_max_mb: int,
) -> dict[str, Any]:
    """Fetch backup `name` from `target` (at most `restore_max_mb`) and stage it.
    `TargetError`/`NotFound` pass through."""
    work = tmp_dir(data_dir)
    path = work / f"fetch-{os.urandom(6).hex()}"
    try:
        with path.open("wb") as fh:
            _fetch(
                target,
                name,
                cast(BinaryIO, _CappedWriter(fh, restore_max_mb << 20, restore_max_mb)),
            )
        return stage_file(
            path,
            data_dir,
            passphrase=passphrase,
            source=f"{target.kind}:{name}",
            restore_max_mb=restore_max_mb,
        )
    except OSError as exc:  # the fetch's own file (a full disk, ...)
        raise RestoreError(f"cannot fetch the backup: {exc.strerror or exc}", 500) from exc
    finally:
        path.unlink(missing_ok=True)


def _fetch(target: Target, name: str, fh: BinaryIO) -> None:
    target.fetch(name, fh)


# ------------------------------------------------------------------------ applying


@dataclass(frozen=True)
class ApplyResult:
    status: str  # applied | failed
    at: str
    source: str
    revision: str | None = None
    error: str | None = None
    pre_restore: str | None = None

    def json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"status": self.status, "at": self.at, "source": self.source}
        if self.revision:
            out["revision"] = self.revision
        if self.error:
            out["error"] = self.error
        if self.pre_restore:
            out["preRestore"] = self.pre_restore
        return out


def _record(data_dir: Path, result: ApplyResult) -> None:
    try:
        tmp = data_dir / (RESULT_FILE + ".part")
        tmp.write_text(json.dumps(result.json()))
        os.replace(tmp, data_dir / RESULT_FILE)
    except OSError:
        log.warning("could not record the restore result")


def _siblings(path: Path) -> list[Path]:
    return [Path(str(path) + suffix) for suffix in ("", "-wal", "-shm")]


_PRE_RESTORE = re.compile(r"pre-restore-(\d{8}T\d{6}Z)(?:-(\d+))?\.db")


def _pre_restore_key(path: Path) -> tuple[str, int] | None:
    """`(stamp, counter)` of a `pre-restore-<stamp>[-<counter>].db` name, None for any other
    name. A string sort would put `...Z-1.db` before `...Z.db` ('-' < '.') and `-10` before `-2`."""
    match = _PRE_RESTORE.fullmatch(path.name)
    if match is None:
        return None
    return match.group(1), int(match.group(2) or 0)


def _prune_pre_restore(data_dir: Path) -> None:
    """Keep the newest `KEEP_PRE_RESTORE` copies; files that are not ours are left alone."""
    keyed = [(key, p) for p in data_dir.glob("pre-restore-*.db") if (key := _pre_restore_key(p))]
    keyed.sort(key=lambda item: item[0], reverse=True)
    for _key, old in keyed[KEEP_PRE_RESTORE:]:
        for path in _siblings(old):
            with contextlib.suppress(OSError):
                path.unlink(missing_ok=True)


def apply_pending(db_path: Path, now: datetime | None = None) -> ApplyResult | None:
    """Swap in the staged restore next to `db_path`, if there is one (run before the migrations
    and before anything opens the database). Returns None when nothing was pending."""
    data_dir = db_path.resolve().parent
    pending = pending_db(data_dir)
    if not pending.exists():
        return None
    when = (now or datetime.now(UTC)).astimezone(UTC)
    at = when.isoformat()
    info = pending_info(data_dir) or {}
    source = str(info.get("source") or "unknown")

    def fail(message: str) -> ApplyResult:
        log.error("restore NOT applied, the database is untouched: %s", message)
        result = ApplyResult("failed", at, source, error=message[:300])
        cancel_pending(data_dir)
        _record(data_dir, result)
        return result

    try:
        revision = validate_db(pending)
    except RestoreError as exc:
        return fail(str(exc))
    except Exception as exc:
        return fail(f"validation failed ({type(exc).__name__})")

    moved: list[tuple[Path, Path]] = []
    pre_name: str | None = None
    try:
        if db_path.exists():
            stamp = when.strftime("%Y%m%dT%H%M%SZ")
            pre = data_dir / f"pre-restore-{stamp}.db"
            counter = 0
            while pre.exists():
                counter += 1
                pre = data_dir / f"pre-restore-{stamp}-{counter}.db"
            for src, dst in zip(_siblings(db_path), _siblings(pre), strict=True):
                if src.exists():
                    os.replace(src, dst)
                    moved.append((src, dst))
            pre_name = pre.name
        os.replace(pending, db_path)
    except OSError as exc:
        for src, dst in reversed(moved):  # put the live database back
            with contextlib.suppress(OSError):
                os.replace(dst, src)
        return fail(f"could not swap the database files: {exc.strerror or exc}")
    for leftover in (PENDING_META, PENDING_DB + "-wal", PENDING_DB + "-shm"):
        (data_dir / leftover).unlink(missing_ok=True)
    _prune_pre_restore(data_dir)
    result = ApplyResult("applied", at, source, revision=revision, pre_restore=pre_name)
    _record(data_dir, result)
    log.warning(
        "RESTORE APPLIED from %s (schema %s); the previous database is kept as %s",
        source,
        revision,
        pre_name or "(there was none)",
    )
    return result


def rollback_applied(db_path: Path, applied: ApplyResult, exc: BaseException) -> ApplyResult:
    """The migrations failed on the database `applied` swapped in: put the pre-restore copy
    back (with its `-wal`/`-shm`), drop the restored file, and record `failed` in
    `restore-result.json` (the reason is the error's type only, nothing from its message)."""
    data_dir = db_path.resolve().parent
    reason = (
        f"the database migrations failed on the restored backup ({type(exc).__name__}); "
        "the previous database was put back"
    )
    for path in _siblings(db_path):
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)
    pre = data_dir / applied.pre_restore if applied.pre_restore else None
    put_back = True
    if pre is not None:
        for src, dst in zip(_siblings(pre), _siblings(db_path), strict=True):
            if src.exists():
                try:
                    os.replace(src, dst)
                except OSError:
                    put_back = False
                    log.error("could not put %s back; it is still in %s", dst.name, data_dir)
    if not put_back:
        reason = (
            "the database migrations failed on the restored backup and the previous database "
            f"could not be put back automatically: it is {applied.pre_restore} in the data folder"
        )
    result = ApplyResult("failed", applied.at, applied.source, error=reason)
    _record(data_dir, result)
    log.error("restore rolled back: %s", reason)
    return result


# --------------------------------------------------------------------- server lock


class ServerLock:
    """Exclusive `flock` the running server holds on `<data>/.tickerglass-server.lock`: the CLI
    applies a restore itself only when it can take it (the server is not running). The kernel
    drops it when the process dies, so a crash never leaves it stuck."""

    def __init__(self, data_dir: Path) -> None:
        self._path = data_dir / LOCK_FILE
        self._fd: int | None = None

    @staticmethod
    def available() -> bool:
        """Whether this platform can lock at all (POSIX); without it nothing can be proven."""
        return fcntl is not None

    def acquire(self) -> bool:
        if fcntl is None:
            return False
        try:
            fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            return False
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self._fd = fd
        return True

    def release(self) -> None:
        if self._fd is not None:
            with contextlib.suppress(OSError):
                os.close(self._fd)  # closing drops the flock
            self._fd = None


def startup_restore(
    db_path: Path, lock: ServerLock, now: datetime | None = None
) -> ApplyResult | None:
    """Server startup, before the migrations: with the data folder's lock held, clear the work
    folder and apply a staged restore (returns its result). Both change files another process
    may be using (its temp files, the live database), so without the lock they are skipped:
    ERROR in the log, and a staged restore stays staged with a `failed` result saying why. A
    platform that cannot lock at all (no `fcntl`) proceeds, as it did before locks existed."""
    data_dir = db_path.resolve().parent
    if lock.acquire() or not ServerLock.available():
        return _apply_locked(db_path, data_dir, now)
    log.error(
        "could not lock %s: another process is using this data folder; the work folder is not "
        "cleaned and a staged restore is not applied (stop the other process, then restart)",
        data_dir,
    )
    if pending_db(data_dir).exists():
        source = str((pending_info(data_dir) or {}).get("source") or "unknown")
        _record(
            data_dir,
            ApplyResult(
                "failed",
                (now or datetime.now(UTC)).astimezone(UTC).isoformat(),
                source,
                error=(
                    "not applied: another process holds this data folder; "
                    "the restore stays staged until a server can start with it to itself"
                ),
            ),
        )
    return None


def _apply_locked(db_path: Path, data_dir: Path, now: datetime | None) -> ApplyResult | None:
    clean_tmp(data_dir)
    # A staged restore replaces the database before anything opens it (and before the
    # migrations, which then upgrade an older backup). Failure leaves it untouched.
    return apply_pending(db_path, now)
