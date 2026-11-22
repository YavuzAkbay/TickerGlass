"""Users and identities (docs/design/multi-user.md): the request principal, the identity ->
user mapping (auto-provisioning, owner claim, admin promotion) and a small in-process cache.

`Accounts` lives on `app.state.accounts`. Its reads are cached for `CACHE_TTL_S` seconds and the
cache is cleared by any users write, so a disabled or deleted user is cut off within seconds
(immediately in this process). Sessions are stateless; the user row is the authority.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
import unicodedata
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, ClassVar
from uuid import uuid4

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker

from . import models as m
from .ownership import system_session

if TYPE_CHECKING:
    from collections.abc import Iterator

    from .auth import Identity
    from .settings import Settings

log = logging.getLogger("tickerglass.auth")

CACHE_TTL_S = 10.0
#: Rewrite `users.last_seen_at` at most this often per user.
SEEN_EVERY_S = 300.0

ROLE_ADMIN = "admin"
ROLE_USER = "user"
ROLE_SYSTEM = "system"
ROLES = (ROLE_ADMIN, ROLE_USER)

#: `AUTH_PASSWORD` signs in as this username; no local account may use it.
BOOTSTRAP_USERNAME = "admin"
OWNER_META_KEY = "owner_user_id"
MAX_KEY_LEN = 300


@dataclass(frozen=True)
class CurrentUser:
    """Who a request acts as. `SYSTEM` is the alerts service (its token): no user id."""

    id: str
    name: str
    email: str | None
    role: str
    method: str

    SYSTEM: ClassVar[CurrentUser]

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    @property
    def is_system(self) -> bool:
        return self.role == ROLE_SYSTEM


CurrentUser.SYSTEM = CurrentUser("", "Alerts service", None, ROLE_SYSTEM, "token")


@dataclass(frozen=True)
class UserRecord:
    """A users row as the request path needs it (immutable cache entry)."""

    id: str
    name: str
    email: str | None
    role: str
    disabled: bool
    password_hash: str | None


def _record(row: m.User) -> UserRecord:
    return UserRecord(row.id, row.name, row.email, row.role, row.disabled, row.password_hash)


def fold_name(value: str, *, strict: bool = False) -> str | None:
    """The comparison form of a user name or email: NFKC, stripped, casefolded. `strict` (for
    what a client or proxy sends) returns None unless the value already is in NFKC form and
    printable, so look-alikes (U+212A KELVIN SIGN + "ate" for "kate", full-width letters) never
    collide with another name; the lenient form is for what the operator configured. Empty
    values give None."""
    text = value.strip()
    if not text:
        return None
    normalized = unicodedata.normalize("NFKC", text)
    if strict and (normalized != text or not text.isprintable()):
        return None
    return normalized.casefold()


def norm_names(values: Iterable[str | None], *, strict: bool = False) -> set[str]:
    out: set[str] = set()
    for value in values:
        folded = fold_name(value, strict=strict) if value else None
        if folded is not None:
            out.add(folded)
    return out


def matches_admin(settings: Settings, names: Iterable[str | None], groups: Iterable[str]) -> bool:
    """`AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS`: users compare case-insensitively against
    `names`, groups exactly; either list matching is enough."""
    if settings.auth_admin_users and norm_names(settings.auth_admin_users) & norm_names(
        names, strict=True
    ):
        return True
    wanted = {g.strip() for g in settings.auth_admin_groups if g.strip()}
    return bool(wanted and wanted & {g.strip() for g in groups})


def now() -> datetime:
    return datetime.now(UTC)


def normalize_username(raw: str) -> str:
    return raw.strip().lower()


def identity_key(settings: Settings, identity: Identity) -> str | None:
    """`oidc:<sha256(issuer)[:12]>:<sub>`, `header:<name>`, `password:<name>`; None when the
    method has no stable key (or the key would not fit the column)."""
    method, sub = identity.method, identity.sub
    if not sub:
        return None
    if method == "oidc":
        issuer = (settings.oidc_issuer or "").rstrip("/")
        key = f"oidc:{hashlib.sha256(issuer.encode()).hexdigest()[:12]}:{sub}"
    elif method == "header":
        folded = fold_name(sub, strict=True)
        if folded is None:
            return None
        key = f"header:{folded}"
    elif method == "password":
        key = f"password:{sub.strip().lower()}"
    else:
        return None
    return key if len(key) <= MAX_KEY_LEN else None


def password_key(username: str) -> str:
    return f"password:{normalize_username(username)}"


class Accounts:
    def __init__(
        self,
        maker: sessionmaker[Session],
        settings: Settings,
        *,
        ttl_s: float = CACHE_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._maker = maker
        self._settings = settings
        self._ttl_s = ttl_s
        self._clock = clock
        self._cache_lock = threading.Lock()
        #: Serializes provisioning and every users write (last-admin checks, owner claim).
        self.write_lock = threading.RLock()
        self._users: dict[str, tuple[float, UserRecord | None]] = {}
        self._idents: dict[str, tuple[float, str | None]] = {}
        self._seen: dict[str, float] = {}
        self._owner_id: str | None = None

    # -- cache -----------------------------------------------------------------

    def invalidate(self) -> None:
        """Drop every cached user / identity (call after any users write)."""
        with self._cache_lock:
            self._users.clear()
            self._idents.clear()

    @contextmanager
    def writing(self) -> Iterator[Session]:
        """A system session in one transaction under the write lock; the cache is cleared
        afterwards, whether or not the block raised."""
        with self.write_lock:
            try:
                with system_session(self._maker) as session, session.begin():
                    yield session
            finally:
                self.invalidate()

    # -- lookups ---------------------------------------------------------------

    def owner_id(self) -> str:
        """The owner user's id (`app_meta['owner_user_id']`, set by the migration)."""
        if self._owner_id is None:
            with self._maker() as session:
                row = session.get(m.AppMeta, OWNER_META_KEY)
            value = row.value if row is not None else None
            if not isinstance(value, str) or not value:
                raise RuntimeError("app_meta has no owner_user_id: run the database migrations")
            self._owner_id = value
        return self._owner_id

    def get(self, user_id: str) -> UserRecord | None:
        """The user (cached); None when it does not exist."""
        now_s = self._clock()
        with self._cache_lock:
            hit = self._users.get(user_id)
        if hit is not None and hit[0] > now_s:
            return hit[1]
        with self._maker() as session:
            row = session.get(m.User, user_id)
            record = _record(row) if row is not None else None
        with self._cache_lock:
            self._users[user_id] = (now_s + self._ttl_s, record)
        if record is not None:
            self._touch(user_id, now_s)
        return record

    def _touch(self, user_id: str, now_s: float) -> None:
        if now_s - self._seen.get(user_id, -SEEN_EVERY_S) < SEEN_EVERY_S:
            return
        self._seen[user_id] = now_s
        try:
            with self._maker() as session, session.begin():
                row = session.get(m.User, user_id)
                if row is not None:
                    row.last_seen_at = now()
        except SQLAlchemyError:
            log.debug("could not update last_seen_at", exc_info=True)

    def by_identity(self, key: str) -> UserRecord | None:
        with self._maker() as session:
            link = session.get(m.UserIdentity, key)
            user = session.get(m.User, link.user_id) if link is not None else None
            return _record(user) if user is not None else None

    # -- startup ---------------------------------------------------------------

    def startup(self) -> None:
        """Verify the owner user exists; with the password method on, link the bootstrap
        identity `password:admin` to it."""
        owner = self.owner_id()
        with self.writing() as session:
            if session.get(m.User, owner) is None:
                raise RuntimeError("the owner user is missing: restore it or the database")
            if "password" in self._settings.auth_methods:
                key = f"password:{BOOTSTRAP_USERNAME}"
                link = session.get(m.UserIdentity, key)
                if link is None:
                    session.add(m.UserIdentity(key=key, user_id=owner, created_at=now()))
                elif link.user_id != owner:
                    raise RuntimeError(f"identity {key} belongs to another user than the owner")

    # -- identities ------------------------------------------------------------

    def is_admin_identity(self, names: Iterable[str | None], groups: Iterable[str]) -> bool:
        """`AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS`, same matching rules as the allow-lists
        (users case-insensitively against `names`, groups exactly). Either list matching is
        enough."""
        return matches_admin(self._settings, names, groups)

    def resolve(
        self,
        identity: Identity,
        *,
        names: Iterable[str | None] = (),
        groups: Iterable[str] = (),
        fresh: bool = False,
    ) -> UserRecord | None:
        """The user an OIDC / header identity signs in as: linked, claimed (the owner) or
        provisioned. None = denied (unknown and auto-provisioning is off, or no usable key).
        `names` / `groups` are what `AUTH_ADMIN_*` is matched against (the caller decides which
        names count: an unverified email must not). `fresh` skips the 10 s identity cache
        (sign-in callbacks)."""
        key = identity_key(self._settings, identity)
        if key is None:
            return None
        now_s = self._clock()
        if not fresh:
            with self._cache_lock:
                hit = self._idents.get(key)
            if hit is not None and hit[0] > now_s:
                return self.get(hit[1]) if hit[1] is not None else None
        name_list = [n for n in names if n]
        with self.write_lock:
            uid = self._link(key, identity, name_list, tuple(groups))
        with self._cache_lock:
            self._idents[key] = (now_s + self._ttl_s, uid)
        return self.get(uid) if uid is not None else None

    def _link(
        self, key: str, identity: Identity, names: list[str], groups: tuple[str, ...]
    ) -> str | None:
        admin = self.is_admin_identity(names, groups)
        for attempt in (0, 1):
            try:
                with system_session(self._maker) as session, session.begin():
                    uid, changed = self._link_in(session, key, identity, admin)
                if changed:
                    self.invalidate()
                return uid
            except IntegrityError:
                # A concurrent sign-in (another process) created it first: look again.
                if attempt:
                    raise
        raise AssertionError("unreachable")  # pragma: no cover

    def _link_in(
        self, session: Session, key: str, identity: Identity, admin: bool
    ) -> tuple[str | None, bool]:
        link = session.get(m.UserIdentity, key)
        if link is not None:
            user = session.get(m.User, link.user_id)
            if user is None:  # cannot happen (cascade), but never sign into nothing
                return None, False
            if admin and user.role != ROLE_ADMIN and not user.disabled:
                user.role = ROLE_ADMIN
                log.warning("promoted %s to admin (AUTH_ADMIN_USERS/GROUPS)", user.id)
                return user.id, True
            return user.id, False
        settings = self._settings
        if identity.method in ("oidc", "header"):
            owner = self.owner_id()
            if self._may_claim(session, owner, admin):
                session.add(m.UserIdentity(key=key, user_id=owner, created_at=now()))
                claimed = session.get(m.User, owner)
                if claimed is not None and claimed.name == "Owner" and claimed.email is None:
                    # The migration's placeholder name: show who actually signed in.
                    claimed.name = (identity.name or identity.sub)[:200]
                    claimed.email = identity.email[:254] if identity.email else None
                log.warning(
                    "%s identity linked to the owner account %s (first sign-in of a "
                    "single-user install)",
                    identity.method,
                    owner,
                )
                return owner, True
        if not settings.auth_auto_provision:
            log.warning(
                "sign-in denied: unknown %s identity and AUTH_AUTO_PROVISION=false", identity.method
            )
            return None, False
        user = m.User(
            id=uuid4().hex,
            name=(identity.name or identity.sub)[:200],
            email=identity.email[:254] if identity.email else None,
            role=ROLE_ADMIN if admin else ROLE_USER,
            disabled=False,
            created_at=now(),
        )
        session.add(user)
        session.flush()
        session.add(m.UserIdentity(key=key, user_id=user.id, created_at=now()))
        log.info("provisioned %s account %s via %s", user.role, user.id, identity.method)
        return user.id, True

    def _may_claim(self, session: Session, owner: str, admin: bool) -> bool:
        """The owner account is claimed by the first OIDC / header identity when the owner has
        none yet and the identity is an admin (`AUTH_ADMIN_*` set), or nothing says who is
        an admin and the password method (which owns the account) is off, and provisioning
        is on (fail closed: a deny-unknown install claims only by an explicit admin list)."""
        taken = session.scalar(
            select(func.count())
            .select_from(m.UserIdentity)
            .where(
                m.UserIdentity.user_id == owner,
                or_(m.UserIdentity.key.like("oidc:%"), m.UserIdentity.key.like("header:%")),
            )
        )
        if taken:
            return False
        s = self._settings
        if s.auth_admin_users or s.auth_admin_groups:
            return admin
        return "password" not in s.auth_methods and s.auth_auto_provision

    # -- counts ------------------------------------------------------------------

    @staticmethod
    def enabled_admins(session: Session) -> int:
        return (
            session.scalar(
                select(func.count())
                .select_from(m.User)
                .where(m.User.role == ROLE_ADMIN, m.User.disabled.is_(False))
            )
            or 0
        )
