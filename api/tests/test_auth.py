"""Optional password auth (auth.py): cookie sessions, the middleware guard, the
alerts-token bypass and the login rate limit. Auth is off unless AUTH_PASSWORD is
set, so every other test module runs against an open app unchanged."""

from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tickerglass_api.auth import make_token, session_secret, verify_token
from tickerglass_api.settings import Settings


@pytest.fixture
def auth_client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client(auth_password="sesame")


def test_token_roundtrip() -> None:
    token = make_token("s3cret", "pw", now=1000.0)
    assert verify_token(token, "s3cret", "pw", now=2000.0)
    assert not verify_token(token, "s3cret", "pw", now=1000.0 + 31 * 86400)
    assert not verify_token(token, "other", "pw", now=2000.0)
    # Changing the password signs existing sessions out.
    assert not verify_token(token, "s3cret", "new-pw", now=2000.0)
    assert not verify_token("garbage", "s3cret", "pw")
    assert not verify_token(None, "s3cret", "pw")


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
    assert res.json() == {"enabled": True, "authed": False}


def test_open_app_when_auth_unset(make_client: Callable[..., TestClient]) -> None:
    client = make_client()
    res = client.get("/api/auth/state")
    assert res.json() == {"enabled": False, "authed": False}
    assert client.get("/api/watchlists").status_code == 200


def test_login_flow(auth_client: TestClient) -> None:
    assert auth_client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    res = auth_client.post("/api/auth/login", json={"password": "sesame"})
    assert res.status_code == 204
    assert "tickerglass_session" in res.headers["set-cookie"]
    # TestClient keeps cookies: the guarded routes work now.
    assert auth_client.get("/api/watchlists").status_code == 200
    assert auth_client.get("/api/auth/state").json()["authed"] is True
    assert auth_client.post("/api/auth/logout").status_code == 204
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
    # Logout without a session is a harmless 204.
    assert auth_client.post("/api/auth/logout").status_code == 204


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
    client = make_client(auth_password="sesame", alerts_internal_token="tok-1")
    # The alerts service connects with the token as a query parameter.
    with client.websocket_connect("/ws?auth_token=tok-1") as ws:
        ws.send_json({"op": "events", "topics": []})
        assert ws.receive_json() == {"type": "events", "topics": []}
    with pytest.raises(WebSocketDisconnect), client.websocket_connect("/ws?auth_token=wrong"):
        pass


def test_alerts_service_token_bypass(
    make_client: Callable[..., TestClient],
) -> None:
    """The service authenticates with X-Alerts-Token: reads anywhere plus its write
    routes; user-data writes stay cookie-guarded."""
    client = make_client(auth_password="sesame", alerts_internal_token="tok-1")
    h = {"X-Alerts-Token": "tok-1"}
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
