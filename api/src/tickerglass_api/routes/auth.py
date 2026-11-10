"""Login/logout and the auth state the login screen needs. Public: the middleware
lets `/api/auth/*` through, so these routes work whether or not `AUTH_PASSWORD` is
set. Secrets only ever compare in constant time."""

import hmac

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from ..auth import (
    COOKIE_NAME,
    SESSION_TTL_S,
    LoginLimiter,
    make_token,
    verify_token,
)
from ..deps import SettingsDep

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    password: str


def _secure(request: Request) -> bool:
    """Cookie `Secure` when the request arrived over https (directly or via a
    reverse proxy setting X-Forwarded-Proto)."""
    if request.url.scheme == "https":
        return True
    return request.headers.get("x-forwarded-proto", "").lower() == "https"


@router.get("/state")
def auth_state(request: Request, settings: SettingsDep) -> dict[str, bool]:
    enabled = bool(settings.auth_password)
    authed = False
    if enabled:
        secret: str = request.app.state.auth_secret
        authed = verify_token(
            request.cookies.get(COOKIE_NAME), secret, settings.auth_password or ""
        )
    return {"enabled": enabled, "authed": authed}


@router.post("/login", status_code=204)
def login(request: Request, body: LoginIn, settings: SettingsDep) -> Response:
    expected = settings.auth_password
    if not expected:
        raise HTTPException(400, "auth is not enabled")
    ip = request.client.host if request.client else "unknown"
    limiter: LoginLimiter = request.app.state.login_limiter
    lock = limiter.lockout_remaining(ip)
    if lock <= 0 and not hmac.compare_digest(body.password.encode(), expected.encode()):
        lock = limiter.record_failure(ip)
        if lock <= 0:
            raise HTTPException(401, "wrong password")
    if lock > 0:
        raise HTTPException(
            429,
            "too many failed attempts; try again later",
            headers={"Retry-After": str(int(lock) + 1)},
        )
    response = Response(status_code=204)
    response.set_cookie(
        COOKIE_NAME,
        make_token(request.app.state.auth_secret, expected),
        max_age=SESSION_TTL_S,
        httponly=True,
        samesite="lax",
        secure=_secure(request),
        path="/",
    )
    return response


@router.post("/logout", status_code=204)
def logout() -> Response:
    response = Response(status_code=204)
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
