"""Login/logout, OIDC sign-in and the auth state the login screen needs. Public: the
middleware lets `/api/auth/*` through, so these routes work whether or not auth is
enabled. Secrets only ever compare in constant time."""

import hmac
import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from ..accounts import (
    BOOTSTRAP_USERNAME,
    Accounts,
    UserRecord,
    normalize_username,
    password_key,
)
from ..auth import (
    COOKIE_NAME,
    Authenticator,
    Identity,
    LoginLimiter,
    is_allowed,
    make_oidc_flow,
    pair_key,
    read_oidc_flow,
)
from ..auth_oidc import (
    DENIED,
    FLOW_TTL_S,
    STATE,
    TOKEN,
    Flow,
    OidcClient,
    OidcError,
)
from ..deps import SettingsDep
from ..passwords import MAX_LENGTH, burn_verify, verify_password
from ..settings import Settings

log = logging.getLogger("tickerglass.auth")

router = APIRouter(prefix="/auth", tags=["auth"])

OIDC_COOKIE = "tickerglass_oidc"
OIDC_COOKIE_PATH = "/api/auth/oidc"
COOKIE_METHODS = ("password", "oidc")


class LoginIn(BaseModel):
    #: Empty or `admin`: the bootstrap `AUTH_PASSWORD` (the owner user); else a local account.
    username: str | None = Field(default=None, max_length=64)
    password: str = Field(max_length=MAX_LENGTH)


def _authenticator(request: Request) -> Authenticator | None:
    auth: Authenticator | None = getattr(request.app.state, "authenticator", None)
    return auth


def _oidc(request: Request) -> OidcClient:
    client: OidcClient | None = getattr(request.app.state, "oidc", None)
    if client is None:
        raise HTTPException(404, "oidc is not enabled")
    return client


def _require(request: Request) -> Authenticator:
    auth = _authenticator(request)
    if auth is None:
        raise HTTPException(404, "auth is not enabled")
    return auth


def _accounts(request: Request) -> Accounts:
    accounts: Accounts = request.app.state.accounts
    return accounts


@router.get("/state")
def auth_state(request: Request, settings: SettingsDep) -> dict[str, Any]:
    auth = _authenticator(request)
    if auth is None:
        return {
            "enabled": False,
            "authed": False,
            "methods": [],
            "oidcName": None,
            "user": None,
            "logoutAvailable": False,
            "canManageUsers": False,
            "localAccounts": False,
        }
    who = auth.user_for(request.scope)
    return {
        "enabled": True,
        "authed": who is not None,
        "methods": list(auth.methods),
        "oidcName": settings.oidc_provider_name if "oidc" in auth.methods else None,
        "user": {
            "id": who.id,
            "name": who.name,
            "email": who.email,
            "method": who.method,
            "role": who.role,
            # The owner account: the one the data of an upgraded install went to.
            "isOwner": who.id == _accounts(request).owner_id(),
        }
        if who
        else None,
        "logoutAvailable": bool(settings.auth_logout_url)
        or (who is not None and who.method in COOKIE_METHODS),
        "canManageUsers": who is not None and who.is_admin,
        "localAccounts": "password" in auth.methods,
    }


def _check_credentials(
    accounts: Accounts, settings: Settings, username: str, password: str
) -> UserRecord | None:
    """The user these credentials belong to, None if they do not match (the same work is
    done for unknown names)."""
    if username == BOOTSTRAP_USERNAME:
        expected = settings.auth_password or ""
        if not expected or not hmac.compare_digest(password.encode(), expected.encode()):
            return None
        return accounts.get(accounts.owner_id())
    record = accounts.by_identity(password_key(username))
    if record is None or record.password_hash is None:
        burn_verify(password)
        return None
    return record if verify_password(record.password_hash, password) else None


@router.post("/login", status_code=204)
def login(request: Request, body: LoginIn, settings: SettingsDep) -> Response:
    auth = _authenticator(request)
    if not settings.auth_password or auth is None or "password" not in auth.methods:
        raise HTTPException(400, "password sign-in is not enabled")
    accounts = _accounts(request)
    username = normalize_username(body.username or "") or BOOTSTRAP_USERNAME
    ip = auth.client_ip(request.scope)
    ip_limiter: LoginLimiter = request.app.state.login_limiter
    pair_limiter: LoginLimiter = request.app.state.pair_limiter
    pair = pair_key(ip, username)
    lock = max(ip_limiter.lockout_remaining(ip), pair_limiter.lockout_remaining(pair))
    record = None
    if lock <= 0:
        record = _check_credentials(accounts, settings, username, body.password)
        if record is None:
            lock = max(ip_limiter.record_failure(ip), pair_limiter.record_failure(pair))
            if lock <= 0:
                raise HTTPException(401, "wrong password")
    if lock > 0:
        raise HTTPException(
            429,
            "too many failed attempts; try again later",
            headers={"Retry-After": str(int(lock) + 1)},
        )
    assert record is not None
    ip_limiter.record_success(ip)
    pair_limiter.record_success(pair)
    if record.disabled:
        raise HTTPException(401, "account disabled")
    response = Response(status_code=204)
    set_password_session(response, auth, request, record, username)
    return response


def set_password_session(
    response: Response, auth: Authenticator, request: Request, record: UserRecord, username: str
) -> None:
    response.set_cookie(
        COOKIE_NAME,
        auth.session_cookie(
            sub=username,
            name=record.name,
            email=record.email,
            method="password",
            uid=record.id,
            password_hash=None if username == BOOTSTRAP_USERNAME else record.password_hash,
        ),
        max_age=auth.session_ttl_s,
        httponly=True,
        samesite="lax",
        secure=auth.secure(request.scope),
        path="/",
    )


def _clear_flow_cookie(response: Response, secure: bool) -> None:
    response.delete_cookie(
        OIDC_COOKIE, path=OIDC_COOKIE_PATH, httponly=True, samesite="lax", secure=secure
    )


def _error(code: str, secure: bool) -> Response:
    response = RedirectResponse(f"/?auth_error={code}", status_code=302)
    _clear_flow_cookie(response, secure)
    return response


@router.get("/oidc/login")
def oidc_login(request: Request, next: str | None = None) -> Response:  # noqa: A002
    client = _oidc(request)
    auth = _require(request)
    secure = auth.secure(request.scope)
    try:
        url, flow = client.begin(next)
    except OidcError as exc:
        log.warning("oidc login failed: %s (%s)", exc.code, exc.detail)
        return _error(exc.code, secure)
    sealed = make_oidc_flow(
        auth.secret,
        {
            "state": flow.state,
            "nonce": flow.nonce,
            "verifier": flow.verifier,
            "next": flow.next,
            "exp": time.time() + FLOW_TTL_S,
        },
    )
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        OIDC_COOKIE,
        sealed,
        max_age=FLOW_TTL_S,
        httponly=True,
        samesite="lax",
        secure=secure,
        path=OIDC_COOKIE_PATH,
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@router.get("/oidc/callback")
def oidc_callback(
    request: Request,
    settings: SettingsDep,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> Response:
    client = _oidc(request)
    auth = _require(request)
    secure = auth.secure(request.scope)
    try:
        response = _complete(request, client, auth, settings, code, state, error)
    except OidcError as exc:
        log.warning("oidc sign-in failed: %s (%s)", exc.code, exc.detail)
        return _error(exc.code, secure)
    except Exception as exc:  # noqa: BLE001 - never a 500 with the flow cookie left behind
        # Type only: the message of an unexpected error might quote a token.
        log.warning("oidc sign-in failed unexpectedly: %s", type(exc).__name__)
        return _error(TOKEN, secure)
    _clear_flow_cookie(response, secure)
    response.headers["Cache-Control"] = "no-store"
    return response


def _complete(
    request: Request,
    client: OidcClient,
    auth: Authenticator,
    settings: Settings,
    code: str | None,
    state: str | None,
    error: str | None,
) -> Response:
    data = read_oidc_flow(request.cookies.get(OIDC_COOKIE), auth.secret)
    if data is None or not state:
        raise OidcError(STATE, "flow cookie missing, invalid or expired")
    flow = Flow(
        state=str(data.get("state", "")),
        nonce=str(data.get("nonce", "")),
        verifier=str(data.get("verifier", "")),
        next=str(data.get("next", "/")),
    )
    if not flow.state or not hmac.compare_digest(state.encode(), flow.state.encode()):
        raise OidcError(STATE, "state mismatch")
    if error:
        raise OidcError(DENIED, f"provider returned error {error[:64]!r}")
    if not code:
        raise OidcError(STATE, "callback without a code")
    user = client.finish(code, flow)
    names = [user.sub, user.username, user.email if user.email_verified else None]
    # Admin matching (promotion and the implicit allow) uses the immutable `sub` or the verified
    # email only: `preferred_username` is user-editable at some IdPs (it still counts for
    # `AUTH_ALLOWED_USERS`).
    admin_names = [user.sub, user.email if user.email_verified else None]
    if not is_allowed(settings, names=names, groups=user.groups, admin_names=admin_names):
        raise OidcError(DENIED, "user is not in the allow-lists")
    record = _accounts(request).resolve(
        Identity(user.sub, user.name, user.email, tuple(user.groups), "oidc"),
        names=admin_names,
        groups=user.groups,
        fresh=True,
    )
    if record is None:
        raise OidcError(DENIED, "no account for this identity (AUTH_AUTO_PROVISION is off)")
    if record.disabled:
        raise OidcError(DENIED, "account is disabled")
    response = RedirectResponse(flow.next, status_code=302)
    response.set_cookie(
        COOKIE_NAME,
        auth.session_cookie(
            sub=user.sub, name=user.name, email=user.email, method="oidc", uid=record.id
        ),
        max_age=auth.session_ttl_s,
        httponly=True,
        samesite="lax",
        secure=auth.secure(request.scope),
        path="/",
    )
    return response


@router.post("/logout")
def logout(request: Request, settings: SettingsDep) -> Response:
    auth = _authenticator(request)
    who: Identity | None = auth.authenticate(request.scope) if auth else None
    redirect: str | None = None
    if who is not None and who.method == "oidc":
        client: OidcClient | None = getattr(request.app.state, "oidc", None)
        redirect = client.end_session_url() if client else None
    if redirect is None:
        redirect = settings.auth_logout_url
    response = JSONResponse({"redirect": redirect})
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
