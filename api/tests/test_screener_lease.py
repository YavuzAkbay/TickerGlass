"""Job lease in `job_leases` (services/screener/lease.py)."""

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import Engine

from tickerglass_api.db import Base, make_engine
from tickerglass_api.services.screener.lease import LEASE_TTL, Lease, make_owner

NOW = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)


@pytest.fixture
def engine(tmp_path: Path) -> Engine:
    engine = make_engine(f"sqlite:///{tmp_path}/lease.db")
    Base.metadata.create_all(engine)
    return engine


def test_owner_format() -> None:
    owner = make_owner()
    host, pid, tag = owner.rsplit(":", 2)
    assert host and pid.isdigit() and len(tag) == 12
    assert len(owner) <= 64
    assert make_owner() != owner


def test_first_holder_wins_until_expiry(engine: Engine) -> None:
    a = Lease(engine, "screener", owner="a")
    b = Lease(engine, "screener", owner="b")
    assert a.acquire(NOW)
    assert not b.acquire(NOW)
    assert a.holder(NOW) == "a"
    # Renewing keeps it ours; it moves the expiry on.
    assert a.renew(NOW + timedelta(seconds=60))
    assert not b.acquire(NOW + LEASE_TTL + timedelta(seconds=30))
    # Expired: the other owner takes it, and the first one has lost it.
    later = NOW + timedelta(seconds=60) + LEASE_TTL + timedelta(seconds=1)
    assert a.holder(later) is None
    assert b.acquire(later)
    assert not a.renew(later)
    assert a.holder(later) == "b"


def test_release_frees_only_own_lease(engine: Engine) -> None:
    a = Lease(engine, "screener", owner="a")
    b = Lease(engine, "screener", owner="b")
    assert a.acquire(NOW)
    b.release()  # not b's: nothing happens
    assert not b.acquire(NOW)
    a.release()
    assert a.holder(NOW) is None
    assert b.acquire(NOW)


def test_leases_are_per_name(engine: Engine) -> None:
    assert Lease(engine, "screener", owner="a").acquire(NOW)
    assert Lease(engine, "other", owner="b").acquire(NOW)
