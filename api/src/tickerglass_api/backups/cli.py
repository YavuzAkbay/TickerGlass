"""`tickerglass-api backup ...`: run, list, restore and decrypt backups without the web UI.

    tickerglass-api backup run
    tickerglass-api backup list
    tickerglass-api backup restore <file | s3://tickerglass-<ts>.db.gz[.enc]> [--apply-now]
    tickerglass-api backup decrypt <in> <out>

Settings come from the environment (`.env`), like the server's. `restore` stages the backup
(validated like the UI does); it is applied at the next server start, or at once with
`--apply-now` when no server is running (proved by taking the server's data-folder lock; where
that cannot be proved the command refuses). `decrypt` needs only the passphrase: it turns a
`.enc` file back into the `.db.gz`, no server involved."""

import argparse
import getpass
import os
import sys
from collections.abc import Sequence
from pathlib import Path

from sqlalchemy.exc import SQLAlchemyError

from ..db import make_engine, sqlite_path
from ..settings import Settings, get_settings
from . import restore
from .crypto import BackupCryptoError, decrypt_stream, is_encrypted
from .naming import parse_name
from .runner import BackupService, NoTargets, NotSupported, RunInProgress
from .targets import NotFound, TargetError

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_USAGE = 2


def _err(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return EXIT_FAILED


def _passphrase(settings: Settings, *, confirm_prompt: str = "Backup passphrase: ") -> str | None:
    if settings.backup_passphrase_value:
        return settings.backup_passphrase_value
    if sys.stdin.isatty():
        return getpass.getpass(confirm_prompt) or None
    return None


def _service(settings: Settings) -> BackupService:
    return BackupService(make_engine(settings.database_url), settings)


def cmd_run(settings: Settings, _: argparse.Namespace) -> int:
    service = _service(settings)
    try:
        run_id = service.run("manual")
    except (NotSupported, NoTargets, RunInProgress) as exc:
        return _err(str(exc))
    except SQLAlchemyError:
        return _err("the database has no backup_runs table: start the server once to migrate it")
    run = service.get_run(run_id) or {}
    print(f"{run.get('status')}: {run.get('fileName')} ({run.get('size')} bytes)")
    for result in run.get("results", []):
        detail = "ok" if result["ok"] else f"FAILED ({result['error']})"
        print(f"  {result['target']}: {detail}")
    return EXIT_OK if run.get("status") == "ok" else EXIT_FAILED


def cmd_list(settings: Settings, _: argparse.Namespace) -> int:
    service = _service(settings)
    files, errors = service.list_files()
    for f in files:
        enc = " encrypted" if f.encrypted else ""
        print(f"{f.target:5} {f.created_at:%Y-%m-%d %H:%M:%S}Z {f.size:>12} {f.name}{enc}")
    for error in errors:
        print(f"warning: {error['target']}: {error['error']}", file=sys.stderr)
    if not files and not errors:
        print("no backups found" if service.targets() else "no backup target is configured")
    return EXIT_OK if not errors else EXIT_FAILED


def cmd_restore(settings: Settings, args: argparse.Namespace) -> int:
    db_file = sqlite_path(settings.database_url)
    if db_file is None:
        return _err("restore is available for SQLite; for Postgres use pg_restore")
    data_dir = db_file.resolve().parent
    source: str = args.source
    passphrase = settings.backup_passphrase_value
    try:
        if source.startswith("s3://"):
            name = source.removeprefix("s3://").rsplit("/", 1)[-1]
            if parse_name(name) is None:
                return _err("not a backup file name: expected tickerglass-<timestamp>.db.gz[.enc]")
            service = _service(settings)
            target = next((t for t in service.targets() if t.kind == "s3"), None)
            if target is None:
                return _err("the S3 backup target is not configured")
            if passphrase is None and name.endswith(".enc"):
                passphrase = _passphrase(settings)
            info = restore.stage_from_target(
                target,
                name,
                data_dir,
                passphrase=passphrase,
                restore_max_mb=settings.backup_restore_max_mb,
            )
        else:
            path = Path(source)
            if not path.is_file():
                return _err(f"no such file: {source}")
            with path.open("rb") as fh:
                encrypted = is_encrypted(fh.read(16))
            if encrypted and passphrase is None:
                passphrase = _passphrase(settings)
            info = restore.stage_file(
                path,
                data_dir,
                passphrase=passphrase,
                source=f"file:{path.name}",
                restore_max_mb=settings.backup_restore_max_mb,
            )
    except (restore.RestoreError, NotFound, TargetError) as exc:
        return _err(str(exc))
    except OSError as exc:
        return _err(exc.strerror or str(exc))
    print(f"staged (schema {info['revision']}) from {info['source']}")
    if not args.apply_now:
        print("restart the server to finish the restore")
        return EXIT_OK
    lock = restore.ServerLock(data_dir)
    if not lock.acquire():
        print(
            "not applied: the server appears to be running (or this platform cannot prove it is "
            "not); restart the server to finish the restore",
            file=sys.stderr,
        )
        return EXIT_FAILED
    try:
        result = restore.apply_pending(db_file)
    finally:
        lock.release()
    if result is None or result.status != "applied":
        return _err(result.error or "nothing to apply" if result else "nothing to apply")
    print(f"restore applied; the previous database is kept as {result.pre_restore}")
    print("start the server: the migrations bring an older backup up to date")
    return EXIT_OK


def cmd_decrypt(settings: Settings, args: argparse.Namespace) -> int:
    src, dst = Path(args.input), Path(args.output)
    if not src.is_file():
        return _err(f"no such file: {src}")
    if dst.exists() and not args.force:
        return _err(f"{dst} exists (use --force to overwrite)")
    with src.open("rb") as fh:
        if not is_encrypted(fh.read(16)):
            return _err("not an encrypted TickerGlass backup")
    passphrase = _passphrase(settings)
    if not passphrase:
        return _err("set BACKUP_PASSPHRASE, or run this in a terminal to be asked for it")
    part = dst.with_name(dst.name + ".part")
    try:
        try:
            with src.open("rb") as fin, part.open("wb") as fout:
                os.chmod(part, 0o600)
                decrypt_stream(fin, fout, passphrase)
            os.replace(part, dst)
        finally:
            part.unlink(missing_ok=True)  # never leave a partial plaintext behind
    except BackupCryptoError as exc:
        return _err(str(exc))
    except OSError as exc:
        return _err(exc.strerror or str(exc))
    print(f"decrypted to {dst} (gunzip it to get the SQLite database)")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tickerglass-api backup", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="make a backup now (all configured targets)")
    sub.add_parser("list", help="list the backups on the configured targets")
    rest = sub.add_parser("restore", help="stage a backup; applied at the next server start")
    rest.add_argument("source", help="a backup file, or s3://<backup file name>")
    rest.add_argument(
        "--apply-now",
        action="store_true",
        help="swap the database in now (only when the server is not running)",
    )
    dec = sub.add_parser("decrypt", help="decrypt a .enc backup without the server")
    dec.add_argument("input")
    dec.add_argument("output")
    dec.add_argument("--force", action="store_true", help="overwrite the output file")
    return parser


def main(argv: Sequence[str]) -> int:
    args = build_parser().parse_args(list(argv))
    settings = get_settings()
    handlers = {"run": cmd_run, "list": cmd_list, "restore": cmd_restore, "decrypt": cmd_decrypt}
    return handlers[args.command](settings, args)
