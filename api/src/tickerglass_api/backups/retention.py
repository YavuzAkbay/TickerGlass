"""Grandfather-father-son retention over *our* backup files only.

Keep the latest backup of each of the newest `daily` days, `weekly` ISO weeks and `monthly`
months (UTC; counted over the days/weeks/months that have a backup, so a quiet period never
empties the folder), plus the newest backup overall and whatever the caller protects (the one
just made). Everything else that parses as a backup name *and whose `.json` carries this
server's instance id* (`backups/instance.py`) is deleted with its `.json`; files with other
names, without a `.json`, or from another server are never touched."""

import logging
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass

from .instance import meta_instance_id
from .targets import BackupFile, Target, TargetError

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Policy:
    daily: int
    weekly: int
    monthly: int


def _newest_per_bucket(
    files: list[BackupFile], key: Callable[[BackupFile], Hashable], limit: int
) -> set[str]:
    """Names of the latest file in each of the `limit` newest buckets (`files` newest first)."""
    seen: list[Hashable] = []
    keep: set[str] = set()
    for file in files:
        bucket = key(file)
        if bucket in seen:
            continue
        if len(seen) >= limit:
            break
        seen.append(bucket)
        keep.add(file.name)
    return keep


def select_deletions(
    files: Iterable[BackupFile], policy: Policy, protect: Iterable[str] = ()
) -> list[str]:
    """Names to delete, oldest first."""
    ordered = sorted(files, key=lambda f: (f.created_at, f.name), reverse=True)
    if not ordered:
        return []
    keep = {ordered[0].name, *protect}
    keep |= _newest_per_bucket(ordered, lambda f: f.created_at.date(), policy.daily)
    keep |= _newest_per_bucket(ordered, lambda f: f.created_at.isocalendar()[:2], policy.weekly)
    keep |= _newest_per_bucket(
        ordered, lambda f: (f.created_at.year, f.created_at.month), policy.monthly
    )
    return [f.name for f in reversed(ordered) if f.name not in keep]


def own_files(target: Target, instance_id: str) -> list[BackupFile]:
    """The files on `target` whose `.json` carries `instance_id`. A file without a `.json`, with
    an unreadable one, or with another server's id is not ours: never counted, never deleted."""
    mine: list[BackupFile] = []
    for file in target.list_files():
        try:
            raw = target.read_meta(file.name)
        except TargetError:
            log.warning("backup retention: cannot read the .json of %s; leaving it", file.name)
            continue
        if raw is not None and meta_instance_id(raw) == instance_id:
            mine.append(file)
    return mine


def apply_retention(
    target: Target, policy: Policy, instance_id: str, protect: Iterable[str] = ()
) -> list[str]:
    """Delete what the policy drops from the files of this server (`instance_id`) on `target`;
    returns the deleted names. Stops at the first failure (the next run retries) with the error
    raised."""
    deleted: list[str] = []
    for name in select_deletions(own_files(target, instance_id), policy, protect):
        try:
            target.delete(name)
        except TargetError:
            log.warning(
                "backup retention: could not delete %s from the %s target", name, target.kind
            )
            raise
        deleted.append(name)
    if deleted:
        log.info(
            "backup retention: deleted %d old backup(s) from the %s target",
            len(deleted),
            target.kind,
        )
    return deleted
