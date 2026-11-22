"""The server's backup identity: a random id kept in `app_meta['instance_id']`.

Every backup's `.json` carries it, and retention only deletes backups whose `.json` has this
id, so a prefix/folder shared with other servers (or other files) is never pruned by us. The id
travels with the database: a restored server keeps the id of the backup's lineage, which is what
we want (it goes on managing the same series of backups). Use one prefix/folder per server."""

import json
import secrets
from datetime import UTC, datetime

from sqlalchemy import Engine
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from ..models import AppMeta

META_KEY = "instance_id"


def instance_id(engine: Engine) -> str:
    """The id, created on first use (safe against two processes doing that at once)."""
    with Session(engine) as session:
        row = session.get(AppMeta, META_KEY)
        if row is not None and isinstance(row.value, str) and row.value:
            return row.value
    candidate = secrets.token_hex(16)
    with Session(engine) as session, session.begin():
        if engine.dialect.name == "sqlite":
            session.execute(
                sqlite_insert(AppMeta)
                .values(key=META_KEY, value=candidate, updated_at=datetime.now(UTC))
                .on_conflict_do_nothing(index_elements=["key"])
            )
        elif session.get(AppMeta, META_KEY) is None:
            session.add(AppMeta(key=META_KEY, value=candidate, updated_at=datetime.now(UTC)))
    with Session(engine) as session:
        row = session.get(AppMeta, META_KEY)
        if row is None or not isinstance(row.value, str) or not row.value:
            raise RuntimeError("could not store the backup instance id")
        return row.value


def meta_instance_id(raw: bytes) -> str | None:
    """The `instanceId` of a backup's `.json` content; None when absent or unreadable."""
    try:
        value = json.loads(raw).get("instanceId")
    except (ValueError, AttributeError):
        return None
    return value if isinstance(value, str) and value else None
