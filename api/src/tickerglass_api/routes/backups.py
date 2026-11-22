"""Scheduled backups and restore (docs/design/scheduled-backups.md). Admin only, every route:
the backup covers every user's data, and a restore replaces the database.

Restore is two-phase: these routes only *stage* a verified backup (`restore-pending.db`); it is
swapped in at the next server start (`backups/restore.py`). Errors shown to the client never
contain the passphrase or S3 keys (`BackupService.sanitize`)."""

import asyncio
import contextlib
import logging
import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, BinaryIO, Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from ..backups import restore as restore_mod
from ..backups.multipart import MultipartError, MultipartReader, PartInfo, boundary_of
from ..backups.naming import parse_name
from ..backups.runner import BackupService, NoTargets, NotSupported, RunInProgress
from ..backups.scheduler import next_run_at
from ..backups.snapshot import tmp_dir
from ..backups.targets import LocalTarget, NotFound, Target, TargetError
from ..deps import AdminDep

log = logging.getLogger(__name__)

router = APIRouter(prefix="/backups", tags=["backups"])

#: Allowed multipart overhead above the file size limit (boundaries, other fields).
UPLOAD_SLACK = 1 << 20
PASSPHRASE_FIELD_MAX = 1024
#: The multipart upload is a "simple" cross-site request (no CORS preflight), so it must carry
#: this custom header, which a cross-site form or fetch cannot add without a preflight.
UPLOAD_HEADER = "X-TickerGlass-Request"
DOWNLOAD_CHUNK = 1 << 20
POSTGRES_HINT = "backups are available for SQLite; for Postgres use pg_dump"


def service(request: Request) -> BackupService:
    svc: BackupService = request.app.state.backups
    return svc


def supported_service(request: Request) -> BackupService:
    svc = service(request)
    if not svc.supported or svc.data_dir is None:
        raise HTTPException(501, POSTGRES_HINT)
    return svc


def _target(svc: BackupService, kind: str) -> Target:
    for target in svc.targets():
        if target.kind == kind:
            return target
    raise HTTPException(404, f"the {kind} backup target is not configured")


def _valid_name(name: str) -> str:
    if parse_name(name) is None:
        raise HTTPException(400, "invalid backup name")
    return name


def summary(svc: BackupService) -> dict[str, Any]:
    """The `backup` block of `GET /server/status`."""
    runs = svc.recent_runs(1) if svc.supported else []
    last = runs[0] if runs else None
    pending = restore_mod.pending_info(svc.data_dir) if svc.data_dir else None
    return {
        "enabled": svc.enabled,
        "lastStatus": last["status"] if last else None,
        "lastAt": (last["finishedAt"] or last["startedAt"]) if last else None,
        "pending": pending,
    }


# ----------------------------------------------------------------------- status


@router.get("")
def get_backups(_: AdminDep, request: Request) -> dict[str, Any]:
    svc = service(request)
    s = svc.settings
    schedule = {
        "at": s.backup_at,
        "tz": s.backup_zone,
        "next": next_run_at(s, svc.now()).isoformat() if svc.enabled else None,
    }
    base: dict[str, Any] = {
        "enabled": svc.enabled,
        "supported": svc.supported,
        "schedule": schedule,
        "encrypted": svc.encrypted,
        "includeCache": s.backup_include_cache,
        "retention": {
            "daily": s.backup_keep_daily,
            "weekly": s.backup_keep_weekly,
            "monthly": s.backup_keep_monthly,
        },
    }
    if not svc.supported or svc.data_dir is None:
        return {
            **base,
            "targets": [],
            "running": False,
            "last": None,
            "runs": [],
            "files": [],
            "fileErrors": [],
            "pending": None,
            "lastRestore": None,
        }
    configured = {t.kind: t for t in svc.targets()}
    targets: list[dict[str, Any]] = []
    for kind in ("local", "s3"):
        target = configured.get(kind)
        entry: dict[str, Any] = {
            "kind": kind,
            "label": target.label if target else "",
            "configured": target is not None,
        }
        warning = target.warning(svc.data_dir) if target else None
        if warning:
            entry["warning"] = warning
        targets.append(entry)
    files, file_errors = svc.list_files()
    runs = svc.recent_runs(10)
    return {
        **base,
        "targets": targets,
        "running": svc.running,
        "last": runs[0] if runs else None,
        "runs": runs,
        "files": [
            {
                "target": f.target,
                "name": f.name,
                "size": f.size,
                "createdAt": f.created_at.isoformat(),
                "encrypted": f.encrypted,
            }
            for f in files
        ],
        "fileErrors": file_errors,
        "pending": restore_mod.pending_info(svc.data_dir),
        "lastRestore": restore_mod.last_result(svc.data_dir),
    }


# ------------------------------------------------------------------------- runs


@router.post("/run", status_code=202)
def run_now(_: AdminDep, request: Request) -> dict[str, int]:
    svc = service(request)
    try:
        return {"runId": svc.start("manual")}
    except NotSupported:
        raise HTTPException(501, POSTGRES_HINT) from None
    except NoTargets as exc:
        raise HTTPException(409, str(exc)) from None
    except RunInProgress as exc:
        raise HTTPException(409, str(exc)) from None


@router.get("/runs/{run_id}")
def get_run(run_id: int, _: AdminDep, request: Request) -> dict[str, Any]:
    run = service(request).get_run(run_id)
    if run is None:
        raise HTTPException(404, "run not found")
    return run


@router.post("/test")
def test_targets(_: AdminDep, request: Request) -> dict[str, Any]:
    svc = supported_service(request)
    results = []
    for target in svc.targets():
        error: str | None = None
        try:
            target.test()
        except Exception as exc:
            error = svc.sanitize(exc)
        results.append(
            {"kind": target.kind, "label": target.label, "ok": error is None, "error": error}
        )
    return {"targets": results}


# ---------------------------------------------------------------------- restore


class RestoreIn(BaseModel):
    target: Literal["local", "s3"]
    name: str


def _stage_error(exc: Exception, svc: BackupService) -> HTTPException:
    if isinstance(exc, restore_mod.RestoreError):
        return HTTPException(exc.status, svc.redact(str(exc)))
    if isinstance(exc, NotFound):
        return HTTPException(404, "backup not found")
    if isinstance(exc, TargetError):
        return HTTPException(502, svc.redact(str(exc)))
    log.error("restore staging failed: %s", svc.sanitize(exc))
    return HTTPException(500, "could not stage the backup")


@router.post("/restore")
def stage_restore(body: RestoreIn, _: AdminDep, request: Request) -> dict[str, Any]:
    svc = supported_service(request)
    assert svc.data_dir is not None
    name = _valid_name(body.name)
    target = _target(svc, body.target)
    try:
        info = restore_mod.stage_from_target(
            target,
            name,
            svc.data_dir,
            passphrase=svc.settings.backup_passphrase_value,
            restore_max_mb=svc.settings.backup_restore_max_mb,
        )
    except Exception as exc:
        raise _stage_error(exc, svc) from None
    log.warning(
        "restore staged from %s:%s; it is applied at the next server start", body.target, name
    )
    return {"pending": info}


def _new_upload_file(data_dir: Path) -> Path:
    fd, name = tempfile.mkstemp(prefix="upload-", dir=tmp_dir(data_dir))
    os.close(fd)
    return Path(name)


@router.post("/restore/upload")
async def stage_upload(_: AdminDep, request: Request) -> dict[str, Any]:
    svc = supported_service(request)
    assert svc.data_dir is not None
    if request.headers.get(UPLOAD_HEADER) != "1":
        raise HTTPException(403, f"the upload needs the `{UPLOAD_HEADER}: 1` header")
    data_dir = svc.data_dir
    max_bytes = svc.settings.backup_upload_max_mb << 20
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > max_bytes + UPLOAD_SLACK:
        raise HTTPException(413, f"the file is larger than {svc.settings.backup_upload_max_mb} MB")
    try:
        boundary = boundary_of(request.headers.get("content-type"))
    except MultipartError as exc:
        raise HTTPException(400, str(exc)) from None

    upload = await run_in_threadpool(_new_upload_file, data_dir)
    sink: BinaryIO | None = None
    current: PartInfo | None = None
    seen_file = False
    size = 0
    passphrase = bytearray()

    def on_start(part: PartInfo) -> None:
        nonlocal sink, current, seen_file
        current = part
        if part.name == "file":
            if seen_file or part.filename is None:
                raise HTTPException(400, "send exactly one file in the `file` field")
            seen_file = True
            sink = upload.open("wb")

    def on_data(chunk: bytes) -> None:
        nonlocal size
        if current is None:
            return
        if current.name == "file" and sink is not None:
            size += len(chunk)
            if size > max_bytes:
                raise HTTPException(
                    413, f"the file is larger than {svc.settings.backup_upload_max_mb} MB"
                )
            sink.write(chunk)
        elif current.name == "passphrase":
            passphrase.extend(chunk)
            if len(passphrase) > PASSPHRASE_FIELD_MAX:
                raise HTTPException(400, "passphrase too long")

    def on_end() -> None:
        nonlocal sink
        if sink is not None:
            sink.close()
            sink = None

    reader = MultipartReader(boundary, on_start, on_data, on_end)
    try:
        try:
            # The callbacks write to disk: keep them off the event loop.
            async for chunk in request.stream():
                await run_in_threadpool(reader.feed, chunk)
            await run_in_threadpool(reader.close)
        except MultipartError as exc:
            raise HTTPException(400, str(exc)) from None
        if not seen_file:
            raise HTTPException(400, "no file in the upload")
        try:
            given = passphrase.decode("utf-8") or None
        except UnicodeDecodeError:
            raise HTTPException(400, "passphrase is not valid UTF-8") from None
        try:
            info = await asyncio.to_thread(
                restore_mod.stage_file,
                upload,
                data_dir,
                passphrase=given or svc.settings.backup_passphrase_value,
                source="upload",
                restore_max_mb=svc.settings.backup_restore_max_mb,
            )
        except Exception as exc:
            raise _stage_error(exc, svc) from None
    finally:
        if sink is not None:
            sink.close()
        with contextlib.suppress(FileNotFoundError):
            os.unlink(upload)
    log.warning("restore staged from an upload; it is applied at the next server start")
    return {"pending": info}


@router.delete("/restore")
def cancel_restore(_: AdminDep, request: Request) -> dict[str, bool]:
    svc = supported_service(request)
    assert svc.data_dir is not None
    return {"cancelled": restore_mod.cancel_pending(svc.data_dir)}


# --------------------------------------------------------------------- download


@router.get("/files/{target}/{name}")
def download(target: str, name: str, _: AdminDep, request: Request) -> Response:
    svc = supported_service(request)
    assert svc.data_dir is not None
    if target not in ("local", "s3"):
        raise HTTPException(404, "unknown backup target")
    _valid_name(name)
    chosen = _target(svc, target)
    if isinstance(chosen, LocalTarget):
        path = chosen.directory / name
        if not path.is_file() or path.is_symlink():
            raise HTTPException(404, "backup not found")
        return FileResponse(path, filename=name, media_type="application/octet-stream")
    fd, tmp = tempfile.mkstemp(prefix="download-", dir=tmp_dir(svc.data_dir))
    path = Path(tmp)
    try:
        with os.fdopen(fd, "wb") as fh:
            chosen.fetch(name, fh)
        reader = path.open("rb")
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise _stage_error(exc, svc) from None
    # Unlinked right away (the open handle keeps the data): a client that disconnects, or a
    # response that never starts, cannot leave the temp file behind. Where a file cannot be
    # unlinked while open, the generator's `finally` removes it.
    with contextlib.suppress(OSError):
        path.unlink()
    size = os.fstat(reader.fileno()).st_size
    return StreamingResponse(
        _stream_file(reader, path),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(size),
            "Content-Disposition": f'attachment; filename="{name}"',
        },
    )


async def _stream_file(reader: BinaryIO, path: Path) -> AsyncIterator[bytes]:
    try:
        while chunk := await run_in_threadpool(reader.read, DOWNLOAD_CHUNK):
            yield chunk
    finally:
        reader.close()
        with contextlib.suppress(FileNotFoundError):
            os.unlink(path)
