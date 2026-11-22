"""`GET /metrics` (docs/design/metrics.md §2-§3). Not under `/api`, not behind the session
auth (it is a public path of the middleware): the endpoint checks its own bearer token, so
scraping credentials stay apart from user and service credentials."""

import hmac
from typing import Annotated

from fastapi import APIRouter, Header, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST

from ..deps import SettingsDep
from ..metrics import Metrics

router = APIRouter(tags=["metrics"])


def _token_ok(authorization: str | None, expected: str) -> bool:
    scheme, _, given = (authorization or "").partition(" ")
    if scheme.lower() != "bearer":
        return False
    return hmac.compare_digest(given.strip().encode(), expected.encode())


@router.get("/metrics", include_in_schema=False)
async def metrics(
    request: Request,
    settings: SettingsDep,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    registry: Metrics | None = getattr(request.app.state, "metrics", None)
    if registry is None:
        return JSONResponse({"detail": "not found"}, status_code=404)
    expected = settings.metrics_token_value
    if expected is not None and not _token_ok(authorization, expected):
        return JSONResponse(
            {"detail": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
        )
    # The collector reads the database and takes locks: keep it off the event loop.
    body = await run_in_threadpool(registry.render)
    return Response(body, media_type=CONTENT_TYPE_LATEST, headers={"Cache-Control": "no-store"})
