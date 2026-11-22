"""Where backups are written: a local folder and/or an S3-compatible bucket.

Both targets deal in backup *names* (`naming.parse_name`) only; a name that does not parse is
refused before any path or key is built. `TargetError` messages are safe to show and store (S3
failures carry the S3 error code, never a URL, signature or key)."""

import hashlib
import io
import logging
import os
import shutil
import stat
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, BinaryIO, Protocol, cast
from urllib.parse import urlsplit

from ..settings import Settings
from .naming import meta_name, parse_name
from .s3 import S3Client, S3Config, S3Error

log = logging.getLogger(__name__)

COPY_CHUNK = 1 << 20
#: Timeout of interactive requests (listing, test); uploads and downloads use the client's 60 s.
QUICK_TIMEOUT_S = 20.0
#: Largest `.json` read back (ours are < 1 KB); anything bigger is not ours.
META_MAX = 64 * 1024


class TargetError(Exception):
    """A target operation failed; `str(exc)` is safe to store and show."""


class NotFound(TargetError):
    """The named backup is not on the target."""


@dataclass(frozen=True)
class BackupFile:
    target: str
    name: str
    size: int
    created_at: datetime
    encrypted: bool


class Target(Protocol):
    kind: str

    @property
    def label(self) -> str: ...

    def warning(self, data_dir: Path) -> str | None: ...

    def put(self, name: str, path: Path, size: int, sha256: str, metadata: bytes) -> None: ...

    def list_files(self) -> list[BackupFile]: ...

    def fetch(self, name: str, dst: BinaryIO) -> None: ...

    def read_meta(self, name: str) -> bytes | None:
        """Content of the backup's `.json` (at most `META_MAX` bytes); None when it has none.
        Raises `TargetError` when it cannot be read."""
        ...

    def delete(self, name: str) -> None: ...

    def test(self) -> None: ...


def _checked(name: str) -> None:
    if parse_name(name) is None:
        raise TargetError("not a backup file name")


class LocalTarget:
    kind = "local"

    def __init__(self, directory: str) -> None:
        self.directory = Path(directory)

    @property
    def label(self) -> str:
        return str(self.directory)

    def _ensure(self) -> None:
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError as exc:
            raise TargetError(f"cannot create the backup folder: {exc.strerror or exc}") from exc

    def warning(self, data_dir: Path) -> str | None:
        """Same filesystem as the database: no protection against losing that disk."""
        probe = self.directory
        while not probe.exists() and probe != probe.parent:
            probe = probe.parent
        try:
            same = os.stat(probe).st_dev == os.stat(data_dir).st_dev
        except OSError:
            return None
        return (
            "on the same disk as the database: this does not protect against losing the disk"
            if same
            else None
        )

    def put(self, name: str, path: Path, size: int, sha256: str, metadata: bytes) -> None:
        _checked(name)
        self._ensure()
        try:
            self._write(self.directory / name, lambda fh: _copy_file(path, fh), size)
            self._write(self.directory / meta_name(name), lambda fh: fh.write(metadata), None)
        except OSError as exc:
            raise TargetError(f"cannot write to the backup folder: {exc.strerror or exc}") from exc

    def _write(self, dest: Path, fill: Callable[[BinaryIO], object], size: int | None) -> None:
        part = dest.with_name(dest.name + ".part")
        try:
            with part.open("wb") as fh:
                fill(fh)
                fh.flush()
                os.fsync(fh.fileno())
            if size is not None and part.stat().st_size != size:
                raise TargetError("the written file has the wrong size")
            os.chmod(part, 0o600)
            os.replace(part, dest)
        except BaseException:
            part.unlink(missing_ok=True)
            raise

    def list_files(self) -> list[BackupFile]:
        try:
            entries = list(self.directory.iterdir())
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise TargetError(f"cannot read the backup folder: {exc.strerror or exc}") from exc
        out: list[BackupFile] = []
        for entry in entries:
            parsed = parse_name(entry.name)
            if parsed is None:
                continue
            try:
                info = entry.lstat()
            except OSError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            out.append(
                BackupFile("local", entry.name, info.st_size, parsed.created_at, parsed.encrypted)
            )
        return out

    def fetch(self, name: str, dst: BinaryIO) -> None:
        _checked(name)
        path = self.directory / name
        try:
            if not stat.S_ISREG(path.lstat().st_mode):
                raise NotFound("backup not found")
            with path.open("rb") as fh:
                shutil.copyfileobj(fh, dst, COPY_CHUNK)
        except FileNotFoundError:
            raise NotFound("backup not found") from None
        except OSError as exc:
            raise TargetError(f"cannot read the backup: {exc.strerror or exc}") from exc

    def read_meta(self, name: str) -> bytes | None:
        _checked(name)
        path = self.directory / meta_name(name)
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                return None
            if info.st_size > META_MAX:
                raise TargetError("the backup's .json is too large")
            return path.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise TargetError(f"cannot read the backup folder: {exc.strerror or exc}") from exc

    def delete(self, name: str) -> None:
        _checked(name)
        try:
            (self.directory / name).unlink(missing_ok=True)
            (self.directory / meta_name(name)).unlink(missing_ok=True)
        except OSError as exc:
            raise TargetError(
                f"cannot delete from the backup folder: {exc.strerror or exc}"
            ) from exc

    def test(self) -> None:
        self._ensure()
        probe = self.directory / f".tickerglass-write-test-{uuid.uuid4().hex[:8]}"
        try:
            probe.write_bytes(b"ok")
        except OSError as exc:
            raise TargetError(f"the backup folder is not writable: {exc.strerror or exc}") from exc
        finally:
            probe.unlink(missing_ok=True)


def _copy_file(src: Path, dst: BinaryIO) -> None:
    with src.open("rb") as fh:
        shutil.copyfileobj(fh, dst, COPY_CHUNK)


class _LimitedBuffer(io.BytesIO):
    """In-memory sink that refuses more than `limit` bytes."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self._limit = limit

    def write(self, data: Any, /) -> int:
        if self.tell() + len(data) > self._limit:
            raise TargetError("the backup's .json is too large")
        return super().write(data)


class S3Target:
    kind = "s3"

    def __init__(self, config: S3Config) -> None:
        self._config = config

    @property
    def label(self) -> str:
        host = urlsplit(self._config.endpoint).netloc
        return f"{self._config.bucket} @ {host}/{self._config.prefix}"

    def warning(self, data_dir: Path) -> str | None:
        return None

    def _client(self, *, quick: bool = False) -> S3Client:
        try:
            if quick:
                return S3Client(self._config, timeout=QUICK_TIMEOUT_S)
            return S3Client(self._config)
        except S3Error as exc:
            raise TargetError(f"S3 {exc.code}") from None

    def put(self, name: str, path: Path, size: int, sha256: str, metadata: bytes) -> None:
        _checked(name)
        client = self._client()
        try:
            with path.open("rb") as fh:
                client.put_object(client.full_key(name), fh, size, sha256)
            client.put_object(
                client.full_key(meta_name(name)),
                io.BytesIO(metadata),
                len(metadata),
                hashlib.sha256(metadata).hexdigest(),
            )
        except S3Error as exc:
            raise TargetError(f"S3 {exc.code}") from None
        except OSError as exc:
            raise TargetError(f"cannot read the backup file: {exc.strerror or exc}") from exc

    def list_files(self) -> list[BackupFile]:
        client = self._client(quick=True)
        prefix = client.full_key("")
        try:
            objects = client.list_objects(prefix)
        except S3Error as exc:
            raise TargetError(f"S3 {exc.code}") from None
        out: list[BackupFile] = []
        for obj in objects:
            if not obj.key.startswith(prefix):
                continue
            parsed = parse_name(obj.key[len(prefix) :])
            if parsed is None:
                continue
            out.append(BackupFile("s3", parsed.name, obj.size, parsed.created_at, parsed.encrypted))
        return out

    def fetch(self, name: str, dst: BinaryIO) -> None:
        _checked(name)
        client = self._client()
        try:
            client.get_object(client.full_key(name), dst)
        except S3Error as exc:
            if exc.code in ("NoSuchKey", "http_404"):
                raise NotFound("backup not found") from None
            raise TargetError(f"S3 {exc.code}") from None

    def read_meta(self, name: str) -> bytes | None:
        _checked(name)
        client = self._client(quick=True)
        buffer = _LimitedBuffer(META_MAX)
        try:
            client.get_object(client.full_key(meta_name(name)), cast(BinaryIO, buffer))
        except S3Error as exc:
            if exc.code in ("NoSuchKey", "http_404"):
                return None
            raise TargetError(f"S3 {exc.code}") from None
        return buffer.getvalue()

    def delete(self, name: str) -> None:
        _checked(name)
        client = self._client(quick=True)
        try:
            client.delete_object(client.full_key(name))
            client.delete_object(client.full_key(meta_name(name)))
        except S3Error as exc:
            raise TargetError(f"S3 {exc.code}") from None

    def test(self) -> None:
        client = self._client(quick=True)
        try:
            client.head_bucket()
        except S3Error as exc:
            raise TargetError(f"S3 {exc.code}") from None


def configured_targets(settings: Settings) -> list[Target]:
    """The targets the settings configure: local first, then S3."""
    targets: list[Target] = []
    if settings.backup_dir:
        targets.append(LocalTarget(settings.backup_dir))
    if settings.backup_s3_configured:
        targets.append(
            S3Target(
                S3Config(
                    endpoint=settings.backup_s3_endpoint or "",
                    bucket=settings.backup_s3_bucket or "",
                    prefix=settings.backup_s3_prefix,
                    region=settings.backup_s3_region,
                    access_key_id=settings.backup_s3_access_key_id or "",
                    secret_access_key=settings.backup_s3_secret_value or "",
                    path_style=settings.backup_s3_path_style,
                )
            )
        )
    return targets
