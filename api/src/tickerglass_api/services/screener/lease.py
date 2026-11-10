"""Cross-process lease of a background job in `job_leases` (docs/design/server-screener.md §5).

One row per job name. `acquire` takes the lease when it is free, expired or already ours
(`UPDATE ... WHERE name = :name AND (owner = :me OR expires_at < :now)`), inserting the row on
first use; renewing is acquiring again. Every call is its own short transaction (SQLAlchemy
Core, SQLite and Postgres alike); times are UTC.
"""

import os
import socket
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine, delete, insert, or_, select, update
from sqlalchemy.exc import IntegrityError

from ...models import JobLease

#: How long an acquired or renewed lease lasts.
LEASE_TTL = timedelta(seconds=120)
#: How often the holder renews it.
RENEW_EVERY = timedelta(seconds=60)
_OWNER_MAX = 64


def make_owner() -> str:
    """`hostname:pid:uuid` (the hostname shortened so the whole fits `job_leases.owner`)."""
    tail = f":{os.getpid()}:{uuid.uuid4().hex[:12]}"
    return socket.gethostname()[: _OWNER_MAX - len(tail)] + tail


def _utc(now: datetime | None) -> datetime:
    return (now or datetime.now(UTC)).astimezone(UTC)


class Lease:
    """The lease `name` as held (or wanted) by `owner`."""

    def __init__(
        self, engine: Engine, name: str, owner: str | None = None, ttl: timedelta = LEASE_TTL
    ) -> None:
        self._engine = engine
        self.name = name
        self.owner = owner or make_owner()
        self._ttl = ttl

    def acquire(self, now: datetime | None = None) -> bool:
        """Take or renew the lease; False while another owner holds an unexpired one."""
        now = _utc(now)
        with self._engine.begin() as conn:
            result = conn.execute(
                update(JobLease)
                .where(
                    JobLease.name == self.name,
                    or_(JobLease.owner == self.owner, JobLease.expires_at < now),
                )
                .values(owner=self.owner, expires_at=now + self._ttl)
            )
            if result.rowcount == 1:
                return True
            if conn.execute(select(JobLease.name).where(JobLease.name == self.name)).first():
                return False
        try:
            with self._engine.begin() as conn:
                conn.execute(
                    insert(JobLease).values(
                        name=self.name, owner=self.owner, expires_at=now + self._ttl
                    )
                )
        except IntegrityError:
            return False  # another process inserted it first
        return True

    renew = acquire

    def release(self) -> None:
        """Give the lease up (a no-op when another owner holds it)."""
        with self._engine.begin() as conn:
            conn.execute(
                delete(JobLease).where(JobLease.name == self.name, JobLease.owner == self.owner)
            )

    def holder(self, now: datetime | None = None) -> str | None:
        """Owner of the unexpired lease, None when free."""
        now = _utc(now)
        with self._engine.connect() as conn:
            row = conn.execute(
                select(JobLease.owner, JobLease.expires_at).where(JobLease.name == self.name)
            ).first()
        if row is None:
            return None
        expires = row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=UTC)
        return str(row.owner) if expires >= now else None
