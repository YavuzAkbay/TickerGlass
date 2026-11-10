"""Hotlists API: `GET /api/screener/hotlists` (docs/screener.md). Reads the database only and
never calls the provider; ETag-cached like `/screener/scan`."""

import hashlib
from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from pydantic import ValidationError

from ..deps import SessionDep, SettingsDep
from ..services.screener.hotlists import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    HotlistKind,
    HotlistResponse,
    parse_universe,
    run_hotlist,
)
from ..services.screener.query import ScanError, data_version
from ._cache_headers import NO_CACHE

router = APIRouter(prefix="/screener", tags=["screener"])


def _job_target(request: Request) -> date | None:
    screener = getattr(request.app.state.market_stack, "screener", None)
    fn = getattr(screener, "target_date", None)
    if not callable(fn):
        return None
    out: Any = fn()
    return out if isinstance(out, date) else None


def _matches(header: str | None, etag: str) -> bool:
    if not header:
        return False
    tags = [t.strip() for t in header.split(",")]
    return "*" in tags or any(t.removeprefix("W/") == etag for t in tags)


@router.get("/hotlists", response_model=HotlistResponse, responses={304: {"description": "same"}})
def hotlists(
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    kind: Annotated[HotlistKind, Query()],
    universe: Annotated[str, Query(max_length=64)] = "stocks",
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    """Top rows of a ranking (gainers, oversold, ...) over a class (`stocks`, `etfs`, `crypto`,
    `commodities`) or a list (`list:<id>`) from the last close snapshot. Empty with `asOf: null`
    before the first screener run. 422 for an unknown kind or universe, 404 for an unknown list."""
    parsed = parse_universe(universe)
    if parsed is None:
        raise HTTPException(
            422,
            {"code": "bad_value", "message": f"invalid universe: {universe!r}", "path": "universe"},
        )
    now = datetime.now(UTC)
    target = _job_target(request)
    key = f"{data_version(session, now)}|{target}|{kind}|{universe}|{limit}"
    etag = f'"{hashlib.sha1(key.encode()).hexdigest()}"'
    if _matches(if_none_match, etag):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": NO_CACHE})
    try:
        result = run_hotlist(
            session, kind, universe, parsed, limit, settings=settings, now=now, target=target
        )
    except ScanError as exc:
        raise HTTPException(exc.status, exc.detail()) from None
    except ValidationError:
        raise HTTPException(
            422,
            {"code": "bad_value", "message": f"invalid universe: {universe!r}", "path": "universe"},
        ) from None
    return Response(
        result.model_dump_json(by_alias=True),
        media_type="application/json",
        headers={"ETag": etag, "Cache-Control": NO_CACHE},
    )
