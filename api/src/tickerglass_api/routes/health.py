"""Liveness and readiness probes (docs/design/metrics.md §3). Public, bodies carry check names
and `ok` / `fail` only, never error text. `GET /api/health` (app.py) is unchanged."""

import asyncio
import logging
import threading

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy import Engine, text

log = logging.getLogger(__name__)
router = APIRouter(prefix="/health", tags=["health"])

#: Time the readiness database check may take.
DB_BUDGET_S = 2.0
#: Held by the worker thread while a database check runs. A check that outlives `DB_BUDGET_S`
#: keeps its thread (a thread cannot be cancelled), so while one is in flight the next probe
#: fails at once instead of starting another: a hung database cannot drain the threadpool.
#: The worker takes it (never the request), so it cannot leak if the request is cancelled.
_ping_lock = threading.Lock()


def _ping(engine: Engine) -> None:
    if not _ping_lock.acquire(blocking=False):
        raise TimeoutError("a database check is still running")
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    finally:
        _ping_lock.release()


@router.get("/live")
def live() -> dict[str, str]:
    """The process serves requests. No database access."""
    return {"status": "ok"}


@router.get("/ready")
async def ready(request: Request) -> JSONResponse:
    """Startup finished (lifespan done, staged restore applied) and the database answers.
    The alerts service being offline does not count: the API is still usable."""
    state = request.app.state
    started: bool = getattr(state, "ready", False)
    db_ok = False
    if started:
        try:
            if _ping_lock.locked():  # no new thread while a check hangs
                raise TimeoutError("a database check is still running")
            await asyncio.wait_for(run_in_threadpool(_ping, state.engine), DB_BUDGET_S)
            db_ok = True
        except Exception as exc:  # TimeoutError, OperationalError, ...
            if not getattr(state, "ready_failing", False):  # once per outage
                log.warning("readiness: database check failed (%s)", type(exc).__name__)
        state.ready_failing = not db_ok
    if started and db_ok:
        return JSONResponse({"status": "ok"})
    checks = {"startup": "ok" if started else "fail", "db": "ok" if db_ok else "fail"}
    return JSONResponse({"status": "unavailable", "checks": checks}, status_code=503)
