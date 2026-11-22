"""Optional authentication (docs/self-hosting.md, docs/design/oidc-sso.md).

Any configured method enables it: `AUTH_PASSWORD`, OIDC single sign-on, or a trusted proxy
header. A signed HttpOnly session cookie (password / OIDC) or the proxy's identity header
guards every API route and the `/ws` relay except `/api/health`, `/api/auth/*`, and requests
that carry the alerts service's `X-Alerts-Token` (reads anywhere, plus its write routes).
Nothing configured (the default) keeps the app open, as before. Sessions survive restarts
via a random secret persisted next to a SQLite database, or `AUTH_SECRET` for Postgres.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import re
import secrets
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, cast

from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .accounts import (
    BOOTSTRAP_USERNAME,
    Accounts,
    CurrentUser,
    fold_name,
    matches_admin,
    norm_names,
)
from .db import sqlite_path

if TYPE_CHECKING:
    from .settings import Settings

COOKIE_NAME = "tickerglass_session"
LOCKOUT_S = 60.0
MAX_FAILURES = 5
#: Wrong current passwords per signed-in user before `PUT /me/password` locks for that user.
#: Keyed by user id of an authenticated session, so nobody else can burn it. Sign-in is not
#: locked per username at all (anyone could lock any name from anywhere): see `pair_key`.
USERNAME_MAX_FAILURES = 10

# The browser needs these to decide between the login screen and the app; health
# stays open for the compose healthcheck. Logout is public by design (clears a cookie).
# `/metrics` checks its own bearer token (routes/metrics.py); it is a 404 unless enabled.
PUBLIC_PATHS = ("/api/health", "/api/health/live", "/api/health/ready", "/metrics")
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


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _mac(secret: str, message: str) -> bytes:
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).digest()


def _seal(secret: str, purpose: str, version: str, data: dict[str, Any]) -> str:
    """`<version>.<b64url(json)>.<b64url(hmac)>`; the MAC covers the purpose, so a
    session cookie can never pass for an OIDC flow cookie or the other way round."""
    body = _b64(json.dumps(data, separators=(",", ":")).encode())
    return f"{version}.{body}.{_b64(_mac(secret, f'{purpose}.{version}.{body}'))}"


def _unseal(token: str | None, secret: str, purpose: str, version: str) -> dict[str, Any] | None:
    if not token or len(token) > 4096:
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != version:
        return None
    _, body, sig = parts
    # MAC first: nothing attacker-controlled reaches the JSON parser unless we signed it.
    try:
        given = _unb64(sig)
        expected = _mac(secret, f"{purpose}.{version}.{body}")
    except (ValueError, binascii.Error):
        return None
    if not hmac.compare_digest(given, expected):
        return None
    try:
        data = json.loads(_unb64(body))
    except Exception:  # noqa: BLE001 - incl. RecursionError: any unreadable body is no session
        return None
    return data if isinstance(data, dict) else None


def password_tag(secret: str, password: str) -> str:
    """Binds a password session to the password it was created with: changing
    `AUTH_PASSWORD` signs every existing session out at once. A keyed MAC, so the
    cookie holds nothing an attacker can brute-force offline."""
    return _b64(_mac(secret, "pw:" + password))[:16]


def oidc_tag(
    secret: str,
    issuer: str,
    client_id: str,
    allowed_users: Iterable[str] = (),
    allowed_groups: Iterable[str] = (),
    admin_users: Iterable[str] = (),
    admin_groups: Iterable[str] = (),
    allow_any: bool = False,
) -> str:
    """Same for OIDC sessions and the issuer / client they were issued for, plus the
    allow-lists in force: changing `AUTH_ALLOWED_USERS` / `AUTH_ALLOWED_GROUPS` /
    `AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS` / `AUTH_ALLOW_ANY_USER` ends them."""

    def groups(values: Iterable[str]) -> list[str]:
        return sorted({g.strip() for g in values if g.strip()})

    lists = json.dumps(
        [
            sorted(_norm(allowed_users)),
            groups(allowed_groups),
            sorted(_norm(admin_users)),
            groups(admin_groups),
            allow_any,
        ],
        separators=(",", ":"),
    )
    allow = hashlib.sha256(lists.encode()).hexdigest()
    return _b64(_mac(secret, f"oidc:{issuer.rstrip('/')}|{client_id}|{allow}"))[:16]


def local_tag(secret: str, uid: str, password_hash: str) -> str:
    """Binds a local-account session to the account's current password hash: changing or
    resetting the password signs that user out everywhere. A keyed MAC of the hash."""
    return _b64(_mac(secret, f"lp:{uid}:{password_hash}"))[:16]


@dataclass(frozen=True)
class Identity:
    sub: str
    name: str
    email: str | None
    groups: tuple[str, ...]
    method: str  # "password" | "oidc" | "header"
    #: The users row a cookie session belongs to (None for header identities: resolved per request).
    uid: str | None = None


def make_session(
    secret: str,
    *,
    sub: str,
    name: str,
    email: str | None,
    method: str,
    ttl_s: int,
    tag: str | None = None,
    uid: str | None = None,
    now: float | None = None,
) -> str:
    """Stateless v2 session cookie. `tag` is `password_tag` / `local_tag` / `oidc_tag` for the
    method; `uid` the users row the session belongs to."""
    iat = int(now if now is not None else time.time())
    data: dict[str, Any] = {
        "sub": sub,
        "name": name[:200],
        "email": email[:254] if email else None,
        "m": method,
        "iat": iat,
        "exp": iat + ttl_s,
    }
    if tag is not None:
        data["tag"] = tag
    if uid is not None:
        data["uid"] = uid
    return _seal(secret, "session", "v2", data)


def read_session(
    token: str | None,
    secret: str,
    *,
    pw_tag: str | None = None,
    oc_tag: str | None = None,
    user_tag: Callable[[str], str | None] | None = None,
    now: float | None = None,
) -> Identity | None:
    """The identity in a valid v2 cookie, else None (v1 cookies, bad signature, expired,
    unknown or disabled method, or a changed password / issuer / client all fail).
    `pw_tag` / `oc_tag` are the current tags, None while that method is off. `user_tag(uid)`
    is the current tag of a local account (None: unknown user or no local password); it
    applies to password sessions that are not the bootstrap `admin`."""
    data = _unseal(token, secret, "session", "v2")
    if data is None:
        return None
    sub, name, email = data.get("sub"), data.get("name"), data.get("email")
    method, exp, tag = data.get("m"), data.get("exp"), data.get("tag")
    if not isinstance(sub, str) or not sub or not isinstance(name, str):
        return None
    if email is not None and not isinstance(email, str):
        return None
    if isinstance(exp, bool) or not isinstance(exp, int | float):
        return None
    if not (now if now is not None else time.time()) < exp:
        return None
    uid = data.get("uid")
    if uid is not None and (not isinstance(uid, str) or not uid):
        return None
    expected = {"password": pw_tag, "oidc": oc_tag}.get(method) if isinstance(method, str) else None
    if method == "password" and user_tag is not None and sub != BOOTSTRAP_USERNAME:
        expected = user_tag(uid) if uid is not None else None
    if expected is None or not isinstance(tag, str) or not hmac.compare_digest(tag, expected):
        return None
    return Identity(sub, name, email, (), cast("str", method), uid)


def make_oidc_flow(secret: str, data: dict[str, Any]) -> str:
    return _seal(secret, "oidc-flow", "o1", data)


def read_oidc_flow(
    token: str | None, secret: str, now: float | None = None
) -> dict[str, Any] | None:
    data = _unseal(token, secret, "oidc-flow", "o1")
    exp = data.get("exp") if data else None
    if isinstance(exp, bool) or not isinstance(exp, int | float):
        return None
    if not (now if now is not None else time.time()) < exp:
        return None
    return data


# -------------------------------------------------------------- proxies, client IP

IPAddr = ipaddress.IPv4Address | ipaddress.IPv6Address
Networks = tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]


def parse_networks(items: list[str]) -> Networks:
    return tuple(ipaddress.ip_network(item, strict=False) for item in items)


def _parse_ip(text: str) -> IPAddr | None:
    text = text.strip().strip("[]")
    try:
        addr = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


def _in(hop: str, networks: Networks) -> bool:
    addr = _parse_ip(hop)
    return addr is not None and any(addr in net for net in networks if net.version == addr.version)


def client_chain(scope: Scope) -> list[str]:
    """`X-Forwarded-For` entries, left (client) to right, then the TCP peer."""
    entries: list[str] = []
    for key, value in cast("list[tuple[bytes, bytes]]", scope.get("headers", [])):
        if key == b"x-forwarded-for":
            entries.extend(p.strip() for p in value.decode("latin-1").split(",") if p.strip())
    client = scope.get("client")
    peer = str(client[0]) if client else "unknown"
    return [*entries, peer]


def client_ip(scope: Scope, trusted: Networks) -> str:
    """The real client: walk from the right past trusted forwarders. A peer that is not
    itself trusted could have forged `X-Forwarded-For`, so then only the peer counts."""
    chain = client_chain(scope)
    for hop in reversed(chain):
        if not _in(hop, trusted):
            return hop
    return chain[0]


def forwarded_proto_https(scope: Scope, trusted: Networks) -> bool:
    """`X-Forwarded-Proto: https`, honoured only when the peer is a trusted forwarder."""
    if scope.get("scheme") in ("https", "wss"):
        return True
    chain = client_chain(scope)
    if not _in(chain[-1], trusted):
        return False
    value = _header(scope, b"x-forwarded-proto")
    return value is not None and value.split(",")[-1].strip().lower() == "https"


def via_header_proxy(scope: Scope, trusted: Networks, header_proxies: Networks) -> bool:
    """Whether the request came through the authenticating proxy: walk from the right;
    a header-proxy hop accepts, a trusted forwarder hop continues, anything else (an
    unknown host, or someone who reached a forwarder directly) rejects."""
    for hop in reversed(client_chain(scope)):
        if _in(hop, header_proxies):
            return True
        if not _in(hop, trusted):
            return False
    return False


# ---------------------------------------------------------------- allow-lists


def _norm(values: Iterable[str]) -> set[str]:
    """Configured list entries: NFKC + casefold (lenient: the operator typed them)."""
    return norm_names(values)


def is_allowed(
    settings: Settings,
    *,
    names: Iterable[str | None],
    groups: Iterable[str],
    admin_names: Iterable[str | None] | None = None,
) -> bool:
    """Who may sign in with OIDC / a trusted header. Allowed: everyone with
    `AUTH_ALLOW_ANY_USER`; else a match on `AUTH_ALLOWED_USERS` / `AUTH_ALLOWED_GROUPS`
    (each non-empty list must match); or an admin (`AUTH_ADMIN_USERS` / `AUTH_ADMIN_GROUPS`
    are implicitly allowed). With no list and no flag nobody is. `names` are the identifiers
    to try (sub, username, verified email); users compare case-insensitively, groups
    exactly. `admin_names` (default `names`) is the narrower set admin matching may use."""
    if settings.auth_allow_any_user:
        return True
    group_set = {g.strip() for g in groups}
    if matches_admin(settings, names if admin_names is None else admin_names, group_set):
        return True
    if not (settings.auth_allowed_users or settings.auth_allowed_groups):
        return False
    if settings.auth_allowed_users:
        wanted = _norm(settings.auth_allowed_users)
        if not wanted & norm_names((n for n in names if n), strict=True):
            return False
    if settings.auth_allowed_groups:
        wanted_groups = {g.strip() for g in settings.auth_allowed_groups}
        if not wanted_groups & group_set:
            return False
    return True


# --------------------------------------------------------------- authenticator


class Authenticator:
    """Resolves a request (http or websocket scope) to an `Identity`: the trusted proxy
    header first (it is authoritative for requests through the proxy), then the session
    cookie."""

    def __init__(self, settings: Settings, secret: str) -> None:
        self.settings = settings
        self.secret = secret
        #: Set by the app lifespan once the database is up (needs the users table).
        self.accounts: Accounts | None = None
        self.methods = settings.auth_methods
        self.trusted = parse_networks(settings.trusted_proxies)
        self.header_proxies = parse_networks(settings.auth_header_proxies)
        self.session_ttl_s = settings.auth_session_days * 86400
        self.pw_tag = (
            password_tag(secret, settings.auth_password) if settings.auth_password else None
        )
        self.oc_tag = (
            oidc_tag(
                secret,
                settings.oidc_issuer,
                settings.oidc_client_id,
                settings.auth_allowed_users,
                settings.auth_allowed_groups,
                settings.auth_admin_users,
                settings.auth_admin_groups,
                settings.auth_allow_any_user,
            )
            if settings.oidc_issuer and settings.oidc_client_id
            else None
        )

    def session_cookie(
        self,
        *,
        sub: str,
        name: str,
        email: str | None,
        method: str,
        uid: str,
        password_hash: str | None = None,
        now: float | None = None,
    ) -> str:
        """A session for user `uid`. A password session is the bootstrap `AUTH_PASSWORD`
        (`sub` "admin") or a local account (tag derived from its `password_hash`)."""
        tag: str | None
        if method == "password":
            if sub == BOOTSTRAP_USERNAME:
                tag = self.pw_tag
            else:
                if password_hash is None:
                    raise ValueError("a local-account session needs the password hash")
                tag = local_tag(self.secret, uid, password_hash)
        else:
            tag = self.oc_tag
        return make_session(
            self.secret,
            sub=sub,
            name=name,
            email=email,
            method=method,
            ttl_s=self.session_ttl_s,
            tag=tag,
            uid=uid,
            now=now,
        )

    def _user_tag(self, uid: str) -> str | None:
        record = self.accounts.get(uid) if self.accounts is not None else None
        if record is None or not record.password_hash:
            return None
        return local_tag(self.secret, uid, record.password_hash)

    def client_ip(self, scope: Scope) -> str:
        return client_ip(scope, self.trusted)

    def secure(self, scope: Scope) -> bool:
        """Cookie `Secure`: `PUBLIC_URL`'s scheme wins, else the request's own scheme or a
        trusted forwarder's `X-Forwarded-Proto`."""
        if self.settings.public_url:
            return self.settings.public_url.lower().startswith("https://")
        return forwarded_proto_https(scope, self.trusted)

    def authenticate(self, scope: Scope) -> Identity | None:
        if "header" in self.methods:
            found = self._header_identity(scope)
            if found is not None:
                # The proxy vouched for this request: a refusal is final, no cookie fallback.
                return found if found.sub else None
        if "password" in self.methods or "oidc" in self.methods:
            return read_session(
                _cookie(scope, COOKIE_NAME),
                self.secret,
                pw_tag=self.pw_tag,
                oc_tag=self.oc_tag,
                user_tag=self._user_tag,
            )
        return None

    def user_for(self, scope: Scope) -> CurrentUser | None:
        """The signed-in user of a request: the identity (cookie or proxy header) mapped to its
        users row. None when there is no valid session, or the user is unknown (auto
        provisioning off) or disabled. Blocking (cache misses hit the database)."""
        identity = self.authenticate(scope)
        accounts = self.accounts
        if identity is None or accounts is None:
            return None
        if identity.method == "header":
            record = accounts.resolve(
                identity, names=(identity.sub, identity.email), groups=identity.groups
            )
        elif identity.uid is not None:
            record = accounts.get(identity.uid)
        else:
            return None  # a session without a user (issued before multi-user): sign in again
        if record is None or record.disabled:
            return None
        return CurrentUser(record.id, record.name, record.email, record.role, identity.method)

    def _header_identity(self, scope: Scope) -> Identity | None:
        """None: no trusted header on this request. An `Identity` with an empty `sub`: the
        proxy named a user who is refused (allow-lists, malformed header)."""
        settings = self.settings
        values = _header_values(scope, (settings.auth_trusted_header or "").lower().encode())
        if not values or not via_header_proxy(scope, self.trusted, self.header_proxies):
            return None
        refused = Identity("", "", None, (), "header")
        if len(values) != 1:
            return refused  # ambiguous: an honest proxy sends exactly one
        user = _text(values[0])
        # A name that is not already in NFKC form (a Kelvin sign for "K", full-width letters) or
        # has non-printable characters could collide with another user's: refuse it.
        if not user or len(user) > 255 or fold_name(user, strict=True) is None:
            return refused
        email = _single(scope, settings.auth_trusted_email_header)
        name = _single(scope, settings.auth_trusted_name_header) or user
        raw_groups = _single(scope, settings.auth_trusted_groups_header) or ""
        # Authelia separates groups with commas, Authentik with pipes.
        groups = tuple(g.strip() for g in re.split(r"[,|]", raw_groups) if g.strip())
        if not is_allowed(settings, names=(user, email), groups=groups):
            return refused
        return Identity(user, name[:200], email, groups, "header")


def _header_values(scope: Scope, name: bytes) -> list[str]:
    return [
        value.decode("latin-1")
        for key, value in cast("list[tuple[bytes, bytes]]", scope.get("headers", []))
        if key == name
    ]


def _text(raw: str) -> str:
    """Proxies send UTF-8; ASGI hands us latin-1 text."""
    try:
        return raw.encode("latin-1").decode("utf-8").strip()
    except (UnicodeEncodeError, UnicodeDecodeError):
        return raw.strip()


def _single(scope: Scope, name: str | None) -> str | None:
    if not name:
        return None
    values = _header_values(scope, name.lower().encode())
    return (_text(values[0]) or None) if len(values) == 1 else None


def pair_key(ip: str, username: str) -> str:
    """Sign-in failures are counted per (client, username): a name is never locked for other
    clients, so nobody can lock `admin` out from afar."""
    return f"{_limiter_key(ip)}|{username}"


def _limiter_key(ip: str) -> str:
    """IPv6 clients are keyed by their /64 (one subscriber holds the whole prefix, so
    rotating addresses inside it must not reset the counter)."""
    addr = _parse_ip(ip)
    if isinstance(addr, ipaddress.IPv6Address):
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr) if addr is not None else ip


class LoginLimiter:
    """Per-client failed-login counter: `MAX_FAILURES` misses within `LOCKOUT_S` lock the
    source out for `LOCKOUT_S`. In memory only (a restart clears it); no new dependencies.
    Entries are `(failures, expires_at)`; stale ones are pruned as the table grows."""

    PRUNE_ABOVE = 10_000

    def __init__(self, max_failures: int = MAX_FAILURES) -> None:
        self.max_failures = max_failures
        self._fails: dict[str, tuple[int, float]] = {}
        self._prune_above = self.PRUNE_ABOVE

    def _live(self, key: str, now: float) -> tuple[int, float]:
        fails, expires = self._fails.get(key, (0, 0.0))
        if fails and now >= expires:
            del self._fails[key]
            return 0, 0.0
        return fails, expires

    def _prune(self, now: float) -> None:
        """Amortized O(1): runs only when the table doubled since the last sweep."""
        if len(self._fails) <= self._prune_above:
            return
        self._fails = {k: v for k, v in self._fails.items() if now < v[1]}
        self._prune_above = max(self.PRUNE_ABOVE, 2 * len(self._fails))

    def lockout_remaining(self, ip: str) -> float:
        now = time.monotonic()
        fails, expires = self._live(_limiter_key(ip), now)
        return expires - now if fails >= self.max_failures else 0.0

    def record_failure(self, ip: str) -> float:
        """Count one failure; returns the new lockout duration (0 = not locked)."""
        key = _limiter_key(ip)
        now = time.monotonic()
        fails, _ = self._live(key, now)
        if fails >= self.max_failures:
            return LOCKOUT_S
        self._prune(now)
        self._fails[key] = (fails + 1, now + LOCKOUT_S)
        return LOCKOUT_S if fails + 1 >= self.max_failures else 0.0

    def record_success(self, ip: str) -> None:
        self._fails.pop(_limiter_key(ip), None)


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
    """Pure ASGI guard that also names the request's user: an authenticated identity (session
    cookie or trusted proxy header) or the alerts token passes, everything else gets a 401
    (http) or a pre-accept close (websocket). `scope["state"]["user"]` is the `CurrentUser`
    (`CurrentUser.SYSTEM` for the alerts token). Without an `authenticator` (no auth method
    configured: open mode) every request is the owner user, unless it carries the alerts token."""

    def __init__(
        self, app: ASGIApp, authenticator: Authenticator | None, internal_token: str | None
    ) -> None:
        self.app = app
        self.authenticator = authenticator
        self.internal_token = internal_token

    def _token_ok(self, scope: Scope, path: str, method: str) -> bool:
        """`X-Alerts-Token` covers the alerts service: reads anywhere (it lists
        alerts, states and drawings), plus its write routes. It cannot cover the
        user-data writes, so a leaked token does not unlock those. A WebSocket
        handshake takes the same header (the alerts service sends it there); the
        `auth_token` query parameter is still accepted for older services, but it
        ends up in access logs (`logredact.py` masks it)."""
        if not self.internal_token:
            return False
        if scope["type"] == "websocket":
            for token in (_header(scope, b"x-alerts-token"), _query(scope, "auth_token")):
                if token is not None and hmac.compare_digest(
                    token.encode(), self.internal_token.encode()
                ):
                    return True
            return False
        token = _header(scope, b"x-alerts-token")
        if token is None or not hmac.compare_digest(token, self.internal_token):
            return False
        return method == "GET" or _alerts_service_route(path, method)

    def _principal(self, scope: Scope, path: str, method: str) -> CurrentUser | None:
        """Blocking (a cache miss reads the users table): runs in a worker thread."""
        if self.authenticator is not None:
            user = self.authenticator.user_for(scope)
            if user is not None:
                return user
            return CurrentUser.SYSTEM if self._token_ok(scope, path, method) else None
        if self._token_ok(scope, path, method):
            return CurrentUser.SYSTEM
        app = scope.get("app")
        accounts: Accounts | None = getattr(getattr(app, "state", None), "accounts", None)
        if accounts is None:
            return None
        record = accounts.get(accounts.owner_id())
        if record is None or record.disabled:
            return None
        return CurrentUser(record.id, record.name, record.email, record.role, "open")

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
        user = await run_in_threadpool(self._principal, scope, path, method)
        if user is not None:
            scope.setdefault("state", {})["user"] = user
            await self.app(scope, receive, send)
            return
        if stype == "http":
            await JSONResponse({"detail": "unauthorized"}, status_code=401)(scope, receive, send)
        else:
            # Before the accept: uvicorn turns this into a failed handshake, which
            # the clients treat like any dropped socket (backoff and retry).
            await send({"type": "websocket.close", "code": 4401})
