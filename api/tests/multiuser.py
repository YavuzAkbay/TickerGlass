"""Test helper: act as several users against one app.

No identity injection exists at runtime. The helper drives the real flows: the bootstrap
password signs in as the owner (an admin), who creates local accounts through `POST
/api/users`; each user is a separate `TestClient` on the same app with its own cookie jar.
`Multi.root` is the one client that runs the app's lifespan (the live hub's loop); WebSocket
tests connect through it, passing a user's cookie explicitly.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session, sessionmaker

PASSWORD = "sesame"
USER_PASSWORD = "correct horse battery"


@dataclass
class Multi:
    root: TestClient
    owner: TestClient
    users: dict[str, TestClient] = field(default_factory=dict)
    ids: dict[str, str] = field(default_factory=dict)

    def new_client(self) -> TestClient:
        return TestClient(self.root.app)

    def create(self, username: str, role: str = "user") -> TestClient:
        """A local account (made by the owner) and a signed-in client for it."""
        res = self.owner.post(
            "/api/users",
            json={
                "username": username,
                "name": username.title(),
                "password": USER_PASSWORD,
                "role": role,
            },
        )
        assert res.status_code == 201, res.text
        self.ids[username] = res.json()["id"]
        client = self.new_client()
        login = client.post(
            "/api/auth/login", json={"username": username, "password": USER_PASSWORD}
        )
        assert login.status_code == 204, login.text
        self.users[username] = client
        return client

    @property
    def alice(self) -> TestClient:
        return self.users["alice"]

    @property
    def bob(self) -> TestClient:
        return self.users["bob"]

    @staticmethod
    def cookie_header(client: TestClient) -> dict[str, str]:
        """The client's cookies as a request header (for `websocket_connect(headers=...)`)."""
        return {"cookie": "; ".join(f"{k}={v}" for k, v in client.cookies.items())}


def _build(make_client: Callable[..., TestClient], **settings: str) -> Multi:
    root = make_client(auth_password=PASSWORD, **settings)
    owner = TestClient(root.app)
    assert owner.post("/api/auth/login", json={"password": PASSWORD}).status_code == 204
    m = Multi(root=root, owner=owner)
    m.create("alice")
    m.create("bob")
    return m


@pytest.fixture
def multi(make_client: Callable[..., TestClient]) -> Multi:
    """Password auth with the owner (admin) signed in, plus `alice` and `bob` (plain users)."""
    return _build(make_client, alerts_internal_token="svc-token-0123456789abcdef0123456789abcdef")


@pytest.fixture
def multi_no_token(make_client: Callable[..., TestClient]) -> Multi:
    """The same without `ALERTS_INTERNAL_TOKEN`: no request can be the alerts service."""
    return _build(make_client)


# ------------------------------------------- tests that write rows behind the API's back


def owner_id(engine: Engine) -> str:
    """The owner user the migration created (rows written directly must name an owner)."""
    with engine.connect() as conn:
        value = conn.execute(text("SELECT value FROM app_meta WHERE key = 'owner_user_id'"))
        return str(json.loads(value.scalar_one()))


def system_maker(engine: Engine) -> sessionmaker[Session]:
    """Sessions that see every owner's rows, like the background jobs' (`ownership.py`)."""
    return sessionmaker(engine, expire_on_commit=False, info={"all_owners": True})


def system_session(engine: Engine) -> Session:
    return system_maker(engine)()
