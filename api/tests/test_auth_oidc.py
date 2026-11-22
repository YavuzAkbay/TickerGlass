"""OIDC sign-in (auth_oidc.py, routes/auth.py) against a fake identity provider: a locally
generated RSA key signs the id_tokens, and `auth_oidc.http_request` is swapped for an
in-process IdP, so no network is touched."""

import base64
import hashlib
import json
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import parse_qs, urlsplit

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tickerglass_api import auth_oidc
from tickerglass_api.auth_oidc import FetchError, http_request, safe_next

ISSUER = "https://idp.example"
CLIENT_ID = "tickerglass"
PUBLIC = "https://tg.example.com"
CALLBACK = f"{PUBLIC}/api/auth/oidc/callback"


def _jwk(private: rsa.RSAPrivateKey, kid: str) -> dict[str, Any]:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private.public_key()))
    return {**jwk, "kid": kid, "use": "sig", "alg": "RS256"}


_KEYS = {k: rsa.generate_private_key(public_exponent=65537, key_size=2048) for k in ("k1", "k2")}


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class FakeIdp:
    def __init__(self) -> None:
        self.keys = _KEYS
        self.published = ["k1"]
        self.down = False
        self.token_status: int | None = None
        self.discovery_overrides: dict[str, Any] = {}
        self.userinfo: dict[str, Any] | None = None
        self.userinfo_down = False
        self.id_token_claims: dict[str, Any] = {}
        self.sign_with = "k1"
        self.rogue: rsa.RSAPrivateKey | None = None
        self.alg = "RS256"
        self.hs_secret = "a" * 64
        self.codes: dict[str, dict[str, Any]] = {}
        self.calls: list[tuple[str, bytes | None, dict[str, str]]] = []

    def count(self, suffix: str) -> int:
        return sum(1 for url, _, _ in self.calls if url.endswith(suffix))

    # --------------------------------------------------------- http routes

    def request(
        self,
        url: str,
        *,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
        allow_http: bool = False,
        timeout: float = 10,
    ) -> bytes:
        self.calls.append((url, data, headers or {}))
        if self.down:
            raise FetchError("connection refused")
        if url == f"{ISSUER}/.well-known/openid-configuration":
            doc = {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/authorize",
                "token_endpoint": f"{ISSUER}/token",
                "jwks_uri": f"{ISSUER}/jwks",
                "userinfo_endpoint": f"{ISSUER}/userinfo",
                "end_session_endpoint": f"{ISSUER}/logout",
            }
            return json.dumps({**doc, **self.discovery_overrides}).encode()
        if url == f"{ISSUER}/jwks":
            return json.dumps({"keys": [_jwk(self.keys[k], k) for k in self.published]}).encode()
        if url == f"{ISSUER}/userinfo":
            if self.userinfo_down or self.userinfo is None:
                raise FetchError("HTTP 500", 500)
            assert (headers or {}).get("Authorization") == "Bearer at-1"
            return json.dumps(self.userinfo).encode()
        if url == f"{ISSUER}/token":
            return self._token(data or b"", headers or {})
        raise AssertionError(f"unexpected request {url}")

    def _token(self, data: bytes, headers: dict[str, str]) -> bytes:
        if self.token_status is not None:
            raise FetchError(f"HTTP {self.token_status}", self.token_status)
        form = {k: v[0] for k, v in parse_qs(data.decode()).items()}
        flow = self.codes.pop(form["code"], None)
        if flow is None or form["grant_type"] != "authorization_code":
            raise FetchError("HTTP 400", 400)
        assert form["redirect_uri"] == CALLBACK
        digest = hashlib.sha256(form["code_verifier"].encode()).digest()
        challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
        if challenge != flow["challenge"]:
            raise FetchError("HTTP 400", 400)  # PKCE verification
        basic = headers.get("Authorization", "")
        if basic:
            assert base64.b64decode(basic.removeprefix("Basic ")) == b"tickerglass:shh"
            assert "client_secret" not in form
        else:
            assert form["client_id"] == CLIENT_ID and form["client_secret"] == "shh"
        return json.dumps(
            {"id_token": flow["id_token"], "access_token": "at-1", "token_type": "Bearer"}
        ).encode()

    # ------------------------------------------------------------- tokens

    def id_token(self, nonce: str, /, **overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "user-1",
            "iat": now,
            "exp": now + 300,
            "nonce": nonce,
            "preferred_username": "alice",
            "name": "Alice Example",
            "email": "alice@example.com",
            "email_verified": True,
            "groups": ["family"],
        }
        claims.update(self.id_token_claims)
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        if self.alg == "none":
            return jwt.encode(claims, None, algorithm="none", headers={"kid": self.sign_with})
        if self.alg.startswith("HS"):
            return jwt.encode(claims, self.hs_secret, algorithm=self.alg, headers={"kid": "k1"})
        key = self.rogue or self.keys[self.sign_with]
        return jwt.encode(claims, key, algorithm=self.alg, headers={"kid": self.sign_with})


@pytest.fixture
def idp(monkeypatch: pytest.MonkeyPatch) -> FakeIdp:
    fake = FakeIdp()
    monkeypatch.setattr(auth_oidc, "http_request", fake.request)
    return fake


OIDC = {
    "oidc_issuer": ISSUER,
    "oidc_client_id": CLIENT_ID,
    "oidc_client_secret": "shh",
    "public_url": PUBLIC,
    "oidc_provider_name": "Authentik",
}
LISTS = ("auth_allowed_users", "auth_allowed_groups", "auth_allow_any_user")
#: OIDC without an allow-list refuses to start: tests that are not about who may sign in let
#: everyone in.
OPEN = {**OIDC, "auth_allow_any_user": True}


def with_access(settings: dict[str, Any]) -> dict[str, Any]:
    """`OIDC` plus `settings`; open to every account unless the test sets an allow-list (or
    the flag) itself. Admin lists alone do not count: tests use them with non-admin users."""
    return {**(OIDC if any(k in settings for k in LISTS) else OPEN), **settings}


@pytest.fixture
def make_oidc(make_client: Callable[..., TestClient], idp: FakeIdp) -> Callable[..., TestClient]:
    def make(**settings: Any) -> TestClient:
        base = make_client(**with_access(settings))
        # https, so the Secure cookies come back; no auto-follow so each hop is visible.
        return TestClient(base.app, base_url="https://testserver", follow_redirects=False)

    return make


def authorize(
    client: TestClient, idp: FakeIdp, next_: str | None = None, **claims: Any
) -> dict[str, str]:
    """Walk /oidc/login and register the code the IdP would hand back; returns the query
    the callback needs."""
    res = client.get("/api/auth/oidc/login", params={"next": next_} if next_ else {})
    assert res.status_code == 302, res.text
    loc = urlsplit(res.headers["location"])
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == f"{ISSUER}/authorize"
    q = {k: v[0] for k, v in parse_qs(loc.query).items()}
    idp.codes["code-1"] = {
        "challenge": q["code_challenge"],
        "id_token": idp.id_token(q["nonce"], **claims),
    }
    return {"code": "code-1", "state": q["state"]}


def callback(client: TestClient, query: dict[str, str]) -> Any:
    return client.get("/api/auth/oidc/callback", params=query)


def signin(client: TestClient, idp: FakeIdp, next_: str | None = None, **claims: Any) -> Any:
    return callback(client, authorize(client, idp, next_, **claims))


def error_of(res: Any) -> str:
    assert res.status_code == 302, res.text
    loc = res.headers["location"]
    assert loc.startswith("/?auth_error="), loc
    assert "tickerglass_session" not in res.headers.get("set-cookie", "")
    return loc.removeprefix("/?auth_error=")


# ----------------------------------------------------------------- happy path


def test_login_redirect_has_pkce_state_nonce(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc()
    res = client.get("/api/auth/oidc/login")
    q = {k: v[0] for k, v in parse_qs(urlsplit(res.headers["location"]).query).items()}
    assert q["response_type"] == "code"
    assert q["client_id"] == CLIENT_ID
    assert q["redirect_uri"] == CALLBACK
    assert q["scope"] == "openid profile email groups"
    assert q["code_challenge_method"] == "S256"
    assert len(q["state"]) >= 32 and len(q["nonce"]) >= 32 and len(q["code_challenge"]) >= 43
    cookie = res.headers["set-cookie"].lower()
    assert "tickerglass_oidc=" in cookie
    assert "httponly" in cookie and "samesite=lax" in cookie and "secure" in cookie
    assert "path=/api/auth/oidc" in cookie and "max-age=600" in cookie


def test_full_flow(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    state = client.get("/api/auth/state").json()
    assert state["methods"] == ["oidc"] and state["oidcName"] == "Authentik"
    assert state["authed"] is False
    assert client.get("/api/watchlists").status_code == 401

    res = signin(client, idp, next_="/chart/AAPL?tf=1d")
    assert res.status_code == 302 and res.headers["location"] == "/chart/AAPL?tf=1d"
    cookies = res.headers.get_list("set-cookie")
    assert any(c.startswith("tickerglass_session=v2.") for c in cookies)
    assert any(c.startswith("tickerglass_oidc=") and "Max-Age=0" in c for c in cookies)
    session = next(c for c in cookies if c.startswith("tickerglass_session="))
    assert "HttpOnly" in session and "Secure" in session

    assert client.get("/api/watchlists").status_code == 200
    state = client.get("/api/auth/state").json()
    assert state["authed"] is True
    assert state["user"] == {
        "id": state["user"]["id"],
        "name": "Alice Example",
        "email": "alice@example.com",
        "method": "oidc",
        "role": "admin",  # first SSO identity of a single-user install claims the owner account
        "isOwner": True,
    }
    assert state["logoutAvailable"] is True
    # The websocket handshake does not replay the jar's Secure cookie in the test client.
    cookie = f"tickerglass_session={client.cookies['tickerglass_session']}"
    with client.websocket_connect("/ws", headers={"Cookie": cookie}) as ws:
        ws.send_json({"op": "events", "topics": []})
        assert ws.receive_json() == {"type": "events", "topics": []}


def test_password_login_is_off_without_password(make_oidc: Callable[..., TestClient]) -> None:
    assert make_oidc().post("/api/auth/login", json={"password": "x"}).status_code == 400


def test_oidc_routes_404_when_disabled(make_client: Callable[..., TestClient]) -> None:
    client = make_client(auth_password="sesame")
    assert client.get("/api/auth/oidc/login").status_code == 404
    assert client.get("/api/auth/oidc/callback").status_code == 404


def test_client_secret_post(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc(oidc_token_auth="client_secret_post")
    # The fake asserts client_id / client_secret in the body and no Basic header.
    assert signin(client, idp).headers["location"] == "/"
    assert client.get("/api/watchlists").status_code == 200


def test_public_client_without_secret(
    make_oidc: Callable[..., TestClient], idp: FakeIdp, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_oidc(oidc_client_secret="")
    seen: dict[str, str] = {}

    def token(data: bytes, headers: dict[str, str]) -> bytes:
        seen.update({k: v[0] for k, v in parse_qs(data.decode()).items()})
        seen["auth"] = headers.get("Authorization", "")
        # The fake's secret checks do not apply to a public client.
        form = seen
        flow = idp.codes.pop(form["code"])
        return json.dumps({"id_token": flow["id_token"], "access_token": "at-1"}).encode()

    monkeypatch.setattr(idp, "_token", token)
    assert signin(client, idp).headers["location"] == "/"
    assert seen["client_id"] == CLIENT_ID and "client_secret" not in seen and seen["auth"] == ""


# ----------------------------------------------------------------- state / cookie


def test_bad_state(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    q = authorize(client, idp)
    assert error_of(callback(client, {**q, "state": "x" * len(q["state"])})) == "oidc_state"
    assert error_of(callback(client, {"code": q["code"]})) == "oidc_state"
    assert client.get("/api/watchlists").status_code == 401


def test_missing_or_tampered_flow_cookie(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc()
    q = authorize(client, idp)
    flow = client.cookies["tickerglass_oidc"]
    client.cookies.clear()
    assert error_of(callback(client, q)) == "oidc_state"
    version, body, mac = flow.split(".")
    forged = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    forged["state"] = "attacker"
    new_body = base64.urlsafe_b64encode(json.dumps(forged).encode()).rstrip(b"=").decode()
    res = client.get(
        "/api/auth/oidc/callback",
        params={**q, "state": "attacker"},
        headers={"Cookie": f"tickerglass_oidc={version}.{new_body}.{mac}"},
    )
    assert error_of(res) == "oidc_state"


def test_flow_cookie_expires(
    make_oidc: Callable[..., TestClient], idp: FakeIdp, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_oidc()
    q = authorize(client, idp)
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 601)
    assert error_of(callback(client, q)) == "oidc_state"


def test_code_cannot_be_replayed(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    q = authorize(client, idp)
    assert callback(client, q).headers["location"] == "/"
    client.cookies.delete("tickerglass_session")
    # The flow cookie was cleared by the first callback.
    assert error_of(callback(client, q)) == "oidc_state"


def test_provider_error_is_denied(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    q = authorize(client, idp)
    res = client.get(
        "/api/auth/oidc/callback", params={"error": "access_denied", "state": q["state"]}
    )
    assert error_of(res) == "oidc_denied"
    # Without a matching state an error callback is just a bad state.
    assert (
        error_of(client.get("/api/auth/oidc/callback", params={"error": "access_denied"}))
        == "oidc_state"
    )


# ----------------------------------------------------------------- id_token checks


@pytest.mark.parametrize(
    "claims",
    [
        {"nonce": "wrong-nonce"},
        {"nonce": None},
        {"iss": "https://evil.example"},
        {"iss": None},
        {"aud": "someone-else"},
        {"aud": ["someone-else", "other"]},
        {"aud": [CLIENT_ID, "other"]},  # several audiences and no azp
        {"aud": [CLIENT_ID, "other"], "azp": "other"},
        {"azp": "other"},
        {"exp": int(time.time()) - 3600},
        {"iat": int(time.time()) + 3600},
        {"exp": None},
        {"iat": None},
        {"sub": None},
        {"sub": ""},
        {"sub": "x" * 300},
    ],
    ids=lambda c: ",".join(f"{k}={str(v)[:12]}" for k, v in c.items()),
)
def test_bad_id_token_claims(
    make_oidc: Callable[..., TestClient], idp: FakeIdp, claims: dict[str, Any]
) -> None:
    client = make_oidc()
    assert error_of(signin(client, idp, **claims)) == "oidc_token"
    assert client.get("/api/watchlists").status_code == 401


def test_multiple_audiences_with_matching_azp(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc()
    res = signin(client, idp, aud=[CLIENT_ID, "other"], azp=CLIENT_ID)
    assert res.headers["location"] == "/"


def test_trailing_slash_issuer_is_normalised(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc()
    assert signin(client, idp, iss=ISSUER + "/").headers["location"] == "/"


def test_small_clock_skew_is_tolerated(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    now = int(time.time())
    res = signin(client, idp, iat=now + 30, exp=now - 30)
    assert res.headers["location"] == "/"


@pytest.mark.parametrize("alg", ["none", "HS256", "HS512"])
def test_forbidden_algorithms(make_oidc: Callable[..., TestClient], idp: FakeIdp, alg: str) -> None:
    client = make_oidc()
    idp.alg = alg
    assert error_of(signin(client, idp)) == "oidc_token"


def test_bad_signature(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    # Signed with a key the JWKS does not hold, but claiming the published kid.
    idp.rogue = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert error_of(signin(client, idp)) == "oidc_token"
    assert client.get("/api/watchlists").status_code == 401


def test_unknown_kid_refetches_jwks_at_most_once_a_minute(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc()
    clock = Clock()
    client.app.state.oidc._clock = clock  # type: ignore[attr-defined]
    assert signin(client, idp).headers["location"] == "/"
    assert idp.count("/jwks") == 1
    # The IdP rotates its key.
    idp.published, idp.sign_with = ["k2"], "k2"
    clock.t += 30
    assert error_of(signin(client, idp)) == "oidc_token"
    assert idp.count("/jwks") == 1  # too soon to refetch
    clock.t += 31
    assert signin(client, idp).headers["location"] == "/"
    assert idp.count("/jwks") == 2


def test_alg_must_fit_the_signing_key(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    from cryptography.hazmat.primitives.asymmetric import ec

    client = make_oidc()
    # An EC-signed token against an RSA JWK used to raise TypeError (a 500).
    idp.alg, idp.rogue = "ES256", ec.generate_private_key(ec.SECP256R1())
    res = signin(client, idp)
    assert error_of(res) == "oidc_token"
    assert "tickerglass_oidc" in res.headers["set-cookie"]  # flow cookie cleared
    assert client.get("/api/watchlists").status_code == 401
    # The JWK names RS256, so a PS256 token against the same key is refused too.
    idp.alg, idp.rogue = "PS256", None
    assert error_of(signin(client, idp)) == "oidc_token"
    idp.alg = "RS256"
    assert signin(client, idp).headers["location"] == "/"


@pytest.mark.parametrize(
    ("jwk", "alg", "ok"),
    [
        ({"kty": "RSA"}, "RS256", True),
        ({"kty": "RSA"}, "PS384", True),
        ({"kty": "RSA", "alg": "RS256"}, "PS256", False),
        ({"kty": "RSA"}, "ES256", False),
        ({"kty": "RSA"}, "EdDSA", False),
        ({"kty": "EC", "crv": "P-256"}, "ES256", True),
        ({"kty": "EC", "crv": "P-256"}, "ES384", False),
        ({"kty": "EC", "crv": "P-384"}, "ES384", True),
        ({"kty": "EC", "crv": "P-521"}, "ES512", True),
        ({"kty": "EC", "crv": "P-256"}, "RS256", False),
        ({"kty": "OKP", "crv": "Ed25519"}, "EdDSA", True),
        ({"kty": "OKP", "crv": "Ed25519"}, "ES256", False),
    ],
)
def test_alg_key_compatibility(jwk: dict[str, str], alg: str, ok: bool) -> None:
    class Key:
        key_type = jwk["kty"]
        _jwk_data = jwk

    assert auth_oidc._compatible(Key(), alg) is ok  # type: ignore[arg-type]


def test_unexpected_error_in_callback_clears_the_flow_cookie(
    make_oidc: Callable[..., TestClient], idp: FakeIdp, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_oidc()

    def boom(*_: Any, **__: Any) -> None:
        raise TypeError("secret-bearing detail")

    q = authorize(client, idp)
    monkeypatch.setattr(auth_oidc.OidcClient, "finish", boom)
    res = callback(client, q)
    assert error_of(res) == "oidc_token"
    assert "tickerglass_oidc" in res.headers["set-cookie"]
    assert client.get("/api/watchlists").status_code == 401


def test_jwks_failure_is_unavailable(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    idp.published = []
    assert error_of(signin(client, idp)) == "oidc_unavailable"


# ------------------------------------------------------------------ next / redirects


@pytest.mark.parametrize(
    "value",
    [
        "//evil.example",
        "/\\evil.example",
        "https://evil.example",
        "evil",
        "javascript:alert(1)",
        "/ok\r\nSet-Cookie: x=y",
        "/a\\b",
        "http:/evil",
        "",
        "/" + "a" * 3000,
    ],
)
def test_open_redirect_is_blocked(value: str) -> None:
    assert safe_next(value) == "/"


def test_next_kept_when_safe() -> None:
    assert safe_next("/watchlist?x=1#frag") == "/watchlist?x=1#frag"
    assert safe_next(None) == "/"


def test_open_redirect_end_to_end(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    assert signin(client, idp, next_="//evil.example/x").headers["location"] == "/"
    client.cookies.clear()
    assert signin(client, idp, next_="https://evil.example").headers["location"] == "/"


# ------------------------------------------------------------------- allow-lists


def test_allowed_users(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    for allowed, claims, ok in [
        ("ALICE", {}, True),  # preferred_username, case-insensitive
        ("user-1", {}, True),  # sub
        ("alice@example.com", {}, True),  # verified email
        ("ALICE@EXAMPLE.COM", {}, True),
        ("bob", {}, False),
        ("alice@example.com", {"email_verified": False}, False),
        ("alice@example.com", {"email_verified": None}, False),
        ("alice@example.com", {"email_verified": "true"}, True),
        ("alice@example.com", {"email_verified": "false"}, False),
    ]:
        client = make_oidc(auth_allowed_users=allowed)
        res = signin(client, idp, **claims)
        if ok:
            assert res.headers["location"] == "/", (allowed, claims)
        else:
            assert error_of(res) == "oidc_denied", (allowed, claims)
            assert client.get("/api/watchlists").status_code == 401


def test_allowed_groups(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc(auth_allowed_groups="admins, family")
    assert signin(client, idp, groups=["x", "family"]).headers["location"] == "/"
    client = make_oidc(auth_allowed_groups="admins")
    assert error_of(signin(client, idp, groups=["family"])) == "oidc_denied"
    assert error_of(signin(client, idp, groups=None)) == "oidc_denied"
    assert error_of(signin(client, idp, groups="family")) == "oidc_denied"
    client = make_oidc(auth_allowed_groups="family", oidc_groups_claim="roles")
    assert signin(client, idp, roles=["family"]).headers["location"] == "/"


def test_allow_any_user_flag(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc(auth_allow_any_user=True)
    res = signin(client, idp, sub="nobody", preferred_username="nobody", email=None)
    assert res.headers["location"] == "/"
    # Without the flag and with a list, the list decides again.
    client = make_oidc(auth_allow_any_user=False, auth_allowed_users="bob")
    assert error_of(signin(client, idp)) == "oidc_denied"


def test_admin_lists_alone_allow_only_admins(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    for kw, claims, ok in [
        ({"auth_admin_users": "user-1"}, {}, True),  # sub
        ({"auth_admin_users": "ALICE@example.com"}, {}, True),  # verified email
        ({"auth_admin_users": "alice@example.com"}, {"email_verified": False}, False),
        ({"auth_admin_users": "alice"}, {}, False),  # preferred_username never makes an admin
        ({"auth_admin_users": "bob"}, {}, False),
        ({"auth_admin_groups": "ops"}, {"groups": ["x", "ops"]}, True),
        ({"auth_admin_groups": "ops"}, {"groups": ["family"]}, False),
        ({"auth_admin_groups": "ops"}, {}, False),
    ]:
        client = make_oidc(auth_allow_any_user=False, **kw)
        res = signin(client, idp, **claims)
        if ok:
            assert res.headers["location"] == "/", (kw, claims)
            assert client.get("/api/me").json()["role"] == "admin"
        else:
            assert error_of(res) == "oidc_denied", (kw, claims)
            assert client.get("/api/watchlists").status_code == 401
    # An allow-list and an admin list together: either one lets a user in.
    client = make_oidc(auth_allowed_users="bob", auth_admin_users="user-1")
    assert signin(client, idp).headers["location"] == "/"


def test_both_lists_must_match(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc(auth_allowed_users="alice", auth_allowed_groups="admins")
    assert error_of(signin(client, idp, groups=["family"])) == "oidc_denied"
    client = make_oidc(auth_allowed_users="bob", auth_allowed_groups="family")
    assert error_of(signin(client, idp)) == "oidc_denied"


# ------------------------------------------------------------------------ userinfo


def test_userinfo_fills_missing_claims(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc(auth_allowed_groups="family", auth_allowed_users="bob@example.com")
    idp.userinfo = {
        "sub": "user-1",
        "email": "bob@example.com",
        "email_verified": True,
        "groups": ["family"],
        "preferred_username": "bobby",
    }
    res = signin(
        client,
        idp,
        groups=None,
        email=None,
        email_verified=None,
        preferred_username=None,
        name=None,
    )
    assert res.headers["location"] == "/"
    got = client.get("/api/auth/state").json()["user"]
    assert got.pop("id") and got == {
        "role": "admin",
        "name": "bobby",
        "email": "bob@example.com",
        "method": "oidc",
        "isOwner": True,
    }


def test_userinfo_not_fetched_when_id_token_is_complete(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc()
    signin(client, idp)
    assert idp.count("/userinfo") == 0


def test_userinfo_cannot_override_id_token_claims(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc(auth_allowed_groups="admins")
    idp.userinfo = {
        "sub": "user-1",
        "groups": ["admins"],
        "email": "x@evil",
        "email_verified": True,
    }
    # The id_token has an email but no groups: groups come from userinfo, the email stays.
    res = signin(client, idp, groups=None)
    assert res.headers["location"] == "/"
    assert client.get("/api/auth/state").json()["user"]["email"] == "alice@example.com"


def test_userinfo_sub_mismatch(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    idp.userinfo = {"sub": "someone-else", "groups": ["admins"]}
    assert error_of(signin(client, idp, groups=None)) == "oidc_token"


def test_userinfo_down_only_denies(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    idp.userinfo_down = True
    client = make_oidc(auth_allowed_groups="family")
    assert error_of(signin(client, idp, groups=None)) == "oidc_denied"
    client = make_oidc()
    assert signin(client, idp, groups=None).headers["location"] == "/"


# ------------------------------------------------------------------- IdP trouble


def test_idp_down_at_login(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    clock = Clock()
    client.app.state.oidc._clock = clock  # type: ignore[attr-defined]
    idp.down = True
    res = client.get("/api/auth/oidc/login")
    assert res.status_code == 302 and res.headers["location"] == "/?auth_error=oidc_unavailable"
    assert "tickerglass_oidc" in res.headers["set-cookie"]  # cleared, not set
    idp.down = False
    # The failure is remembered for 30 s, then the next login fetches again.
    again = client.get("/api/auth/oidc/login")
    assert again.headers["location"] == "/?auth_error=oidc_unavailable"
    assert idp.count("openid-configuration") == 1
    clock.t += 31
    assert client.get("/api/auth/oidc/login").headers["location"].startswith(f"{ISSUER}/authorize")


def test_idp_down_at_token_endpoint(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    q = authorize(client, idp)
    idp.token_status = 400
    assert error_of(callback(client, q)) == "oidc_exchange"
    q = authorize(client, idp)
    idp.token_status = None
    idp.down = True
    assert error_of(callback(client, q)) == "oidc_unavailable"


def test_failures_are_cached_and_retried_after_the_window(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    oidc = make_oidc().app.state.oidc  # type: ignore[attr-defined]
    clock = Clock()
    oidc._clock = clock
    idp.down = True
    for _ in range(5):
        with pytest.raises(auth_oidc.OidcError) as err:
            oidc.discovery()
        assert err.value.code == "oidc_unavailable"
    assert idp.count("openid-configuration") == 1
    idp.down = False
    clock.t += 29
    with pytest.raises(auth_oidc.OidcError):
        oidc.discovery()
    assert idp.count("openid-configuration") == 1
    clock.t += 2
    assert oidc.discovery()["issuer"] == ISSUER
    assert idp.count("openid-configuration") == 2
    # JWKS: same rule.
    idp.published = []
    for _ in range(3):
        with pytest.raises(auth_oidc.OidcError):
            oidc._signing_key("k1")
    assert idp.count("/jwks") == 1
    idp.published = ["k1"]
    clock.t += 31
    assert oidc._signing_key("k1").key_id == "k1"
    assert idp.count("/jwks") == 2


def test_stale_discovery_survives_an_outage(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    oidc = make_oidc().app.state.oidc  # type: ignore[attr-defined]
    clock = Clock()
    oidc._clock = clock
    first = oidc.discovery()
    idp.down = True
    clock.t += 3601
    assert oidc.discovery() == first
    assert idp.count("openid-configuration") == 2  # one failed refresh, then cached failure
    assert oidc.discovery() == first
    assert idp.count("openid-configuration") == 2


def test_concurrent_callers_share_one_fetch_and_fail_fast(
    make_oidc: Callable[..., TestClient], idp: FakeIdp, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    oidc = make_oidc().app.state.oidc  # type: ignore[attr-defined]
    entered, release = threading.Event(), threading.Event()
    fetches: list[str] = []

    def hung(url: str, **_: Any) -> bytes:
        fetches.append(url)
        entered.set()
        release.wait(5)
        raise FetchError("timed out")

    monkeypatch.setattr(auth_oidc, "http_request", hung)
    errors: list[str] = []
    first = threading.Thread(target=lambda: _try(oidc.discovery, errors))
    first.start()
    assert entered.wait(5)
    # While the first fetch hangs, everyone else is refused at once (no waiting on a lock).
    started = time.monotonic()
    others = [threading.Thread(target=lambda: _try(oidc.discovery, errors)) for _ in range(20)]
    for t in others:
        t.start()
    for t in others:
        t.join(2)
    assert time.monotonic() - started < 2
    assert not any(t.is_alive() for t in others)
    assert len(errors) == 20 and set(errors) == {"oidc_unavailable"}
    release.set()
    first.join(5)
    assert len(fetches) == 1
    assert len(errors) == 21
    # The failure is now cached: still no second fetch.
    with pytest.raises(auth_oidc.OidcError):
        oidc.discovery()
    assert len(fetches) == 1


def _try(fn: Callable[[], Any], errors: list[str]) -> None:
    try:
        fn()
    except auth_oidc.OidcError as exc:
        errors.append(exc.code)


def test_app_boots_while_idp_is_down(make_client: Callable[..., TestClient], idp: FakeIdp) -> None:
    idp.down = True
    client = make_client(**OPEN)
    assert client.get("/api/health").status_code == 200
    state = client.get("/api/auth/state").json()
    assert state["methods"] == ["oidc"] and state["authed"] is False
    assert idp.calls == []  # discovery is lazy


def test_discovery_is_cached(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    clock = Clock()
    client.app.state.oidc._clock = clock  # type: ignore[attr-defined]
    for _ in range(3):
        client.get("/api/auth/oidc/login")
    assert idp.count("openid-configuration") == 1
    clock.t += 3601
    client.get("/api/auth/oidc/login")
    assert idp.count("openid-configuration") == 2


def test_discovery_issuer_mismatch(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc()
    idp.discovery_overrides = {"issuer": "https://evil.example"}
    assert client.get("/api/auth/oidc/login").headers["location"] == "/?auth_error=oidc_unavailable"


@pytest.mark.parametrize("key", ["authorization_endpoint", "token_endpoint", "jwks_uri"])
def test_discovery_endpoints_must_be_https(
    make_oidc: Callable[..., TestClient], idp: FakeIdp, key: str
) -> None:
    client = make_oidc()
    idp.discovery_overrides = {key: "http://idp.example/x"}
    assert client.get("/api/auth/oidc/login").headers["location"] == "/?auth_error=oidc_unavailable"


def test_http_endpoints_allowed_with_flag(
    make_client: Callable[..., TestClient], idp: FakeIdp
) -> None:
    idp.discovery_overrides = {"authorization_endpoint": "http://idp.lan/authorize"}
    client = TestClient(
        make_client(**OPEN, oidc_allow_http=True).app,
        base_url="https://testserver",
        follow_redirects=False,
    )
    assert (
        client.get("/api/auth/oidc/login")
        .headers["location"]
        .startswith("http://idp.lan/authorize")
    )


def test_http_request_refuses_other_schemes() -> None:
    for url in ("file:///etc/passwd", "ftp://x/y", "http://idp.lan/x"):
        with pytest.raises(FetchError):
            http_request(url)


# ------------------------------------------------------------------ session & logout


def test_logout_uses_end_session_endpoint(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc(auth_logout_url="https://fallback.example/out")
    signin(client, idp)
    res = client.post("/api/auth/logout")
    assert res.status_code == 200
    target = urlsplit(res.json()["redirect"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == f"{ISSUER}/logout"
    q = parse_qs(target.query)
    assert q == {"client_id": [CLIENT_ID], "post_logout_redirect_uri": [f"{PUBLIC}/"]}
    assert "tickerglass_session=" in res.headers["set-cookie"]
    assert client.get("/api/watchlists").status_code == 401


def test_logout_without_end_session_endpoint(
    make_oidc: Callable[..., TestClient], idp: FakeIdp
) -> None:
    client = make_oidc(auth_logout_url="https://fallback.example/out")
    signin(client, idp)
    idp.discovery_overrides = {"end_session_endpoint": None}
    client.app.state.oidc._discovery.value = None  # type: ignore[attr-defined]
    assert client.post("/api/auth/logout").json() == {"redirect": "https://fallback.example/out"}
    client = make_oidc()
    signin(client, idp)
    assert client.post("/api/auth/logout").json() == {"redirect": None}


def test_oidc_session_dies_when_client_changes(
    make_client: Callable[..., TestClient], idp: FakeIdp
) -> None:
    from tickerglass_api.auth import Authenticator

    base = make_client(**OPEN)
    client = TestClient(base.app, base_url="https://testserver", follow_redirects=False)
    signin(client, idp)
    cookie = client.cookies["tickerglass_session"]
    app = base.app
    secret = app.state.auth_secret  # type: ignore[attr-defined]
    from tickerglass_api.settings import Settings

    def authed_with(**changes: Any) -> bool:
        settings = Settings(_env_file=None, **{**OPEN, **changes})  # type: ignore[call-arg]
        auth = Authenticator(settings, secret)
        scope = {"type": "http", "headers": [(b"cookie", f"tickerglass_session={cookie}".encode())]}
        return auth.authenticate(scope) is not None

    assert authed_with()
    # Changing who may sign in ends existing OIDC sessions.
    assert not authed_with(auth_allowed_users="alice")
    assert not authed_with(auth_allowed_groups="family")
    assert not authed_with(auth_admin_users="alice")
    assert not authed_with(auth_admin_groups="admins")
    assert not authed_with(auth_allow_any_user=False, auth_allowed_users="alice")
    assert authed_with(auth_allowed_users="") and authed_with(auth_allowed_groups="")
    assert authed_with(auth_admin_users="") and authed_with(auth_admin_groups="")
    assert not authed_with(oidc_client_id="other")
    assert not authed_with(oidc_issuer="https://other.example")
    assert not authed_with(
        oidc_issuer=None, oidc_client_id=None, public_url=None, auth_password="pw"
    )


def test_password_and_oidc_together(make_oidc: Callable[..., TestClient], idp: FakeIdp) -> None:
    client = make_oidc(auth_password="sesame")
    assert client.get("/api/auth/state").json()["methods"] == ["password", "oidc"]
    assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    assert client.get("/api/auth/state").json()["user"]["method"] == "password"
    client.cookies.clear()
    signin(client, idp)
    assert client.get("/api/auth/state").json()["user"]["method"] == "oidc"


def test_websocket_rejected_without_session(make_oidc: Callable[..., TestClient]) -> None:
    client = make_oidc()
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
        pass
