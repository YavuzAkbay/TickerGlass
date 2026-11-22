"""OpenID Connect sign-in (authorization code + PKCE; docs/design/oidc-sso.md).

Discovery, JWKS and the code exchange use stdlib `urllib` through one function
(`http_request`) so tests can swap it; PyJWT verifies the id_token. The API boots fine
while the identity provider is down: discovery is lazy, fetched outside any lock by one
caller at a time, and a failure is remembered for `NEGATIVE_TTL_S` so an unreachable
provider cannot tie up the worker threads. Failures surface as an
`OidcError` carrying one of the fixed `auth_error` codes; details go to the log only (never
tokens or secrets).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlencode, urlsplit

import jwt
from jwt import PyJWK, PyJWKSet

if TYPE_CHECKING:
    from .settings import Settings

log = logging.getLogger("tickerglass.auth")

HTTP_TIMEOUT_S = 10
#: Discovery and JWKS run on unauthenticated requests: give up sooner than the token call.
METADATA_TIMEOUT_S = 5
#: How long a failed discovery / JWKS fetch is remembered (callers fail fast meanwhile).
NEGATIVE_TTL_S = 30
MAX_RESPONSE_BYTES = 1 << 20
DISCOVERY_TTL_S = 3600
JWKS_TTL_S = 3600
JWKS_REFETCH_MIN_S = 60
LEEWAY_S = 60
FLOW_TTL_S = 600
MAX_SUB_LEN = 255

#: Asymmetric algorithms only: never `none`, never HS* (the client secret would be the key).
ALLOWED_ALGS = (
    "RS256",
    "RS384",
    "RS512",
    "PS256",
    "PS384",
    "PS512",
    "ES256",
    "ES384",
    "ES512",
    "EdDSA",
)

# `?auth_error=` codes (the web app maps them to messages).
STATE = "oidc_state"
EXCHANGE = "oidc_exchange"
TOKEN = "oidc_token"
DENIED = "oidc_denied"
UNAVAILABLE = "oidc_unavailable"


class OidcError(Exception):
    """A failed sign-in; `code` goes to the browser, `detail` only to the log."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class FetchError(Exception):
    """`status` is the HTTP status when the server answered with an error, else None
    (network failure, timeout, oversized or refused response)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # a 3xx surfaces as an HTTPError instead of being followed


def http_request(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    allow_http: bool = False,
    timeout: float = HTTP_TIMEOUT_S,
) -> bytes:
    """GET (or POST with `data`) and return the body. Only https (http with `allow_http`),
    no redirects, 10 s timeout by default, 1 MiB cap."""
    scheme = urlsplit(url).scheme.lower()
    if scheme != "https" and not (scheme == "http" and allow_http):
        raise FetchError(f"refusing non-https URL scheme {scheme!r}")
    request = urllib.request.Request(url, data=data, headers=headers or {})  # noqa: S310
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            body: bytes = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise FetchError(f"HTTP {exc.code}", exc.code) from None
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise FetchError(f"{type(exc).__name__}: {exc}") from None
    if len(body) > MAX_RESPONSE_BYTES:
        raise FetchError("response too large")
    return body


def _json_object(raw: bytes, what: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except ValueError:
        raise FetchError(f"{what} is not JSON") from None
    if not isinstance(data, dict):
        raise FetchError(f"{what} is not a JSON object")
    return data


def safe_next(value: str | None) -> str:
    """A same-site path to return to after sign-in; anything else becomes `/`."""
    if not value or len(value) > 2048 or not value.startswith("/"):
        return "/"
    if value.startswith(("//", "/\\")) or "\\" in value:
        return "/"
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        return "/"
    parts = urlsplit(value)
    if parts.scheme or parts.netloc:
        return "/"
    return value


@dataclass(frozen=True)
class OidcUser:
    sub: str
    name: str
    email: str | None
    email_verified: bool
    username: str | None
    groups: tuple[str, ...]


@dataclass(frozen=True)
class Flow:
    """What the browser's `tickerglass_oidc` cookie carries between the two redirects."""

    state: str
    nonce: str
    verifier: str
    next: str


@dataclass
class _Cell:
    """One cached remote document plus its fetch bookkeeping (guarded by the client lock)."""

    value: Any = None
    at: float = 0.0
    failed_until: float = 0.0
    failure: str = ""
    inflight: bool = False


def _compatible(key: PyJWK, alg: str) -> bool:
    """Whether a token signed with `alg` may be checked against this JWK: the key type (and
    curve) must fit the algorithm, and a JWK that names its `alg` must name this one."""
    data = key._jwk_data  # noqa: SLF001 - PyJWT exposes kty / kid / use, not alg / crv
    named = data.get("alg")
    if named is not None and named != alg:
        return False
    kty, crv = key.key_type, data.get("crv")
    if kty == "RSA":
        return alg.startswith(("RS", "PS"))
    if kty == "EC":
        return {"ES256": "P-256", "ES384": "P-384", "ES512": "P-521"}.get(alg) == crv
    if kty == "OKP":
        return alg == "EdDSA"
    return False


class OidcClient:
    def __init__(self, settings: Settings, clock: Callable[[], float] = time.monotonic) -> None:
        if not (settings.oidc_issuer and settings.oidc_client_id and settings.public_url):
            raise ValueError("OIDC is not configured")
        self.settings = settings
        self.issuer = settings.oidc_issuer.rstrip("/")
        self.client_id = settings.oidc_client_id
        self.client_secret = settings.oidc_client_secret
        self.redirect_uri = f"{settings.public_url}/api/auth/oidc/callback"
        self._clock = clock
        self._lock = threading.Lock()
        self._discovery = _Cell()
        self._jwks = _Cell()
        self._jwks_tried_at: float | None = None

    # ------------------------------------------------------------ fetching

    def _get(self, url: str) -> bytes:
        return http_request(
            url, allow_http=self.settings.oidc_allow_http, timeout=METADATA_TIMEOUT_S
        )

    def _cached(
        self, cell: _Cell, ttl: float, what: str, load: Callable[[], Any], *, force: bool = False
    ) -> Any:
        """Single-flight cache: the lock only guards the bookkeeping, `load` runs outside it
        and in at most one thread. Other callers get the stale value if there is one, else
        fail fast with UNAVAILABLE. A failed load is remembered for `NEGATIVE_TTL_S`."""
        with self._lock:
            now = self._clock()
            if cell.value is not None and not force and now - cell.at < ttl:
                return cell.value
            if now < cell.failed_until:
                if cell.value is not None:
                    return cell.value
                raise OidcError(UNAVAILABLE, f"{what} unavailable, retrying later: {cell.failure}")
            if cell.inflight:
                if cell.value is not None:
                    return cell.value
                raise OidcError(UNAVAILABLE, f"{what} fetch already in progress")
            cell.inflight = True
        try:
            value = load()
        except BaseException as exc:
            with self._lock:
                cell.inflight = False
                if isinstance(exc, OidcError):
                    cell.failed_until = self._clock() + NEGATIVE_TTL_S
                    cell.failure = exc.detail
                    if cell.value is not None:
                        return cell.value  # keep serving the stale copy through an outage
            raise
        with self._lock:
            cell.value, cell.at, cell.failed_until, cell.inflight = value, self._clock(), 0.0, False
        return value

    def _endpoint_ok(self, url: Any) -> bool:
        if not isinstance(url, str):
            return False
        parts = urlsplit(url)
        ok = ("https", "http") if self.settings.oidc_allow_http else ("https",)
        return parts.scheme.lower() in ok and bool(parts.hostname)

    def discovery(self) -> dict[str, Any]:
        """The provider's discovery document: cached for an hour; a failure is cached for
        30 s (see `_cached`)."""
        doc: dict[str, Any] = self._cached(
            self._discovery, DISCOVERY_TTL_S, "discovery", self._load_discovery
        )
        return doc

    def _load_discovery(self) -> dict[str, Any]:
        url = f"{self.issuer}/.well-known/openid-configuration"
        try:
            doc = _json_object(self._get(url), "discovery document")
        except FetchError as exc:
            raise OidcError(UNAVAILABLE, f"discovery failed: {exc}") from None
        issuer = doc.get("issuer")
        if not isinstance(issuer, str) or issuer.rstrip("/") != self.issuer:
            raise OidcError(UNAVAILABLE, "discovery issuer does not match OIDC_ISSUER")
        for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            if not self._endpoint_ok(doc.get(key)):
                raise OidcError(UNAVAILABLE, f"discovery {key} missing or not https")
        for key in ("userinfo_endpoint", "end_session_endpoint"):
            if doc.get(key) is not None and not self._endpoint_ok(doc[key]):
                doc.pop(key)  # optional, and unusable: behave as if absent
        return doc

    def _load_jwks(self, doc: dict[str, Any]) -> PyJWKSet:
        try:
            return PyJWKSet.from_dict(_json_object(self._get(doc["jwks_uri"]), "JWKS"))
        except (FetchError, jwt.PyJWTError) as exc:
            raise OidcError(UNAVAILABLE, f"JWKS fetch failed: {exc}") from None

    def _signing_key(self, kid: str | None) -> PyJWK:
        doc = self.discovery()

        def load() -> PyJWKSet:
            keyset = self._load_jwks(doc)
            self._jwks_tried_at = self._clock()
            return keyset

        keyset: PyJWKSet = self._cached(self._jwks, JWKS_TTL_S, "JWKS", load)
        key = self._find(keyset, kid)
        if key is None:
            with self._lock:
                now = self._clock()
                # Key rotation: refetch, but not more than once a minute.
                refetch = (
                    self._jwks_tried_at is None or now - self._jwks_tried_at >= JWKS_REFETCH_MIN_S
                )
                if refetch:
                    self._jwks_tried_at = now
            if refetch:
                key = self._find(
                    self._cached(self._jwks, JWKS_TTL_S, "JWKS", load, force=True), kid
                )
        if key is None:
            raise OidcError(TOKEN, "no signing key for the token's kid")
        return key

    @staticmethod
    def _find(keyset: PyJWKSet, kid: str | None) -> PyJWK | None:
        if kid is None:
            return keyset.keys[0] if len(keyset.keys) == 1 else None
        for key in keyset.keys:
            if key.key_id == kid:
                return key
        return None

    # ---------------------------------------------------------------- flow

    def begin(self, next_path: str | None) -> tuple[str, Flow]:
        """Authorization URL and the secrets to remember until the callback."""
        doc = self.discovery()
        flow = Flow(
            state=secrets.token_urlsafe(32),
            nonce=secrets.token_urlsafe(32),
            verifier=secrets.token_urlsafe(48),
            next=safe_next(next_path),
        )
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(flow.verifier.encode()).digest())
            .rstrip(b"=")
            .decode()
        )
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "scope": self.settings.oidc_scopes,
                "state": flow.state,
                "nonce": flow.nonce,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            },
            quote_via=quote,
        )
        endpoint: str = doc["authorization_endpoint"]
        return f"{endpoint}{'&' if '?' in endpoint else '?'}{query}", flow

    def finish(self, code: str, flow: Flow) -> OidcUser:
        """Exchange the code, verify the id_token and return the claims we use."""
        doc = self.discovery()
        tokens = self._exchange(doc, code, flow.verifier)
        id_token = tokens.get("id_token")
        access_token = tokens.get("access_token")
        if not isinstance(id_token, str) or not id_token:
            raise OidcError(TOKEN, "token response has no id_token")
        claims = self._verify(id_token, flow.nonce)
        return self._user(doc, claims, access_token if isinstance(access_token, str) else None)

    def _exchange(self, doc: dict[str, Any], code: str, verifier: str) -> dict[str, Any]:
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "code_verifier": verifier,
        }
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        }
        if self.client_secret and self.settings.oidc_token_auth == "client_secret_basic":
            cred = f"{quote(self.client_id, safe='')}:{quote(self.client_secret, safe='')}"
            headers["Authorization"] = "Basic " + base64.b64encode(cred.encode()).decode()
        else:
            form["client_id"] = self.client_id
            if self.client_secret:
                form["client_secret"] = self.client_secret
        try:
            raw = http_request(
                doc["token_endpoint"],
                data=urlencode(form).encode(),
                headers=headers,
                allow_http=self.settings.oidc_allow_http,
            )
            return _json_object(raw, "token response")
        except FetchError as exc:
            code_ = UNAVAILABLE if exc.status is None else EXCHANGE
            raise OidcError(code_, f"token request failed: {exc}") from None

    def _verify(self, id_token: str, nonce: str) -> dict[str, Any]:
        try:
            header = jwt.get_unverified_header(id_token)
        except jwt.PyJWTError as exc:
            raise OidcError(TOKEN, f"unreadable id_token: {exc}") from None
        alg, kid = header.get("alg"), header.get("kid")
        if alg not in ALLOWED_ALGS:
            raise OidcError(TOKEN, f"id_token alg {alg!r} not allowed")
        if kid is not None and not isinstance(kid, str):
            raise OidcError(TOKEN, "id_token kid is not a string")
        key = self._signing_key(kid)
        if not _compatible(key, alg):
            raise OidcError(TOKEN, f"id_token alg {alg!r} does not fit the signing key")
        try:
            claims: dict[str, Any] = jwt.decode(
                id_token,
                key.key,
                algorithms=[alg],
                audience=self.client_id,
                leeway=LEEWAY_S,
                options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError as exc:
            raise OidcError(TOKEN, f"id_token rejected: {exc}") from None
        iss = claims.get("iss")
        if not isinstance(iss, str) or iss.rstrip("/") != self.issuer:
            raise OidcError(TOKEN, "id_token issuer mismatch")
        aud, azp = claims.get("aud"), claims.get("azp")
        if isinstance(aud, list) and len(aud) > 1 and azp is None:
            raise OidcError(TOKEN, "id_token has several audiences and no azp")
        if azp is not None and azp != self.client_id:
            raise OidcError(TOKEN, "id_token azp is not this client")
        got = claims.get("nonce")
        if not isinstance(got, str) or not hmac.compare_digest(got.encode(), nonce.encode()):
            raise OidcError(TOKEN, "id_token nonce mismatch")
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub or len(sub) > MAX_SUB_LEN:
            raise OidcError(TOKEN, "id_token sub is missing or invalid")
        return claims

    def _user(
        self, doc: dict[str, Any], claims: dict[str, Any], access_token: str | None
    ) -> OidcUser:
        sub: str = claims["sub"]
        gclaim = self.settings.oidc_groups_claim
        need = gclaim not in claims or "email" not in claims or "preferred_username" not in claims
        extra: dict[str, Any] = {}
        endpoint = doc.get("userinfo_endpoint")
        if need and endpoint and access_token:
            extra = self._userinfo(endpoint, access_token, sub)

        def pick(key: str) -> Any:
            return claims[key] if key in claims else extra.get(key)

        email = pick("email") if isinstance(pick("email"), str) else None
        # Verified-ness always comes from the same source as the address it vouches for.
        source = claims if "email" in claims else extra
        verified = source.get("email_verified")
        email_verified = verified is True or (
            isinstance(verified, str) and verified.strip().lower() == "true"
        )
        username = pick("preferred_username")
        username = username if isinstance(username, str) and username else None
        name = pick("name")
        name = name if isinstance(name, str) and name else None
        return OidcUser(
            sub=sub,
            name=(name or username or email or sub)[:200],
            email=email,
            email_verified=bool(email and email_verified),
            username=username,
            groups=_groups(pick(gclaim)),
        )

    def _userinfo(self, endpoint: str, access_token: str, sub: str) -> dict[str, Any]:
        try:
            info = _json_object(
                http_request(
                    endpoint,
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Accept": "application/json",
                    },
                    allow_http=self.settings.oidc_allow_http,
                ),
                "userinfo response",
            )
        except FetchError as exc:
            # Supplementary data: carry on with the id_token alone. Allow-lists then decide
            # on what we have, so a missing claim can only deny, never grant.
            log.warning("oidc userinfo unavailable: %s", exc)
            return {}
        got = info.get("sub")
        if not isinstance(got, str) or not hmac.compare_digest(got.encode(), sub.encode()):
            raise OidcError(TOKEN, "userinfo sub does not match the id_token")
        return info

    def end_session_url(self) -> str | None:
        """RP-initiated logout URL, if the provider has one (and is reachable)."""
        try:
            endpoint = self.discovery().get("end_session_endpoint")
        except OidcError as exc:
            log.warning("oidc logout url unavailable: %s", exc.detail)
            return None
        if not isinstance(endpoint, str):
            return None
        query = urlencode(
            {
                "client_id": self.client_id,
                "post_logout_redirect_uri": f"{self.settings.public_url}/",
            },
            quote_via=quote,
        )
        return f"{endpoint}{'&' if '?' in endpoint else '?'}{query}"


def _groups(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return ()
    return tuple(g for g in value if isinstance(g, str) and g)
