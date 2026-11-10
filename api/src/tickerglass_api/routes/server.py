"""Server maintenance for self-hosters (docs/self-hosting.md): what the instance
runs and holds, a one-click SQLite backup, and clearing the market-data cache.
Not user data — no revisions, no offline queue; guarded by password auth when
`AUTH_PASSWORD` is set."""

import logging
import os
import sqlite3
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import Engine, delete, func, select, text
from sqlalchemy.orm import Session
from starlette.background import BackgroundTask

from .. import __version__
from .. import models as m
from ..deps import SettingsDep
from ..providers.registry import is_configured
from ..services.cache_source import CACHE_SOURCE_KEY, LEGACY_SOURCE
from ..userdata.alerts import ServiceHeartbeat

log = logging.getLogger(__name__)

router = APIRouter(prefix="/server", tags=["server"])

ONLINE_WITHIN = timedelta(seconds=90)  # same rule as GET /alerts/service


def _alerts_service(request: Request) -> dict[str, Any]:
    """The evaluation service's heartbeat, in the `GET /alerts/service` shape."""
    state = request.app.state.alerts_service
    heartbeat: ServiceHeartbeat | None = state.heartbeat
    last_at: datetime | None = state.last_at
    if heartbeat is None or last_at is None:
        return {"online": False}
    when = last_at if last_at.tzinfo else last_at.replace(tzinfo=UTC)
    return {
        "online": datetime.now(UTC) - when < ONLINE_WITHIN,
        "version": heartbeat.version,
        "startedAt": heartbeat.started_at.isoformat(),
        "series": heartbeat.series,
        "liveSymbols": heartbeat.live_symbols,
        "polledSeries": heartbeat.polled_series,
        "lastError": heartbeat.last_error,
    }


def _database(request: Request) -> dict[str, Any]:
    engine: Engine = request.app.state.engine
    kind = engine.dialect.name
    size: int | None = None
    db_file = engine.url.database if kind == "sqlite" else None
    if db_file and db_file != ":memory:":
        size = os.path.getsize(db_file)
    elif kind != "sqlite":
        with Session(engine) as session:
            size = int(session.scalar(text("SELECT pg_database_size(current_database())")) or 0)
    return {"kind": kind, "sizeBytes": size}


def _counts(session: Any) -> dict[str, int]:
    out = {}
    for name, table in (
        ("watchlists", m.Watchlist),
        ("layouts", m.Layout),
        ("drawings", m.DrawingRow),
        ("notes", m.Note),
        ("userScripts", m.UserScript),
        ("alerts", m.Alert),
        ("screens", m.Screen),
        ("series", m.SeriesMeta),
        ("bars", m.Bar),
    ):
        out[name] = session.scalar(select(func.count()).select_from(table)) or 0
    return out


@router.get("/status")
def status(request: Request, settings: SettingsDep) -> dict[str, Any]:
    spec = getattr(request.app.state, "provider_spec", None)
    session_maker = request.app.state.sessionmaker
    with session_maker() as session:
        counts = _counts(session)
        cache_source = session.get(m.AppMeta, CACHE_SOURCE_KEY)
    return {
        "version": __version__,
        "uptimeSeconds": int(time.time() - request.app.state.started_at)
        if hasattr(request.app.state, "started_at")
        else None,
        "provider": {
            "id": spec.id if spec else None,
            "name": spec.name if spec else None,
            "configured": bool(spec and is_configured(spec)),
            "cacheSource": cache_source.value if cache_source else LEGACY_SOURCE,
        },
        "alertsService": _alerts_service(request),
        "database": _database(request),
        "counts": counts,
        "auth": {"enabled": bool(settings.auth_password)},
    }


@router.post("/cache/clear")
def cache_clear(request: Request) -> dict[str, Any]:
    """Wipe cached market data: the bars DB (bars, series bookkeeping, symbol
    metadata) and the in-memory caches of the installed stack. Everything is
    refetched from the provider on demand. User data is never touched."""
    gate = request.app.state.cache_gate
    stack = request.app.state.market_stack
    engine: Engine = request.app.state.engine
    # Retire the current generation first: writes of requests in flight are
    # refused, so none can land after the wipe (same order as a provider switch).
    generation = gate.advance()
    with Session(engine) as session, session.begin():
        deleted = {}
        for table in (m.Bar, m.SeriesMeta, m.SymbolMeta):
            result = session.execute(delete(table))
            deleted[table.__tablename__] = int(getattr(result, "rowcount", 0) or 0)
    cleared = stack.market_service.clear_caches() + stack.symbol_service.clear_caches()
    log.warning(
        "market data cache cleared (generation %s): %s, %s in-memory entries",
        generation,
        deleted,
        cleared,
    )
    return {
        "cleared": True,
        "generation": generation,
        "deletedRows": deleted,
        "memoryEntries": cleared,
    }


@router.get("/backup")
def backup(request: Request) -> Response:
    """Download a consistent snapshot of a SQLite database. Postgres backups are
    out of scope on purpose: `pg_dump` is the right tool there."""
    engine: Engine = request.app.state.engine
    if engine.dialect.name != "sqlite":
        raise HTTPException(
            501,
            "backup is available for SQLite; for Postgres use pg_dump "
            "(e.g. `docker compose exec postgres pg_dump ...`)",
        )
    db_file = engine.url.database
    if not db_file or db_file == ":memory:":
        raise HTTPException(503, "no SQLite database file found")
    path = Path(db_file)
    if not path.exists():
        raise HTTPException(503, "no SQLite database file found")
    fd, tmp = tempfile.mkstemp(suffix=".db", prefix="tickerglass-backup-")
    os.close(fd)
    try:
        src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            dest = sqlite3.connect(tmp)
            try:
                src.backup(dest)  # consistent snapshot, including the WAL
            finally:
                dest.close()
        finally:
            src.close()
    except Exception:
        os.unlink(tmp)
        raise
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return FileResponse(
        tmp,
        filename=f"tickerglass-backup-{stamp}.db",
        media_type="application/x-sqlite3",
        background=BackgroundTask(os.unlink, tmp),
    )
