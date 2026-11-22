"""Optional password auth (auth.py): cookie sessions, the middleware guard, the
alerts-token bypass and the login rate limit. Auth is off unless AUTH_PASSWORD is
set, so every other test module runs against an open app unchanged."""

import base64
import hashlib
import hmac
import logging
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from tickerglass_api.auth import (
    LOCKOUT_S,
    Identity,
    LoginLimiter,
    _seal,
    client_ip,
    forwarded_proto_https,
    make_oidc_flow,
    make_session,
    oidc_tag,
    parse_networks,
    password_tag,
    read_session,
    session_secret,
)
from tickerglass_api.logredact import RedactAuthToken, install_log_redaction
from tickerglass_api.settings import Settings

TOKEN = "tok-1-0123456789abcdef0123456789abcdef"


@pytest.fixture
def auth_client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client(auth_password="sesame")


def test_session_roundtrip() -> None:
    pw = password_tag("s3cret", "pw")
    token = make_session(
        "s3cret", sub="u", name="U", email="u@x.io", method="password", ttl_s=100, tag=pw, now=1000
    )
    who = read_session(token, "s3cret", pw_tag=pw, now=1050.0)
    assert who == Identity("u", "U", "u@x.io", (), "password")
    assert read_session(token, "s3cret", pw_tag=pw, now=1100.0) is None  # expired
    assert read_session(token, "other", pw_tag=pw, now=1050.0) is None  # wrong secret
    # A changed password, or the password method switched off, kills the session.
    assert read_session(token, "s3cret", pw_tag=password_tag("s3cret", "new"), now=1050.0) is None
    assert read_session(token, "s3cret", pw_tag=None, oc_tag=pw, now=1050.0) is None
    assert read_session("garbage", "s3cret", pw_tag=pw) is None
    assert read_session(None, "s3cret", pw_tag=pw) is None


def test_session_does_not_leak_the_password() -> None:
    pw = password_tag("s3cret", "sesame")
    token = make_session(
        "s3cret", sub="p", name="P", email=None, method="password", ttl_s=9, tag=pw
    )
    body = token.split(".")[1]
    assert hashlib.sha256(b"sesame").hexdigest() not in token
    assert b"sesame" not in base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))


def test_v1_and_malformed_tokens_rejected() -> None:
    pw = password_tag("s3cret", "pw")
    sig = hmac.new(b"s3cret", b"9999999999.x", hashlib.sha256).hexdigest()
    v1 = f"9999999999.{hashlib.sha256(b'pw').hexdigest()}.{sig}"
    assert read_session(v1, "s3cret", pw_tag=pw) is None
    good = make_session(
        "s3cret", sub="u", name="U", email=None, method="password", ttl_s=99, tag=pw
    )
    version, body, mac = good.split(".")
    assert read_session(f"v3.{body}.{mac}", "s3cret", pw_tag=pw) is None
    assert read_session(f"v2.{body}", "s3cret", pw_tag=pw) is None
    assert read_session(f"v2.{body}.!!!", "s3cret", pw_tag=pw) is None
    assert read_session(f"v2.%%%.{mac}", "s3cret", pw_tag=pw) is None
    assert read_session(good + "x", "s3cret", pw_tag=pw) is None
    # An OIDC flow cookie is signed for a different purpose.
    flow = make_oidc_flow("s3cret", {"exp": 9999999999, "sub": "u", "m": "password"})
    assert read_session(flow, "s3cret", pw_tag=pw) is None
    # Unknown method.
    forged = _seal(
        "s3cret", "session", "v2", {"sub": "u", "name": "", "m": "root", "exp": 9e9, "tag": pw}
    )
    assert read_session(forged, "s3cret", pw_tag=pw) is None


def test_unseal_checks_the_mac_before_parsing() -> None:
    pw = password_tag("s3cret", "pw")
    for depth in (2900, 100_000):
        bomb = base64.urlsafe_b64encode(b"[" * depth).rstrip(b"=").decode()
        assert read_session(f"v2.{bomb}.AAAA", "s3cret", pw_tag=pw) is None
    # Even a correctly signed body that cannot be parsed is just "no session".
    body = base64.urlsafe_b64encode(b"[" * 100_000).rstrip(b"=").decode()
    sig = base64.urlsafe_b64encode(
        hmac.new(b"s3cret", f"session.v2.{body}".encode(), hashlib.sha256).digest()
    ).rstrip(b"=")
    assert read_session(f"v2.{body}.{sig.decode()}", "s3cret", pw_tag=pw) is None


def test_deeply_nested_cookie_is_401_not_500(auth_client: TestClient) -> None:
    body = base64.urlsafe_b64encode(b"[" * 2900).rstrip(b"=").decode()
    res = auth_client.get(
        "/api/watchlists", headers={"Cookie": f"tickerglass_session=v2.{body}.AAAA"}
    )
    assert res.status_code == 401


def test_oidc_session_bound_to_allow_lists() -> None:
    base = oidc_tag("s3cret", "https://idp", "tg")
    assert base == oidc_tag("s3cret", "https://idp", "tg", [], [])
    users = oidc_tag("s3cret", "https://idp", "tg", ["Alice", "bob"], [])
    assert users != base
    assert users == oidc_tag("s3cret", "https://idp", "tg", [" bob ", "ALICE"], [])  # normalized
    assert users != oidc_tag("s3cret", "https://idp", "tg", ["alice"], [])
    groups = oidc_tag("s3cret", "https://idp", "tg", [], ["family"])
    assert groups not in (base, users)
    assert groups != oidc_tag("s3cret", "https://idp", "tg", ["family"], [])  # lists differ
    token = make_session(
        "s3cret", sub="u", name="U", email=None, method="oidc", ttl_s=99, tag=users
    )
    assert read_session(token, "s3cret", oc_tag=users) is not None
    assert read_session(token, "s3cret", oc_tag=base) is None


def test_oidc_session_bound_to_issuer_and_client() -> None:
    tag = oidc_tag("s3cret", "https://idp.example/", "tg")
    assert tag == oidc_tag("s3cret", "https://idp.example", "tg")
    token = make_session("s3cret", sub="u", name="U", email=None, method="oidc", ttl_s=99, tag=tag)
    assert read_session(token, "s3cret", oc_tag=tag) is not None
    assert (
        read_session(token, "s3cret", oc_tag=oidc_tag("s3cret", "https://idp.example", "x")) is None
    )
    assert read_session(token, "s3cret", oc_tag=oidc_tag("s3cret", "https://other", "tg")) is None
    assert read_session(token, "s3cret", oc_tag=None, pw_tag=tag) is None


def test_secret_persists_next_to_sqlite(tmp_path: Any) -> None:
    url = f"sqlite:///{tmp_path}/db.sqlite3"
    a = session_secret(Settings(_env_file=None, database_url=url))  # type: ignore[call-arg]
    b = session_secret(Settings(_env_file=None, database_url=url))  # type: ignore[call-arg]
    assert a == b
    assert a != session_secret(  # type: ignore[call-arg]
        Settings(_env_file=None, database_url="sqlite:///:memory:")
    )


def test_auth_state_reports_disabled(auth_client: TestClient) -> None:
    res = auth_client.get("/api/auth/state")
    assert res.status_code == 200
    assert res.json() == {
        "enabled": True,
        "authed": False,
        "methods": ["password"],
        "oidcName": None,
        "user": None,
        "logoutAvailable": False,
        "canManageUsers": False,
        "localAccounts": True,
    }


def test_open_app_when_auth_unset(make_client: Callable[..., TestClient]) -> None:
    client = make_client()
    res = client.get("/api/auth/state")
    assert res.json() == {
        "enabled": False,
        "authed": False,
        "methods": [],
        "oidcName": None,
        "user": None,
        "logoutAvailable": False,
        "canManageUsers": False,
        "localAccounts": False,
    }
    assert client.get("/api/watchlists").status_code == 200


def test_login_flow(auth_client: TestClient) -> None:
    assert auth_client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    res = auth_client.post("/api/auth/login", json={"password": "sesame"})
    assert res.status_code == 204
    assert "tickerglass_session" in res.headers["set-cookie"]
    # TestClient keeps cookies: the guarded routes work now.
    assert auth_client.get("/api/watchlists").status_code == 200
    state = auth_client.get("/api/auth/state").json()
    assert state["authed"] is True
    assert state["user"]["method"] == "password"
    assert state["logoutAvailable"] is True
    res = auth_client.post("/api/auth/logout")
    assert res.status_code == 200
    assert res.json() == {"redirect": None}
    assert auth_client.get("/api/watchlists").status_code == 401


def test_guarded_routes_reject_without_cookie(auth_client: TestClient) -> None:
    for method, path in (
        ("GET", "/api/watchlists"),
        ("POST", "/api/providers/test"),
        ("GET", "/api/quotes?symbols=AAPL"),
    ):
        res = auth_client.request(method, path)
        assert res.status_code == 401, f"{method} {path}: {res.status_code}"
        assert res.json()["detail"] == "unauthorized"


def test_health_and_auth_routes_stay_open(auth_client: TestClient) -> None:
    assert auth_client.get("/api/health").status_code == 200
    assert auth_client.get("/api/auth/state").status_code == 200
    # Logout without a session is harmless.
    assert auth_client.post("/api/auth/logout").json() == {"redirect": None}


def test_login_disabled_without_auth(make_client: Callable[..., TestClient]) -> None:
    client = make_client()
    assert client.post("/api/auth/login", json={"password": "x"}).status_code == 400


def test_websocket_needs_auth(auth_client: TestClient) -> None:
    # The middleware closes before the accept; TestClient surfaces that as a disconnect.
    with pytest.raises(WebSocketDisconnect), auth_client.websocket_connect("/ws"):
        pass


def test_websocket_with_token_query(
    make_client: Callable[..., TestClient],
) -> None:
    client = make_client(auth_password="sesame", alerts_internal_token=TOKEN)
    # Older alerts services connect with the token as a query parameter.
    with client.websocket_connect(f"/ws?auth_token={TOKEN}") as ws:
        ws.send_json({"op": "events", "topics": []})
        assert ws.receive_json() == {"type": "events", "topics": []}
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws?auth_token=wrong"):
        pass


def test_websocket_with_token_header(make_client: Callable[..., TestClient]) -> None:
    """The alerts service sends X-Alerts-Token on the handshake (no secret in the URL)."""
    client = make_client(auth_password="sesame", alerts_internal_token=TOKEN)
    with client.websocket_connect("/ws", headers={"X-Alerts-Token": TOKEN}) as ws:
        ws.send_json({"op": "events", "topics": []})
        assert ws.receive_json() == {"type": "events", "topics": []}
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws", headers={"X-Alerts-Token": "wrong"}),
    ):
        pass
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws"):
        pass


def test_log_redaction_masks_auth_token(caplog: pytest.LogCaptureFixture) -> None:
    install_log_redaction()
    install_log_redaction()  # idempotent
    assert (
        sum(isinstance(f, RedactAuthToken) for f in logging.getLogger("uvicorn.error").filters) == 1
    )
    caplog.set_level(logging.INFO)
    # The two call shapes uvicorn uses: access (args tuple) and websocket accept (%s message).
    logging.getLogger("uvicorn.access").info(
        '%s - "%s %s HTTP/%s" %d',
        "1.2.3.4:5",
        "GET",
        f"/ws?x=1&auth_token={TOKEN}&y=2",
        "1.1",
        101,
    )
    logging.getLogger("uvicorn.error").info(
        '%s - "WebSocket %s" [accepted]', "c", f"/ws?auth_token={TOKEN}"
    )
    logging.getLogger("uvicorn.error").info("no secret here, 100%")
    text = caplog.text
    assert TOKEN not in text
    assert text.count("auth_token=[redacted]") == 2
    assert "x=1&auth_token=[redacted]&y=2" in text
    assert "no secret here, 100%" in text


def test_alerts_service_token_bypass(
    make_client: Callable[..., TestClient],
) -> None:
    """The service authenticates with X-Alerts-Token: reads anywhere plus its write
    routes; user-data writes stay cookie-guarded."""
    client = make_client(auth_password="sesame", alerts_internal_token=TOKEN)
    h = {"X-Alerts-Token": TOKEN}
    assert client.get("/api/alerts", headers=h).status_code == 200
    assert client.get("/api/drawings", headers=h).status_code == 200
    assert (
        client.post("/api/alerts/service/heartbeat", headers=h, json=_heartbeat()).status_code
        == 204
    )
    # Without the token, the same calls need a session cookie.
    assert client.get("/api/alerts").status_code == 401
    assert client.post("/api/alerts/service/heartbeat", json=_heartbeat()).status_code == 401
    # The token does not unlock user-data writes even for its own routes' methods.
    assert client.put("/api/watchlists", headers=h, json=_watchlist()).status_code == 401


def test_login_rate_limit(auth_client: TestClient) -> None:
    for _ in range(4):
        assert auth_client.post("/api/auth/login", json={"password": "nope"}).status_code == 401
    res = auth_client.post("/api/auth/login", json={"password": "nope"})
    assert res.status_code == 429
    assert float(res.headers["retry-after"]) > 0
    # Even the right password is refused during the lockout.
    assert auth_client.post("/api/auth/login", json={"password": "sesame"}).status_code == 429


def test_password_change_signs_sessions_out(
    make_client: Callable[..., TestClient],
) -> None:
    """The session token is bound to the password: an operator rotating
    AUTH_PASSWORD invalidates every existing session at once."""
    old = make_client(auth_password="sesame")
    assert old.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    assert old.get("/api/watchlists").status_code == 200
    rotated = make_client(auth_password="sesame2")
    assert rotated.get("/api/watchlists").status_code == 401


def _heartbeat() -> dict[str, Any]:
    return {
        "version": "test",
        "startedAt": "2026-01-01T00:00:00Z",
        "series": 0,
        "liveSymbols": 0,
        "polledSeries": 0,
        "lastError": None,
    }


def _watchlist() -> dict[str, Any]:
    return {"name": "wl", "symbols": [], "revision": 0, "id": "test-watchlist"}


# ------------------------------------------------- client IP and proxy resolution


def _scope(peer: str, xff: str | None = None, **headers: str) -> dict[str, Any]:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    if xff is not None:
        raw.append((b"x-forwarded-for", xff.encode()))
    return {"type": "http", "client": (peer, 1234), "headers": raw, "scheme": "http"}


def test_login_limiter_keys_ipv6_by_prefix_and_prunes(monkeypatch: pytest.MonkeyPatch) -> None:
    from tickerglass_api import auth

    now = [1000.0]
    monkeypatch.setattr(auth.time, "monotonic", lambda: now[0])
    lim = LoginLimiter()
    # Rotating addresses inside one /64 shares a counter.
    for i in range(4):
        assert lim.record_failure(f"2001:db8:1:2::{i:x}") == 0
    assert lim.record_failure("2001:db8:1:3::1") == 0  # a different /64
    assert lim.record_failure("2001:db8:1:2:ffff::99") > 0  # 5th in the first /64
    assert lim.lockout_remaining("2001:db8:1:2::abcd") > 0
    assert lim.lockout_remaining("2001:db8:1:3::2") == 0
    # IPv4 is exact.
    assert lim.record_failure("192.0.2.1") == 0 and lim.lockout_remaining("192.0.2.2") == 0
    # Stale entries are swept once the table is large; live ones survive.
    lim = LoginLimiter()
    for i in range(LoginLimiter.PRUNE_ABOVE + 1):
        lim.record_failure(f"10.{i >> 16}.{(i >> 8) & 255}.{i & 255}")
    assert len(lim._fails) == LoginLimiter.PRUNE_ABOVE + 1
    now[0] += LOCKOUT_S + 1
    lim.record_failure("203.0.113.9")
    assert len(lim._fails) == 1
    # A partial count also ages out of the window.
    for _ in range(4):
        lim.record_failure("203.0.113.9")
    now[0] += LOCKOUT_S + 1
    assert lim.record_failure("203.0.113.9") == 0


def test_client_ip_ignores_xff_from_untrusted_peer() -> None:
    nets = parse_networks(["10.0.0.0/24"])
    assert client_ip(_scope("198.51.100.7", "1.2.3.4"), nets) == "198.51.100.7"
    assert client_ip(_scope("198.51.100.7", "1.2.3.4"), ()) == "198.51.100.7"
    assert client_ip(_scope("198.51.100.7"), nets) == "198.51.100.7"


def test_client_ip_walks_past_trusted_hops() -> None:
    nets = parse_networks(["10.0.0.0/24", "fd00::/8"])
    assert client_ip(_scope("10.0.0.2", "203.0.113.5"), nets) == "203.0.113.5"
    # A forged leftmost entry is behind the first untrusted hop and never reached.
    assert client_ip(_scope("10.0.0.2", "9.9.9.9, 203.0.113.5, 10.0.0.7"), nets) == "203.0.113.5"
    assert client_ip(_scope("fd00::2", "2001:db8::5"), nets) == "2001:db8::5"
    assert client_ip(_scope("10.0.0.2"), nets) == "10.0.0.2"
    # IPv4-mapped IPv6 peers match IPv4 ranges.
    assert client_ip(_scope("::ffff:10.0.0.2", "203.0.113.5"), nets) == "203.0.113.5"
    # Garbage hops are never trusted.
    assert client_ip(_scope("10.0.0.2", "not-an-ip"), nets) == "not-an-ip"


def test_forwarded_proto_needs_trusted_peer() -> None:
    nets = parse_networks(["10.0.0.2"])
    assert forwarded_proto_https(_scope("10.0.0.2", **{"x-forwarded-proto": "https"}), nets)
    assert not forwarded_proto_https(_scope("198.51.100.7", **{"x-forwarded-proto": "https"}), nets)
    assert not forwarded_proto_https(_scope("10.0.0.2"), nets)


def test_login_limiter_keys_on_client_ip_behind_proxy(
    make_client: Callable[..., TestClient],
) -> None:
    """Behind the bundled nginx one bad actor must not lock everyone out."""
    base = make_client(auth_password="sesame", trusted_proxies="10.0.0.2")
    proxy = TestClient(base.app, client=("10.0.0.2", 1))
    for _ in range(5):
        proxy.post(
            "/api/auth/login", json={"password": "no"}, headers={"X-Forwarded-For": "1.1.1.1"}
        )
    locked = proxy.post(
        "/api/auth/login", json={"password": "sesame"}, headers={"X-Forwarded-For": "1.1.1.1"}
    )
    assert locked.status_code == 429
    other = proxy.post(
        "/api/auth/login", json={"password": "sesame"}, headers={"X-Forwarded-For": "2.2.2.2"}
    )
    assert other.status_code == 204


def test_login_limiter_ignores_spoofed_xff_from_untrusted_peer(
    make_client: Callable[..., TestClient],
) -> None:
    client = make_client(auth_password="sesame")
    for i in range(5):
        client.post(
            "/api/auth/login", json={"password": "no"}, headers={"X-Forwarded-For": f"9.9.9.{i}"}
        )
    res = client.post(
        "/api/auth/login", json={"password": "sesame"}, headers={"X-Forwarded-For": "7.7.7.7"}
    )
    assert res.status_code == 429


# ------------------------------------------------------------ cookie flags


def _set_cookie(res: Any) -> str:
    return str(res.headers["set-cookie"]).lower()


def test_secure_flag_rules(make_client: Callable[..., TestClient]) -> None:
    plain = make_client(auth_password="sesame")
    xfp = {"X-Forwarded-Proto": "https"}
    # X-Forwarded-Proto from an untrusted peer is ignored.
    res = plain.post("/api/auth/login", json={"password": "sesame"}, headers=xfp)
    assert "secure" not in _set_cookie(res)
    behind = make_client(auth_password="sesame", trusted_proxies="10.0.0.2")
    via = TestClient(behind.app, client=("10.0.0.2", 1))
    assert "secure" in _set_cookie(
        via.post("/api/auth/login", json={"password": "sesame"}, headers=xfp)
    )
    # PUBLIC_URL's scheme wins both ways.
    https = make_client(auth_password="sesame", public_url="https://tg.example.com/")
    assert "secure" in _set_cookie(https.post("/api/auth/login", json={"password": "sesame"}))
    http = make_client(
        auth_password="sesame", public_url="http://tg.lan", trusted_proxies="10.0.0.2"
    )
    via_http = TestClient(http.app, client=("10.0.0.2", 1))
    res = via_http.post("/api/auth/login", json={"password": "sesame"}, headers=xfp)
    assert "secure" not in _set_cookie(res)


def test_session_days_setting(make_client: Callable[..., TestClient]) -> None:
    client = make_client(auth_password="sesame", auth_session_days=2)
    res = client.post("/api/auth/login", json={"password": "sesame"})
    assert "max-age=172800" in _set_cookie(res)


# ---------------------------------------------------------------- header mode

NGINX = "10.0.0.2"  # a plain forwarder (TRUSTED_PROXIES)
AUTHELIA = "10.0.0.9"  # the authenticating proxy (AUTH_HEADER_PROXIES)
EVIL = "198.51.100.7"


@pytest.fixture
def header_app(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client(
        auth_trusted_header="Remote-User",
        auth_trusted_email_header="Remote-Email",
        auth_trusted_name_header="Remote-Name",
        auth_trusted_groups_header="Remote-Groups",
        auth_header_proxies=AUTHELIA,
        trusted_proxies=NGINX,
        auth_allow_any_user=True,
    )


def _from(app_client: TestClient, peer: str) -> TestClient:
    return TestClient(app_client.app, client=(peer, 4321))


def test_header_accept_reject_matrix(header_app: TestClient) -> None:
    user = {"Remote-User": "alice"}

    def status(peer: str, headers: dict[str, str]) -> int:
        return _from(header_app, peer).get("/api/watchlists", headers=headers).status_code

    # Straight from the auth proxy.
    assert status(AUTHELIA, user) == 200
    # Through the bundled nginx: it appends the auth proxy's address to the client's.
    assert status(NGINX, {**user, "X-Forwarded-For": f"203.0.113.5, {AUTHELIA}"}) == 200
    # Missing header.
    assert status(AUTHELIA, {}) == 401
    # Empty header.
    assert status(AUTHELIA, {"Remote-User": " "}) == 401
    # Strangers cannot send the header, with or without a forged XFF.
    assert status(EVIL, user) == 401
    assert status(EVIL, {**user, "X-Forwarded-For": AUTHELIA}) == 401
    # Spoof through the bundled nginx: it appends the attacker's real address.
    assert status(NGINX, {**user, "X-Forwarded-For": f"{AUTHELIA}, {EVIL}"}) == 401
    assert status(NGINX, {**user, "X-Forwarded-For": EVIL}) == 401
    # Reaching nginx directly without any XFF from the proxy: nginx peer only.
    assert status(NGINX, user) == 401
    # A forwarder alone does not count as the auth proxy.
    assert status(NGINX, {**user, "X-Forwarded-For": NGINX}) == 401


def test_header_state_and_identity(header_app: TestClient) -> None:
    c = _from(header_app, AUTHELIA)
    headers = {
        "Remote-User": "alice",
        "Remote-Email": "alice@example.com",
        "Remote-Name": "Alice A",
        "Remote-Groups": "admins, family",
    }
    state = c.get("/api/auth/state", headers=headers).json()
    assert state["enabled"] is True and state["authed"] is True
    assert state["methods"] == ["header"]
    assert state["user"] == {
        "id": state["user"]["id"],
        "name": "Alice A",
        "email": "alice@example.com",
        "method": "header",
        "role": "admin",  # a pure-SSO install: the first identity claims the owner account
        "isOwner": True,
    }
    assert state["canManageUsers"] is True and state["localAccounts"] is False
    assert state["logoutAvailable"] is False
    # No cookie is ever set by header mode.
    res = c.get("/api/watchlists", headers=headers)
    assert "set-cookie" not in res.headers
    # Not through the proxy: signed out.
    assert _from(header_app, EVIL).get("/api/auth/state", headers=headers).json()["authed"] is False
    # Name falls back to the username.
    assert c.get("/api/auth/state", headers={"Remote-User": "bob"}).json()["user"]["name"] == "bob"


def test_header_duplicate_username_rejected(header_app: TestClient) -> None:
    c = _from(header_app, AUTHELIA)
    res = c.get("/api/watchlists", headers=[("Remote-User", "alice"), ("Remote-User", "root")])  # type: ignore[arg-type]
    assert res.status_code == 401


def test_header_allow_lists(make_client: Callable[..., TestClient]) -> None:
    app = make_client(
        auth_trusted_header="Remote-User",
        auth_trusted_email_header="Remote-Email",
        auth_trusted_groups_header="Remote-Groups",
        auth_header_proxies=AUTHELIA,
        auth_allowed_users="Alice,bob@example.com",
        auth_allowed_groups="family",
    )
    c = _from(app, AUTHELIA)

    def ok(**h: str) -> bool:
        return c.get("/api/watchlists", headers=h).status_code == 200

    assert ok(**{"Remote-User": "alice", "Remote-Groups": "family"})
    assert ok(
        **{"Remote-User": "x", "Remote-Email": "BOB@example.com", "Remote-Groups": "a,family"}
    )
    assert not ok(**{"Remote-User": "alice"})  # no group
    assert not ok(**{"Remote-User": "alice", "Remote-Groups": "Family"})  # groups are exact
    assert not ok(**{"Remote-User": "mallory", "Remote-Groups": "family"})


def test_header_extras_are_opt_in(make_client: Callable[..., TestClient]) -> None:
    """Only AUTH_TRUSTED_HEADER set: a client-supplied Remote-Groups / Remote-Email is
    ignored, so it cannot satisfy the allow-lists (the proxy never overwrites them)."""
    assert _settings().auth_trusted_groups_header is None
    app = make_client(
        auth_trusted_header="Remote-User",
        auth_header_proxies=AUTHELIA,
        auth_allowed_groups="family",
    )
    c = _from(app, AUTHELIA)
    spoof = {"Remote-User": "mallory", "Remote-Groups": "family", "Remote-Email": "a@b.c"}
    assert c.get("/api/watchlists", headers=spoof).status_code == 401
    app = make_client(
        auth_trusted_header="Remote-User",
        auth_header_proxies=AUTHELIA,
        auth_allowed_users="admin@example.com",
    )
    assert _from(app, AUTHELIA).get("/api/watchlists", headers=spoof).status_code == 401
    ok = {"Remote-User": "admin@example.com", "Remote-Email": "x@y.z"}
    state = _from(app, AUTHELIA).get("/api/auth/state", headers=ok).json()
    assert state["user"]["email"] is None


def test_header_groups_accept_comma_and_pipe(make_client: Callable[..., TestClient]) -> None:
    app = make_client(
        auth_trusted_header="X-authentik-username",
        auth_trusted_groups_header="X-authentik-groups",
        auth_header_proxies=AUTHELIA,
        auth_allowed_groups="family",
    )
    c = _from(app, AUTHELIA)

    def status(groups: str) -> int:
        h = {"X-authentik-username": "alice", "X-authentik-groups": groups}
        return c.get("/api/watchlists", headers=h).status_code

    assert status("admins|family") == 200
    assert status("admins, family") == 200
    assert status("admins|families") == 401


def test_header_websocket(header_app: TestClient) -> None:
    c = _from(header_app, AUTHELIA)
    with c.websocket_connect("/ws", headers={"Remote-User": "alice"}) as ws:
        ws.send_json({"op": "events", "topics": []})
        assert ws.receive_json() == {"type": "events", "topics": []}
    with pytest.raises(WebSocketDisconnect), c.websocket_connect("/ws"):
        pass
    stranger = _from(header_app, EVIL)
    with (
        pytest.raises(WebSocketDisconnect),
        stranger.websocket_connect("/ws", headers={"Remote-User": "alice"}),
    ):
        pass


def test_header_mode_with_cookie_login_and_logout_url(
    make_client: Callable[..., TestClient],
) -> None:
    app = make_client(
        auth_password="sesame",
        auth_trusted_header="Remote-User",
        auth_header_proxies=AUTHELIA,
        auth_logout_url="https://auth.example.com/logout",
        auth_allow_any_user=True,
    )
    c = _from(app, AUTHELIA)
    state = c.get("/api/auth/state", headers={"Remote-User": "alice"}).json()
    assert state["methods"] == ["password", "header"]
    assert state["logoutAvailable"] is True
    assert c.post("/api/auth/logout").json() == {"redirect": "https://auth.example.com/logout"}
    # A refused header user does not fall back to a password cookie.
    assert _from(app, EVIL).get("/api/watchlists").status_code == 401


# ------------------------------------------------------------- settings checks


def _settings(**kw: Any) -> Settings:
    return Settings(_env_file=None, **kw)  # type: ignore[call-arg]


def test_settings_startup_errors() -> None:
    with pytest.raises(ValidationError, match="PUBLIC_URL"):
        _settings(oidc_issuer="https://idp", oidc_client_id="tg")
    with pytest.raises(ValidationError, match="set together"):
        _settings(oidc_issuer="https://idp", public_url="https://tg")
    with pytest.raises(ValidationError, match="AUTH_HEADER_PROXIES"):
        _settings(auth_trusted_header="Remote-User")
    with pytest.raises(ValidationError, match="https"):
        _settings(oidc_issuer="http://idp", oidc_client_id="tg", public_url="https://tg")
    with pytest.raises(ValidationError, match="IP or CIDR"):
        _settings(trusted_proxies="not-an-ip")
    with pytest.raises(ValidationError, match="header name"):
        _settings(auth_trusted_header="Bad Header", auth_header_proxies="10.0.0.1")
    ok = _settings(
        oidc_issuer="http://idp",
        oidc_client_id="tg",
        public_url="http://tg/",
        oidc_allow_http=True,
        auth_allow_any_user=True,
    )
    assert ok.auth_methods == ["oidc"] and ok.public_url == "http://tg"
    assert _settings(trusted_proxies="10.0.0.0/8, ::1").trusted_proxies == ["10.0.0.0/8", "::1"]
    assert _settings(auth_allowed_users=" a , b,,").auth_allowed_users == ["a", "b"]


def test_settings_internal_token_must_be_strong() -> None:
    with pytest.raises(ValidationError, match="at least 32"):
        _settings(alerts_internal_token="short")
    with pytest.raises(ValidationError, match="at least 32"):
        _settings(alerts_internal_token="x" * 31)
    for placeholder in ("CHANGE-ME-long-random-string", "x" * 40 + "change-me", "Change-Me" * 6):
        with pytest.raises(ValidationError, match="CHANGE-ME"):
            _settings(alerts_internal_token=placeholder)
    assert _settings(alerts_internal_token="x" * 32).alerts_internal_token == "x" * 32
    # Unset or blank (compose passes `${ALERTS_INTERNAL_TOKEN:-}`) is fine: no token.
    assert _settings().alerts_internal_token is None
    assert _settings(alerts_internal_token="  ").alerts_internal_token is None


def test_settings_sso_needs_an_allow_list() -> None:
    """OIDC / header sign-in must not default to "any account the IdP / proxy accepts"."""
    oidc = {"oidc_issuer": "https://idp", "oidc_client_id": "tg", "public_url": "https://tg"}
    header = {"auth_trusted_header": "Remote-User", "auth_header_proxies": "10.0.0.9"}
    for mode in (oidc, header):
        with pytest.raises(ValidationError, match="AUTH_ALLOW_ANY_USER=true") as err:
            _settings(**mode)
        for name in ("AUTH_ALLOWED_USERS", "AUTH_ALLOWED_GROUPS", "AUTH_ADMIN_USERS"):
            assert name in str(err.value)
        assert _settings(**mode, auth_allow_any_user=True).auth_allow_any_user
        for lst in ("allowed_users", "allowed_groups", "admin_users", "admin_groups"):
            assert _settings(**mode, **{f"auth_{lst}": "x"})
    # Password-only and open mode are unaffected.
    assert _settings(auth_password="pw").auth_methods == ["password"]
    assert _settings().auth_methods == []


def test_header_allow_any_user_and_admin_only(make_client: Callable[..., TestClient]) -> None:
    base = {
        "auth_trusted_header": "Remote-User",
        "auth_trusted_email_header": "Remote-Email",
        "auth_trusted_groups_header": "Remote-Groups",
        "auth_header_proxies": AUTHELIA,
    }

    def status(app: TestClient, **headers: str) -> int:
        return _from(app, AUTHELIA).get("/api/watchlists", headers=headers).status_code

    anyone = make_client(**base, auth_allow_any_user=True)
    assert status(anyone, **{"Remote-User": "stranger"}) == 200
    # Admin lists alone: admins are implicitly allowed, everyone else is denied.
    admins = make_client(**base, auth_admin_users="Root", auth_admin_groups="ops")
    assert status(admins, **{"Remote-User": "root"}) == 200
    assert status(admins, **{"Remote-User": "x", "Remote-Groups": "ops"}) == 200
    assert status(admins, **{"Remote-User": "x", "Remote-Email": "root"}) == 200
    assert status(admins, **{"Remote-User": "mallory", "Remote-Groups": "family"}) == 401


def test_server_status_lists_methods(make_client: Callable[..., TestClient]) -> None:
    c = make_client(
        auth_trusted_header="Remote-User", auth_header_proxies=AUTHELIA, auth_allow_any_user=True
    )
    body = _from(c, AUTHELIA).get("/api/server/status", headers={"Remote-User": "a"}).json()
    assert body["auth"] == {"enabled": True, "methods": ["header"]}
