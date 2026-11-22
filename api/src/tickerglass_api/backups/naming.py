"""Backup file names: `tickerglass-<UTC yyyymmddTHHMMSSZ>.db.gz[.enc]` with a `.json` next to it.

Everything that touches a target (listing, download, restore, retention) goes through
`parse_name`: a name that does not match is never read, written or deleted, which is also what
keeps a request-supplied `name` from escaping the backup folder or prefix."""

import re
from dataclasses import dataclass
from datetime import UTC, datetime

_NAME = re.compile(r"tickerglass-(\d{8}T\d{6}Z)\.db\.gz(\.enc)?")
_STAMP = "%Y%m%dT%H%M%SZ"


@dataclass(frozen=True)
class BackupName:
    name: str
    created_at: datetime
    encrypted: bool


def make_name(created_at: datetime, *, encrypted: bool) -> str:
    stamp = created_at.astimezone(UTC).strftime(_STAMP)
    return f"tickerglass-{stamp}.db.gz" + (".enc" if encrypted else "")


def parse_name(name: str) -> BackupName | None:
    """The parts of a backup data file name; None for anything else (including `.json`)."""
    match = _NAME.fullmatch(name)
    if match is None:
        return None
    try:
        created = datetime.strptime(match.group(1), _STAMP).replace(tzinfo=UTC)
    except ValueError:
        return None
    return BackupName(name, created, match.group(2) is not None)


def meta_name(name: str) -> str:
    """The metadata file of data file `name` (which must be a valid backup name)."""
    parsed = parse_name(name)
    if parsed is None:
        raise ValueError(f"not a backup file name: {name!r}")
    return name.removesuffix(".enc").removesuffix(".db.gz") + ".json"
