"""Optional single-user password auth (docs/self-hosting.md).

`AUTH_PASSWORD` enables it: a signed HttpOnly session cookie guards every API route
and the `/ws` relay except `/api/health`, `/api/auth/*`, and requests that carry the
alerts service's `X-Alerts-Token` (reads anywhere, plus its write routes). Unset (the
default) keeps the app open, as before. Sessions survive restarts via a random secret
persisted next to a SQLite database, or `AUTH_SECRET` for Postgres.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import TYPE_CHECKING, cast

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .db import sqlite_path

if TYPE_CHECKING:
    from .settings import Settings

COOKIE_NAME = "tickerglass_session"
SESSION_TTL_S = 30 * 86400
LOCKOUT_S = 60.0
MAX_FAILURES = 5

# The browser needs these to decide between the login screen and the app; health
# stays open for the compose healthcheck. Logout is public by design (clears a cookie).
PUBLIC_PATHS = ("/api/health",)
PUBLIC_PREFIXES = ("/api/auth/",)


def session_secret(settings: Settings) -> str:
    """`AUTH_SECRET`, or a random secret persisted next to a SQLite database so
    sessions survive restarts; Postgres without `AUTH_SECRET` gets an ephemeral
    secret (everyone logs in again after a restart)."""
    if settings.auth_secret:
        return settings.auth_secret
    path = sqlite_path(settings.database_url)
    if path is not None:
        file = path.parent / ".session_secret"
        try:
            return file.read_text().strip()
        except FileNotFoundError:
            secret = secrets.token_hex(32)
            try:
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(secret)
                return secret
            except OSError:
                pass  # read-only volume: fall through to an ephemeral secret
    return secrets.token_hex(32)


def _sign(payload: str, secret: str) -> str:
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _password_tag(password: str) -> str:
    """Binds a session to the password it was created with: changing
    `AUTH_PASSWORD` signs every existing session out at once."""
    return hashlib.sha256(password.encode()).hexdigest()


def make_token(secret: str, password: str, now: float | None = None) -> str:
    expires = int((now if now is not None else time.time()) + SESSION_TTL_S)
    payload = f"{expires}.{_password_tag(password)}"
    return f"{payload}.{_sign(payload, secret)}"


def verify_token(token: str | None, secret: str, password: str, now: float | None = None) -> bool:
    if not token or token.count(".") < 2:
        return False
    payload, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(payload, secret)):
        return False
    expires_str, _, tag = payload.partition(".")
    try:
        expires = int(expires_str)
    except ValueError:
        return False
    if not hmac.compare_digest(tag, _password_tag(password)):
        return False
    return (now if now is not None else time.time()) < expires


class LoginLimiter:
    """Per-client failed-login counter: `MAX_FAILURES` misses lock the source out
    for `LOCKOUT_S`. In memory only (a restart clears it); no new dependencies."""

    def __init__(self) -> None:
        self._fails: dict[str, tuple[int, float]] = {}

    def lockout_remaining(self, ip: str) -> float:
        fails, until = self._fails.get(ip, (0, 0.0))
        if fails < MAX_FAILURES:
            return 0.0
        now = time.monotonic()
        if now >= until:
            del self._fails[ip]
            return 0.0
        return until - now

    def record_failure(self, ip: str) -> float:
        """Count one failure; returns the new lockout duration (0 = not locked)."""
        if self.lockout_remaining(ip) > 0:
            return LOCKOUT_S
        fails, _ = self._fails.get(ip, (0, 0.0))
        if fails + 1 >= MAX_FAILURES:
            self._fails[ip] = (MAX_FAILURES, time.monotonic() + LOCKOUT_S)
            return LOCKOUT_S
        self._fails[ip] = (fails + 1, 0.0)
        return 0.0

    def record_success(self, ip: str) -> None:
        self._fails.pop(ip, None)


def _header(scope: Scope, name: bytes) -> str | None:
    headers: list[tuple[bytes, bytes]] = cast("list[tuple[bytes, bytes]]", scope.get("headers", []))
    for key, value in headers:
        if key == name:
            return value.decode("latin-1")
    return None


def _query(scope: Scope, name: str) -> str | None:
    raw: bytes = cast("bytes", scope.get("query_string", b""))
    for part in raw.decode("latin-1").split("&"):
        key, _, value = part.partition("=")
        if key == name:
            return value
    return None


def _cookie(scope: Scope, name: str) -> str | None:
    raw = _header(scope, b"cookie")
    if raw is None:
        return None
    for part in raw.split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return None


def _alerts_service_route(path: str, method: str) -> bool:
    """The service's write routes (its reads may use the token on any GET)."""
    if path in ("/api/alerts/states", "/api/alerts/service/heartbeat"):
        return True
    rest = path[len("/api/alerts/") :] if path.startswith("/api/alerts/") else ""
    return method in ("POST", "PUT") and (rest.endswith("/fire") or rest.endswith("/status"))


class AuthMiddleware:
    """Pure ASGI guard: valid session cookie (or alerts token) passes, everything
    else gets a 401 (http) or a pre-accept close (websocket)."""

    def __init__(
        self, app: ASGIApp, secret: str, password: str, internal_token: str | None
    ) -> None:
        self.app = app
        self.secret = secret
        self.password = password
        self.internal_token = internal_token

    def _cookie_ok(self, scope: Scope) -> bool:
        return verify_token(_cookie(scope, COOKIE_NAME), self.secret, self.password)

    def _token_ok(self, scope: Scope, path: str, method: str) -> bool:
        """`X-Alerts-Token` covers the alerts service: reads anywhere (it lists
        alerts, states and drawings), plus its write routes. It cannot cover the
        user-data writes, so a leaked token does not unlock those. WebSocket
        handshakes cannot carry headers, so the service passes the token as an
        `auth_token` query parameter instead."""
        if not self.internal_token:
            return False
        if scope["type"] == "websocket":
            token = _query(scope, "auth_token")
            return token is not None and hmac.compare_digest(token, self.internal_token)
        token = _header(scope, b"x-alerts-token")
        if token is None or not hmac.compare_digest(token, self.internal_token):
            return False
        return method == "GET" or _alerts_service_route(path, method)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        stype = scope["type"]
        if stype not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        method = scope.get("method", "GET") if stype == "http" else "GET"
        if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
            await self.app(scope, receive, send)
            return
        if self._cookie_ok(scope) or self._token_ok(scope, path, method):
            await self.app(scope, receive, send)
            return
        if stype == "http":
            await JSONResponse({"detail": "unauthorized"}, status_code=401)(scope, receive, send)
        else:
            # Before the accept: uvicorn turns this into a failed handshake, which
            # the clients treat like any dropped socket (backoff and retry).
            await send({"type": "websocket.close", "code": 4401})
