"""Server-side screener API (docs/design/server-screener.md §4).

Every endpoint here reads the database only and never calls the provider: scans and snapshots
come from the nightly tables, `/runs` asks the job (`stack.screener`) to start a run, which does
its own upstream work in the background. Saved screens live in `routes/screens.py`.
"""

import hashlib
import json
import threading
import time
from collections import OrderedDict
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from ..deps import SessionDep, SettingsDep
from ..models import Bar, ScreenerFundamental, ScreenerRun, ScreenerSnapshot, ScreenerSymbol
from ..services.screener import universe as uv
from ..services.screener.fields import definitions, provider_has_screen_info
from ..services.screener.job import RunInProgress
from ..services.screener.query import (
    CURRENT_LAG_DAYS,
    ScanError,
    current_cutoff,
    data_version,
    iso,
    latest_finished_run,
    run_scan,
    snapshot_values,
    target_date,
    validate_request,
)
from ..services.screener.schemas import (
    FieldsResponse,
    ListPut,
    ListSummary,
    RunRequest,
    RunResponse,
    ScanRequest,
    ScanResponse,
    ScreenerClass,
    SnapshotResponse,
    StatusBudget,
    StatusCoverage,
    StatusResponse,
    StatusRunning,
)
from ._cache_headers import NO_CACHE, set_no_cache

router = APIRouter(prefix="/screener", tags=["screener"])

MAX_SNAPSHOT_SYMBOLS = 200
#: Longest `symbols` query string: 200 symbols of 32 characters plus the commas.
MAX_SNAPSHOT_QUERY = MAX_SNAPSHOT_SYMBOLS * 33
SCAN_CACHE_SIZE = 64
_FINISHED = ("done", "partial")
#: `count(*)` over millions of bars is slow: `/status` reports a count at most this old.
BARS_ROWS_TTL_S = 600.0

# ------------------------------------------------------------------ helpers


def _bars_rows(request: Request, session: Session, version: datetime | None) -> int:
    """Row count of `bars`, cached on the app for `BARS_ROWS_TTL_S` (an estimate for display).
    `version` (the newest snapshot's `computed_at`) ends the cache early: bars only change in
    bulk when a run stores snapshots, so the count is re-read after each of those."""
    state = request.app.state
    cached: tuple[float, datetime | None, int] | None = getattr(state, "screener_bars_rows", None)
    now = time.monotonic()
    if cached is not None and now - cached[0] < BARS_ROWS_TTL_S and cached[1] == version:
        return cached[2]
    rows = session.scalar(select(func.count()).select_from(Bar)) or 0
    state.screener_bars_rows = (now, version, rows)
    return rows


def _etag(value: str) -> str:
    return f'"{value}"'


def _matches(header: str | None, etag: str) -> bool:
    """Whether an `If-None-Match` header names `etag` (weak comparison, `*` matches)."""
    if not header:
        return False
    tags = [t.strip() for t in header.split(",")]
    return "*" in tags or any(t.removeprefix("W/") == etag for t in tags)


def _not_modified(etag: str) -> Response:
    return Response(status_code=304, headers={"ETag": etag, "Cache-Control": NO_CACHE})


def _screener(request: Request) -> Any:
    """`stack.screener` (WP2's `ScreenerJob`), None while the stack has none."""
    return getattr(request.app.state.market_stack, "screener", None)


def _fundamentals_available(request: Request) -> bool:
    """Whether the active provider offers the optional `ScreenInfoProvider` capability."""
    return provider_has_screen_info(request.app.state.runtime.provider.inner)


def _job_target(screener: Any) -> date | None:
    fn = getattr(screener, "target_date", None)
    if not callable(fn):
        return None
    out = fn()
    return out if isinstance(out, date) else None


def _text(value: Any) -> str | None:
    if value is None:
        return None
    return iso(value) if isinstance(value, datetime) else str(value)


class _ScanCache:
    """In-process LRU of serialized scan responses, keyed by their ETag."""

    def __init__(self, size: int) -> None:
        self._size = size
        self._items: OrderedDict[str, bytes] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> bytes | None:
        with self._lock:
            body = self._items.get(key)
            if body is not None:
                self._items.move_to_end(key)
            return body

    def put(self, key: str, body: bytes) -> None:
        with self._lock:
            self._items[key] = body
            self._items.move_to_end(key)
            while len(self._items) > self._size:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()


_scan_cache = _ScanCache(SCAN_CACHE_SIZE)


# ----------------------------------------------------------------- universe


@router.get("/universe")
def universe(
    session: SessionDep,
    cls: Annotated[ScreenerClass, Query()],
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    """The bundled symbol universe of a class (the web `Universe` shape); ETag = bundle hash."""
    etag = _etag(uv.bundle_hash())
    if _matches(if_none_match, etag):
        return _not_modified(etag)
    body = json.dumps(uv.universe_payload(session, cls), separators=(",", ":"))
    return Response(
        body, media_type="application/json", headers={"ETag": etag, "Cache-Control": NO_CACHE}
    )


@router.get("/lists", response_model=list[ListSummary])
def lists(session: SessionDep, response: Response) -> list[dict[str, Any]]:
    out = uv.list_lists(session)
    set_no_cache(response)
    return out


@router.put("/lists/{list_id}", response_model=ListSummary)
def put_list(session: SessionDep, list_id: str, body: ListPut) -> dict[str, Any]:
    """Create a custom list or override a bundled one (source 'upload')."""
    try:
        out = uv.put_list(session, list_id, body.name, body.as_of, body.symbols)
    except uv.ListError as exc:
        session.rollback()
        raise HTTPException(422, {"code": exc.code, "message": str(exc), "path": ""}) from None
    session.commit()
    return out


@router.delete("/lists/{list_id}")
def delete_list(session: SessionDep, list_id: str) -> dict[str, str]:
    """Revert an overridden bundled list or remove a custom one; 404 if there is none."""
    status = uv.delete_list(session, list_id)
    if status == "missing":
        session.rollback()
        raise HTTPException(404, f"list not found: {list_id}")
    session.commit()
    return {"status": status}


# ------------------------------------------------------------------- fields


@router.get("/fields", response_model=FieldsResponse)
def fields(request: Request, response: Response) -> FieldsResponse:
    """Every field with its operators; fundamentals are `available: false` when the provider
    cannot serve them."""
    set_no_cache(response)
    return FieldsResponse(fields=definitions(fundamentals=_fundamentals_available(request)))


# --------------------------------------------------------------------- scan


@router.post("/scan", response_model=ScanResponse, responses={304: {"description": "unchanged"}})
def scan(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    body: ScanRequest,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    """Run a scan on the stored snapshots. 422 `{detail:{code,message,path}}` for a request
    that does not hold together, 404 for an unknown list or watchlist. ETag-cached."""
    now = datetime.now(UTC)
    fundamentals = _fundamentals_available(request)
    try:
        validate_request(body, fundamentals=fundamentals)  # before any SQL runs
    except ScanError as exc:
        raise HTTPException(exc.status, exc.detail()) from None
    target = _job_target(_screener(request))
    canonical = json.dumps(
        body.model_dump(mode="json", by_alias=True), sort_keys=True, separators=(",", ":")
    )
    key = f"{data_version(session, now)}|{int(fundamentals)}|{target}|{canonical}"
    etag = _etag(hashlib.sha1(key.encode()).hexdigest())
    if _matches(if_none_match, etag):
        return _not_modified(etag)
    payload = _scan_cache.get(etag)
    if payload is None:
        try:
            result = run_scan(
                session, body, settings=settings, now=now, fundamentals=fundamentals, target=target
            )
        except ScanError as exc:
            raise HTTPException(exc.status, exc.detail()) from None
        payload = result.model_dump_json(by_alias=True).encode()
        _scan_cache.put(etag, payload)
    return Response(
        payload, media_type="application/json", headers={"ETag": etag, "Cache-Control": NO_CACHE}
    )


# ------------------------------------------------------------------- status


def _disabled_runtime(rate: float) -> dict[str, Any]:
    return {
        "enabled": False,
        "supported": False,
        "reason": "disabled",
        "running": None,
        "nextRunAt": None,
        "ratePerMin": rate,
    }


@router.get("/status", response_model=StatusResponse)
def status(
    request: Request, response: Response, session: SessionDep, settings: SettingsDep
) -> StatusResponse:
    """The screener's state: job runtime (or a disabled stub) plus counts from the database."""
    screener = _screener(request)
    rt = (
        screener.runtime()
        if screener is not None
        else _disabled_runtime(settings.screener_rate_per_min)
    )
    spec = request.app.state.provider_spec
    snap = ScreenerSnapshot.__table__.c
    sym = ScreenerSymbol.__table__.c
    target = _job_target(screener) or target_date(session)

    live = sym.tombstoned_at.is_(None)
    present = session.scalar(select(func.count()).where(live)) or 0
    tombstoned = session.scalar(select(func.count()).where(sym.tombstoned_at.is_not(None))) or 0
    failed = session.scalar(select(func.count()).where(live, sym.fail_count > 0)) or 0
    fresh = stale = 0
    if target is not None:
        tracked_snaps = (
            select(snap.as_of_date, snap.computed_at)
            .select_from(
                ScreenerSymbol.__table__.join(ScreenerSnapshot.__table__, snap.symbol == sym.symbol)
            )
            .where(live)
            .subquery()
        )
        # Current: the target session's bar, or one day behind (crypto) and computed once
        # nothing newer could exist (same rule as `run_scan`'s `stale`).
        current = or_(
            tracked_snaps.c.as_of_date >= target,
            and_(
                tracked_snaps.c.as_of_date >= target - timedelta(days=CURRENT_LAG_DAYS),
                tracked_snaps.c.computed_at >= current_cutoff(target, settings),
            ),
        )
        fresh = session.scalar(select(func.count()).select_from(tracked_snaps).where(current)) or 0
        stale = session.scalar(select(func.count()).select_from(tracked_snaps).where(~current)) or 0
    newest_computed = session.scalar(select(func.max(snap.computed_at)))
    as_of, computed_at = latest_finished_run(session)
    run = ScreenerRun.__table__.c
    fundamentals_as_of = session.scalar(
        select(func.max(run.target_date)).where(
            run.kind == "fundamentals", run.status.in_(_FINISHED)
        )
    )
    if fundamentals_as_of is None:
        quote_at = session.scalar(select(func.max(ScreenerFundamental.__table__.c.quote_at)))
        fundamentals_as_of = quote_at.date() if quote_at is not None else None
    tokens = session.scalar(
        select(run.tokens)
        .where(run.kind == "snapshot", run.status != "running")
        .order_by(run.started_at.desc(), run.id.desc())
        .limit(1)
    )
    bars_rows = _bars_rows(request, session, newest_computed)

    watchlist_extra = uv.WATCHLIST_ALLOWANCE if settings.screener_include_watchlists else 0
    reason = rt.get("reason")
    if reason is None and as_of is None:
        reason = "first_run"
    running = rt.get("running")
    set_no_cache(response)
    return StatusResponse(
        enabled=bool(rt.get("enabled")),
        supported=bool(rt.get("supported")),
        reason=reason,
        provider=spec.id if spec is not None else "custom",
        as_of=as_of.isoformat() if as_of is not None else None,
        computed_at=iso(computed_at),
        fundamentals_as_of=fundamentals_as_of.isoformat() if fundamentals_as_of else None,
        coverage=StatusCoverage(
            tracked=min(present, max(0, settings.screener_max_symbols) + watchlist_extra),
            fresh=fresh,
            stale=stale,
            failed=failed,
            tombstoned=tombstoned,
        ),
        running=(
            StatusRunning(
                run_id=running["runId"],
                kind=running["kind"],
                done=running["done"],
                total=running["total"],
                started_at=_text(running.get("startedAt")),
                eta_s=running.get("etaS"),
            )
            if running
            else None
        ),
        next_run_at=_text(rt.get("nextRunAt")),
        budget=StatusBudget(
            rate_per_min=float(rt.get("ratePerMin", settings.screener_rate_per_min)),
            tokens_last_run=tokens,
        ),
        bars_rows=bars_rows,
    )


@router.post("/runs", status_code=202, response_model=RunResponse)
def start_run(request: Request, body: RunRequest) -> RunResponse:
    """Ask the job to start a run now. 409 if one is running, 503 if the screener is off."""
    screener = _screener(request)
    if screener is None or not screener.runtime().get("enabled"):
        raise HTTPException(
            503, {"code": "disabled", "message": "the screener is disabled", "path": ""}
        )
    try:
        run_id = screener.trigger(body.kind)
    except RunInProgress as exc:
        # The job words the reason: a run going, or a finished one's cooldown ("retry after ...").
        raise HTTPException(
            409,
            {"code": "run_in_progress", "message": str(exc) or "a run is already in progress"},
        ) from None
    return RunResponse(run_id=run_id)


# ----------------------------------------------------------------- snapshot


@router.get("/snapshot", response_model=SnapshotResponse)
def snapshot(
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    symbols: Annotated[str, Query(min_length=1, max_length=MAX_SNAPSHOT_QUERY)],
) -> SnapshotResponse:
    """Stored values of every non-meta field for up to 200 symbols (database only). Symbols the
    screener does not track are left out of `rows`."""
    parsed = list(dict.fromkeys(s.strip().upper() for s in symbols.split(",") if s.strip()))
    if not parsed:
        raise HTTPException(422, "symbols must not be empty")
    if len(parsed) > MAX_SNAPSHOT_SYMBOLS:
        raise HTTPException(422, f"at most {MAX_SNAPSHOT_SYMBOLS} symbols")
    bad = next((s for s in parsed if not uv.SYMBOL_RE.match(s)), None)
    if bad is not None:
        raise HTTPException(422, f"invalid symbol: {bad!r}")
    as_of, rows = snapshot_values(session, parsed, settings=settings, now=datetime.now(UTC))
    set_no_cache(response)
    return SnapshotResponse(as_of=as_of, rows=rows)
