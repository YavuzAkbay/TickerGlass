"""HTTP request counters as a pure ASGI middleware (docs/design/metrics.md §4.1).

Not `BaseHTTPMiddleware`: streaming responses and websockets pass through untouched. The
route label is the matched route template, so it stays bounded whatever the clients ask for.
"""

import time
from typing import TYPE_CHECKING, Any

from starlette.types import ASGIApp, Message, Receive, Scope, Send

if TYPE_CHECKING:
    from . import Metrics

METHODS = frozenset({"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"})
METRICS_PATH = "/metrics"


def _status_class(status: int) -> str:
    return f"{status // 100}xx" if 100 <= status < 600 else "other"


def _route_label(scope: Scope) -> str:
    """Template of the matched route (`/api/alerts/{alert_id}`), `unmatched` for none.

    FastAPI does not flatten included routers, so the matched route's own `path` lacks the
    prefixes; the full template is the effective route context's (what FastAPI's telemetry
    reports as `http.route`), with the bare route path as the fallback."""
    fastapi_scope: Any = scope.get("fastapi")
    context = (
        fastapi_scope.get("effective_route_context") if isinstance(fastapi_scope, dict) else None
    )
    for holder in (getattr(context, "starlette_route", None), context, scope.get("route")):
        for attr in ("path_format", "path"):
            path = getattr(holder, attr, None)
            if isinstance(path, str) and path:
                return path
    return "unmatched"


class MetricsMiddleware:
    def __init__(self, app: ASGIApp, metrics: "Metrics") -> None:
        self.app = app
        self.metrics = metrics

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket") or scope.get("path") == METRICS_PATH:
            await self.app(scope, receive, send)
            return
        if kind == "websocket":
            await self._websocket(scope, receive, send)
            return
        started = time.perf_counter()
        status = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            method = scope.get("method", "GET")
            method = method if method in METHODS else "other"
            route = _route_label(scope)
            self.metrics.http_requests.labels(method, route, _status_class(status)).inc()
            self.metrics.http_duration.labels(method, route).observe(time.perf_counter() - started)

    async def _websocket(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Counted once, on connect (accepted: 101, refused before the accept: 403)."""
        counted = False

        async def send_wrapper(message: Message) -> None:
            nonlocal counted
            if not counted and message["type"] in ("websocket.accept", "websocket.close"):
                counted = True
                self.metrics.http_requests.labels(
                    "GET", "websocket", "1xx" if message["type"] == "websocket.accept" else "4xx"
                ).inc()
            await send(message)

        await self.app(scope, receive, send_wrapper)
