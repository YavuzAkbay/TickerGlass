"""One backup run: snapshot, write to every target, retention, run record.

`BackupService.claim` takes the cross-process lease (`job_leases` row `backup`) and logs a
`running` row; `execute` does the work (blocking: run it on a worker thread) and finishes the
row. Targets fail independently (status `partial`); retention only runs on targets this run
wrote to successfully, and never deletes the backup just made.

Errors stored in `backup_runs.error`, returned by the API and logged are sanitized: S3 failures
show the S3 error code only, and the passphrase and S3 keys are masked wherever they might
have ended up in a message."""

import json
import logging
import re
import sqlite3
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, delete, select, update
from sqlalchemy.orm import Session

from .. import __version__
from ..models import BackupRun
from ..services.screener.lease import RENEW_EVERY, Lease
from ..settings import Settings
from .crypto import BackupCryptoError
from .instance import instance_id
from .retention import Policy, apply_retention
from .s3 import S3Error
from .snapshot import SnapshotError, make_snapshot
from .targets import BackupFile, Target, TargetError, configured_targets

log = logging.getLogger(__name__)

LEASE_NAME = "backup"
#: Run records kept.
KEEP_RUNS = 100
ERROR_MAX = 500
_SAFE_ERRORS = (TargetError, SnapshotError, BackupCryptoError)


class RunInProgress(Exception):
    """A backup is already running (here or in another process)."""


class NotSupported(Exception):
    """Backups need a SQLite database file."""


class NoTargets(Exception):
    """No backup target is configured."""


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


class BackupService:
    def __init__(
        self,
        engine: Engine,
        settings: Settings,
        *,
        clock: Callable[[], datetime] | None = None,
        app_version: str = __version__,
        owner: str | None = None,
        data_dir: Path | None = None,
    ) -> None:
        self.engine = engine
        self.settings = settings
        self._clock = clock or (lambda: datetime.now(UTC))
        self._app_version = app_version
        database = engine.url.database
        self.db_path: Path | None = (
            Path(database)
            if engine.dialect.name == "sqlite" and database and database != ":memory:"
            else None
        )
        self.data_dir: Path | None = data_dir or (
            self.db_path.resolve().parent if self.db_path else None
        )
        self.lease = Lease(engine, LEASE_NAME, owner=owner)
        self._lock = threading.Lock()
        self._active: int | None = None
        self._thread: threading.Thread | None = None

    # -- configuration ------------------------------------------------------

    @property
    def supported(self) -> bool:
        """SQLite with a database file; Postgres uses pg_dump."""
        return self.db_path is not None

    def targets(self) -> list[Target]:
        return configured_targets(self.settings)

    @property
    def enabled(self) -> bool:
        return self.supported and self.settings.backup_enabled and bool(self.targets())

    @property
    def encrypted(self) -> bool:
        return bool(self.settings.backup_passphrase)

    def now(self) -> datetime:
        return self._clock().astimezone(UTC)

    def policy(self) -> Policy:
        s = self.settings
        return Policy(s.backup_keep_daily, s.backup_keep_weekly, s.backup_keep_monthly)

    def sanitize(self, exc: BaseException) -> str:
        """Text of `exc` that is safe to store, return and log."""
        if isinstance(exc, S3Error):
            return f"S3 {exc.code}"
        text = str(exc) if isinstance(exc, _SAFE_ERRORS) else f"{type(exc).__name__}: {exc}"
        return self.redact(text)

    def redact(self, text: str) -> str:
        s = self.settings
        for secret in (
            s.backup_passphrase_value,
            s.backup_s3_secret_value,
            s.backup_s3_access_key_id,
        ):
            if secret:
                text = text.replace(secret, "[redacted]")
        return re.sub(r"\s+", " ", text).strip()[:ERROR_MAX]

    # -- runs ---------------------------------------------------------------

    def claim(self, trigger: str) -> int:
        """Take the lease and log a `running` row (blocking); returns its id. Raises
        `NotSupported`, `NoTargets` or `RunInProgress`."""
        if not self.supported:
            raise NotSupported("backups are available for SQLite; for Postgres use pg_dump")
        if not self.targets():
            raise NoTargets("no backup target is configured")
        with self._lock:
            if self._active is not None:
                raise RunInProgress("a backup is already running")
            now = self.now()
            if not self.lease.acquire(now):
                raise RunInProgress("another process is running a backup")
            try:
                run_id = self._insert_run(trigger, now)
            except BaseException:
                self.lease.release()
                raise
            self._active = run_id
        return run_id

    def _insert_run(self, trigger: str, now: datetime) -> int:
        with Session(self.engine) as session, session.begin():
            # Holding the lease: a row still `running` belongs to a process that died.
            session.execute(
                update(BackupRun)
                .where(BackupRun.status == "running")
                .values(status="failed", finished_at=now, error="interrupted (server stopped)")
            )
            row = BackupRun(started_at=now, trigger=trigger, status="running")
            session.add(row)
            session.flush()
            run_id = row.id
            keep = session.scalars(
                select(BackupRun.id).order_by(BackupRun.id.desc()).limit(KEEP_RUNS)
            ).all()
            if len(keep) == KEEP_RUNS:
                session.execute(delete(BackupRun).where(BackupRun.id < min(keep)))
        return run_id

    def run(self, trigger: str = "manual") -> int:
        """Claim and execute a run on the calling thread; returns the run id."""
        run_id = self.claim(trigger)
        self.execute(run_id)
        return run_id

    def start(self, trigger: str = "manual") -> int:
        """Claim a run and execute it on a background thread; returns the run id."""
        run_id = self.claim(trigger)
        thread = threading.Thread(
            target=self.execute, args=(run_id,), name="backup-run", daemon=True
        )
        self._thread = thread
        thread.start()
        return run_id

    def join(self, timeout: float | None = None) -> None:
        """Wait for a run started with `start` (shutdown, tests)."""
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    @property
    def running(self) -> bool:
        return self._active is not None

    def execute(self, run_id: int) -> None:
        """Do the run `claim` returned; always finishes the row and releases the lease."""
        stop = threading.Event()
        renewer = threading.Thread(
            target=self._renew, args=(stop,), name="backup-lease", daemon=True
        )
        renewer.start()
        try:
            try:
                outcome = self._work()
            except Exception as exc:
                message = self.sanitize(exc)
                log.error("backup failed: %s", message)
                log.debug("backup failure detail", exc_info=True)
                outcome = {"status": "failed", "error": message[:ERROR_MAX]}
            self._finish(run_id, outcome)
        finally:
            stop.set()
            renewer.join(5)
            with self._lock:
                self._active = None
            try:
                self.lease.release()
            except Exception:
                log.warning("could not release the backup lease")

    def _renew(self, stop: threading.Event) -> None:
        while not stop.wait(RENEW_EVERY.total_seconds()):
            try:
                if not self.lease.renew(self.now()):
                    log.warning("the backup lease was taken over while a run was in progress")
            except Exception:
                log.warning("could not renew the backup lease")

    def _finish(self, run_id: int, values: dict[str, Any]) -> None:
        with Session(self.engine) as session, session.begin():
            session.execute(
                update(BackupRun)
                .where(BackupRun.id == run_id)
                .values(finished_at=self.now(), **values)
            )

    def _work(self) -> dict[str, Any]:
        assert self.db_path is not None and self.data_dir is not None  # `claim` checked
        s = self.settings
        try:
            # Created before the copy, so the id is inside the backup too.
            instance = instance_id(self.engine)
            snap = make_snapshot(
                self.db_path,
                self.data_dir,
                include_cache=s.backup_include_cache,
                passphrase=s.backup_passphrase_value,
                app_version=self._app_version,
                now=self.now(),
                instance_id=instance,
            )
        except (SnapshotError, BackupCryptoError, OSError, sqlite3.Error) as exc:
            raise SnapshotError(f"snapshot failed: {self.sanitize(exc)}") from None
        try:
            metadata = json.dumps(snap.metadata(), sort_keys=True).encode()
            results: list[dict[str, Any]] = []
            for target in self.targets():
                result: dict[str, Any] = {"target": target.kind, "ok": False, "error": None}
                try:
                    target.put(snap.name, snap.path, snap.size, snap.sha256, metadata)
                    result["ok"] = True
                except Exception as exc:
                    result["error"] = self.sanitize(exc)
                    log.error("backup to the %s target failed: %s", target.kind, result["error"])
                else:
                    self._retain(target, snap.name, instance, result)
                results.append(result)
        finally:
            snap.path.unlink(missing_ok=True)
        oks = [r["ok"] for r in results]
        status = "ok" if all(oks) else "partial" if any(oks) else "failed"
        errors = [f"{r['target']}: {r['error']}" for r in results if r["error"]]
        return {
            "status": status,
            "file_name": snap.name,
            "size": snap.size,
            "results": results,
            "error": "; ".join(errors)[:ERROR_MAX] or None,
        }

    def _retain(self, target: Target, keep: str, instance: str, result: dict[str, Any]) -> None:
        try:
            result["deleted"] = len(
                apply_retention(target, self.policy(), instance, protect=[keep])
            )
        except Exception as exc:
            result["deleted"] = 0
            result["retentionError"] = self.sanitize(exc)

    # -- reading ------------------------------------------------------------

    def run_json(self, row: BackupRun) -> dict[str, Any]:
        return {
            "id": row.id,
            "startedAt": _utc(row.started_at).isoformat(),
            "finishedAt": _utc(row.finished_at).isoformat() if row.finished_at else None,
            "trigger": row.trigger,
            "status": row.status,
            "fileName": row.file_name,
            "size": row.size,
            "results": row.results or [],
            "error": row.error,
        }

    def get_run(self, run_id: int) -> dict[str, Any] | None:
        with Session(self.engine) as session:
            row = session.get(BackupRun, run_id)
            return self.run_json(row) if row else None

    def recent_runs(self, limit: int = 10) -> list[dict[str, Any]]:
        with Session(self.engine) as session:
            rows = session.scalars(select(BackupRun).order_by(BackupRun.id.desc()).limit(limit))
            return [self.run_json(r) for r in rows]

    def last_ok_at(self) -> datetime | None:
        """When the last successful (`ok` or `partial`) run finished."""
        with Session(self.engine) as session:
            value = session.scalar(
                select(BackupRun.finished_at)
                .where(BackupRun.status.in_(("ok", "partial")))
                .order_by(BackupRun.id.desc())
                .limit(1)
            )
        return _utc(value) if value else None

    def stale_after(self) -> timedelta:
        return timedelta(hours=26)

    def list_files(self) -> tuple[list[BackupFile], list[dict[str, str]]]:
        """Backups on every target (newest first) and the targets that could not be read."""
        files: list[BackupFile] = []
        errors: list[dict[str, str]] = []
        for target in self.targets():
            try:
                files.extend(target.list_files())
            except Exception as exc:
                errors.append({"target": target.kind, "error": self.sanitize(exc)})
        files.sort(key=lambda f: (f.created_at, f.name), reverse=True)
        return files, errors
