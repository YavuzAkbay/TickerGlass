"""Users and the signed-in user's own account (docs/design/multi-user.md): admin user
management under `/users`, self-service under `/me`. Responses never carry a password hash;
identities are listed by method only."""

import logging
import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel as PydanticModel
from pydantic import ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import models as m
from ..accounts import (
    BOOTSTRAP_USERNAME,
    ROLE_ADMIN,
    Accounts,
    CurrentUser,
    normalize_username,
    now,
    password_key,
)
from ..auth import LoginLimiter
from ..deps import AccountsDep, AdminDep, HubDep, OwnedSessionDep, SettingsDep, UserDep
from ..passwords import MAX_LENGTH, MIN_LENGTH, check_strength, hash_password, verify_password
from .auth import set_password_session

log = logging.getLogger("tickerglass.auth")

router = APIRouter(prefix="/users", tags=["users"])
me_router = APIRouter(prefix="/me", tags=["users"])

USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._@-]{0,63}$")

Role = Literal["admin", "user"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
NewPassword = Annotated[str, Field(min_length=MIN_LENGTH, max_length=MAX_LENGTH)]


class ApiModel(PydanticModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class UserOut(ApiModel):
    id: str
    name: str
    email: str | None
    role: str
    disabled: bool
    #: A local (password) account: it has a password hash an admin can reset.
    local: bool
    #: Sign-in methods linked to the account: `password`, `oidc`, `header`.
    methods: list[str]
    created_at: datetime
    last_seen_at: datetime | None


class UserCreate(ApiModel):
    username: str
    name: Name
    password: NewPassword
    role: Role = "user"


class UserPatch(ApiModel):
    name: Name | None = None
    role: Role | None = None
    disabled: bool | None = None


class PasswordSet(ApiModel):
    new: NewPassword


class MePatch(ApiModel):
    name: Name


class MePassword(ApiModel):
    current: Annotated[str, Field(max_length=MAX_LENGTH)]
    new: NewPassword


class MeOut(ApiModel):
    id: str
    name: str
    email: str | None
    role: str
    method: str
    local: bool
    can_manage_users: bool


def _methods(session: Session, user_id: str) -> list[str]:
    keys = session.scalars(select(m.UserIdentity.key).where(m.UserIdentity.user_id == user_id))
    return sorted({k.split(":", 1)[0] for k in keys})


def _out(session: Session, row: m.User) -> UserOut:
    return UserOut(
        id=row.id,
        name=row.name,
        email=row.email,
        role=row.role,
        disabled=row.disabled,
        local=row.password_hash is not None,
        methods=_methods(session, row.id),
        created_at=row.created_at,
        last_seen_at=row.last_seen_at,
    )


def _user(session: Session, user_id: str) -> m.User:
    row = session.get(m.User, user_id)
    if row is None:
        raise HTTPException(404, "user not found")
    return row


def _would_leave_no_admin(session: Session, row: m.User) -> bool:
    """Whether taking `row` out of the enabled admins leaves none."""
    return row.role == ROLE_ADMIN and not row.disabled and Accounts.enabled_admins(session) <= 1


# ------------------------------------------------------------------- admin


@router.get("", response_model=list[UserOut])
def list_users(_: AdminDep, session: OwnedSessionDep) -> list[UserOut]:
    rows = session.scalars(select(m.User).order_by(m.User.created_at, m.User.id))
    return [_out(session, r) for r in rows]


@router.post("", response_model=UserOut, status_code=201)
def create_user(
    _: AdminDep,
    session: OwnedSessionDep,
    accounts: AccountsDep,
    settings: SettingsDep,
    body: UserCreate,
) -> UserOut:
    if "password" not in settings.auth_methods:
        raise HTTPException(400, "local accounts need the password method (AUTH_PASSWORD)")
    username = normalize_username(body.username)
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(422, "username must be 1-64 characters of a-z, 0-9, '.', '_', '@', '-'")
    if username == BOOTSTRAP_USERNAME:
        raise HTTPException(422, f"username {BOOTSTRAP_USERNAME!r} is reserved")
    try:
        hashed = hash_password(body.password)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    with accounts.write_lock:
        row = m.User(
            id=uuid4().hex,
            name=body.name,
            email=None,
            role=body.role,
            disabled=False,
            password_hash=hashed,
            password_changed_at=now(),
            created_at=now(),
        )
        session.add(row)
        session.add(m.UserIdentity(key=password_key(username), user_id=row.id, created_at=now()))
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            raise HTTPException(409, "username already exists") from None
        finally:
            accounts.invalidate()
        log.info("admin created local account %s (%s)", row.id, row.role)
        return _out(session, row)


@router.patch("/{user_id}", response_model=UserOut)
def patch_user(
    who: AdminDep,
    session: OwnedSessionDep,
    accounts: AccountsDep,
    hub: HubDep,
    user_id: str,
    body: UserPatch,
) -> UserOut:
    with accounts.write_lock:
        row = _user(session, user_id)
        demoting = body.role is not None and body.role != ROLE_ADMIN and row.role == ROLE_ADMIN
        disabling = body.disabled is True and not row.disabled
        if (demoting or disabling) and row.id == who.id:
            raise HTTPException(409, "you cannot demote or disable yourself")
        if (demoting or disabling) and _would_leave_no_admin(session, row):
            raise HTTPException(409, "cannot demote or disable the last enabled admin")
        role_changed = body.role is not None and body.role != row.role
        if body.name is not None:
            row.name = body.name
        if body.role is not None:
            row.role = body.role
        if body.disabled is not None:
            row.disabled = body.disabled
        try:
            session.commit()
        finally:
            accounts.invalidate()
        if disabling or role_changed:
            hub.kick_threadsafe(row.id)  # sockets reconnect with the new role (or are refused)
        return _out(session, row)


@router.put("/{user_id}/password", status_code=204)
def reset_password(
    _: AdminDep,
    session: OwnedSessionDep,
    accounts: AccountsDep,
    hub: HubDep,
    user_id: str,
    body: PasswordSet,
) -> Response:
    with accounts.write_lock:
        row = _user(session, user_id)
        if row.password_hash is None:
            raise HTTPException(400, "not a local account")
        row.password_hash = hash_password(body.new)
        row.password_changed_at = now()
        try:
            session.commit()
        finally:
            accounts.invalidate()
    hub.kick_threadsafe(user_id)  # the old sessions are void: close their open sockets too
    return Response(status_code=204)


@router.delete("/{user_id}", status_code=204)
def delete_user(
    who: AdminDep,
    session: OwnedSessionDep,
    accounts: AccountsDep,
    hub: HubDep,
    user_id: str,
) -> Response:
    """Deletes the account and, through the foreign keys, all of its data."""
    with accounts.write_lock:
        row = _user(session, user_id)
        if row.id == who.id:
            raise HTTPException(409, "you cannot delete yourself")
        if row.id == accounts.owner_id():
            raise HTTPException(409, "the owner account cannot be deleted")
        if _would_leave_no_admin(session, row):
            raise HTTPException(409, "cannot delete the last enabled admin")
        session.delete(row)
        try:
            session.commit()
        finally:
            accounts.invalidate()
    hub.kick_threadsafe(user_id)
    log.info("admin deleted user %s", user_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------- me


def _me(who: CurrentUser, local: bool) -> MeOut:
    return MeOut(
        id=who.id,
        name=who.name,
        email=who.email,
        role=who.role,
        method=who.method,
        local=local,
        can_manage_users=who.is_admin,
    )


@me_router.get("", response_model=MeOut)
def get_me(who: UserDep, accounts: AccountsDep) -> MeOut:
    record = accounts.get(who.id)
    return _me(who, record is not None and record.password_hash is not None)


@me_router.patch("", response_model=MeOut)
def patch_me(who: UserDep, session: OwnedSessionDep, accounts: AccountsDep, body: MePatch) -> MeOut:
    with accounts.write_lock:
        row = _user(session, who.id)
        row.name = body.name
        try:
            session.commit()
        finally:
            accounts.invalidate()
        return _me(
            CurrentUser(row.id, row.name, row.email, row.role, who.method),
            row.password_hash is not None,
        )


@me_router.put("/password")
def change_my_password(
    who: UserDep,
    session: OwnedSessionDep,
    accounts: AccountsDep,
    hub: HubDep,
    request: Request,
    body: MePassword,
) -> Response:
    """Local accounts only. Changing the password signs every session of the account out
    (their tag derives from the hash); this response carries a fresh one for the caller."""
    auth = getattr(request.app.state, "authenticator", None)
    username = _local_username(session, who.id)
    if auth is None or username is None:
        raise HTTPException(400, "only local accounts have a password to change")
    # Keyed by the signed-in user's id: only that user's own wrong guesses count, so no one
    # can lock another user out through this route.
    limiter: LoginLimiter = request.app.state.user_limiter
    lock = limiter.lockout_remaining(who.id)
    if lock > 0:
        raise HTTPException(
            429,
            "too many failed attempts; try again later",
            headers={"Retry-After": str(int(lock) + 1)},
        )
    with accounts.write_lock:
        row = _user(session, who.id)
        if not verify_password(row.password_hash, body.current):
            lock = limiter.record_failure(who.id)
            raise HTTPException(401, "wrong password" if lock <= 0 else "too many failed attempts")
        limiter.record_success(who.id)
        try:
            check_strength(body.new)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        row.password_hash = hash_password(body.new)
        row.password_changed_at = now()
        try:
            session.commit()
        finally:
            accounts.invalidate()
        record = accounts.get(row.id)
    assert record is not None
    hub.kick_threadsafe(who.id)  # every other session is void: close their sockets (they reconnect)
    response = Response(status_code=204)
    set_password_session(response, auth, request, record, username)
    return response


def _local_username(session: Session, user_id: str) -> str | None:
    """The username of a local account (its `password:<name>` identity, never the bootstrap)."""
    keys = session.scalars(
        select(m.UserIdentity.key).where(
            m.UserIdentity.user_id == user_id, m.UserIdentity.key.like("password:%")
        )
    )
    for key in keys:
        name = key.split(":", 1)[1]
        if name != BOOTSTRAP_USERNAME:
            return name
    return None


__all__ = ["me_router", "router"]
