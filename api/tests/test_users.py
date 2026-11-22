"""Multi-user (docs/design/multi-user.md): passwords, sign-in, the users API and its guards,
owner claim and auto-provisioning, and isolation between two users over HTTP and `/ws`."""

import json
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from multiuser import PASSWORD, USER_PASSWORD, Multi
from starlette.websockets import WebSocketDisconnect
from test_auth_oidc import error_of, signin
from test_userdata import STATE, engine_of

from tickerglass_api import models as m
from tickerglass_api.passwords import (
    burn_verify,
    check_strength,
    hash_password,
    verify_password,
)

SPEC = {
    "schemaVersion": 1,
    "left": {"kind": "price", "field": "close"},
    "condition": {"op": "crossing", "right": {"kind": "value", "value": 190}},
    "trigger": "oncePerBar",
}


def alert_body(**kw: Any) -> dict[str, Any]:
    return {"name": "AAPL > 190", "symbol": "AAPL", "interval": "1D", "spec": SPEC, **kw}


# ----------------------------------------------------------------- passwords


def test_password_hash_format_and_verify() -> None:
    stored = hash_password("correct horse battery")
    kind, n, r, p, salt, digest = stored.split("$")
    assert (kind, n, r, p) == ("scrypt", str(2**14), "8", "1")
    assert len(salt) >= 20 and len(digest) >= 40
    assert verify_password(stored, "correct horse battery")
    assert not verify_password(stored, "correct horse batterz")
    assert not verify_password(stored, "")
    assert hash_password("correct horse battery") != stored  # random salt


def test_password_rules_and_malformed_hashes() -> None:
    with pytest.raises(ValueError):
        hash_password("short")
    with pytest.raises(ValueError):
        check_strength("x" * 2000)
    stored = hash_password("correct horse battery")
    for bad in (
        None,
        "",
        "plain",
        "scrypt$1$2$3",
        "scrypt$x$8$1$AAAA$AAAA",
        stored.replace("$16384$", "$3$"),  # not a power of two
        stored.replace("$16384$", f"${2**30}$"),  # would allocate gigabytes
        stored + "$extra",
    ):
        assert not verify_password(bad, "correct horse battery")
    burn_verify("anything")  # unknown usernames cost the same time; must not raise


# -------------------------------------------------------------------- sign-in


def test_bootstrap_password_is_the_owner(make_client: Callable[..., TestClient]) -> None:
    root = make_client(auth_password=PASSWORD)
    owner_id = root.app.state.accounts.owner_id()
    for username in (None, "", "admin", " ADMIN "):
        c = TestClient(root.app)
        body: dict[str, Any] = {"password": PASSWORD}
        if username is not None:
            body["username"] = username
        assert c.post("/api/auth/login", json=body).status_code == 204, username
        state = c.get("/api/auth/state").json()
        assert state["user"]["id"] == owner_id and state["user"]["role"] == "admin"
        assert state["canManageUsers"] is True and state["localAccounts"] is True
        assert state["user"]["method"] == "password"


def test_local_account_login(multi: Multi) -> None:
    state = multi.alice.get("/api/auth/state").json()
    assert state["authed"] is True and state["user"]["role"] == "user"
    assert state["user"]["id"] == multi.ids["alice"] and state["canManageUsers"] is False
    assert multi.alice.get("/api/me").json()["local"] is True
    # Usernames are case-insensitive; the bootstrap password is not alice's.
    c = multi.new_client()
    ok = c.post("/api/auth/login", json={"username": "ALICE", "password": USER_PASSWORD})
    assert ok.status_code == 204
    wrong = {"username": "alice", "password": PASSWORD}
    assert multi.new_client().post("/api/auth/login", json=wrong).status_code == 401


def test_unknown_user_and_wrong_password_look_the_same(multi: Multi) -> None:
    a = multi.new_client().post(
        "/api/auth/login", json={"username": "alice", "password": "nope-nope-nope"}
    )
    b = multi.new_client().post(
        "/api/auth/login", json={"username": "ghost", "password": "nope-nope-nope"}
    )
    assert (
        (a.status_code, a.json())
        == (b.status_code, b.json())
        == (401, {"detail": "wrong password"})
    )


def test_login_lockout_is_per_client_and_username_never_global(
    make_client: Callable[..., TestClient],
) -> None:
    base = make_client(auth_password=PASSWORD, trusted_proxies="10.0.0.2")
    owner = TestClient(base.app)
    owner.post("/api/auth/login", json={"password": PASSWORD})
    for name in ("alice", "bob"):
        owner.post(
            "/api/users",
            json={"username": name, "name": name, "password": USER_PASSWORD, "role": "user"},
        )
    proxy = TestClient(base.app, client=("10.0.0.2", 1))

    def attempt(ip: str, username: str, password: str) -> int:
        res = proxy.post(
            "/api/auth/login",
            json={"username": username, "password": password},
            headers={"X-Forwarded-For": ip},
        )
        return res.status_code

    # Ten wrong guesses at alice from address A lock A out ...
    for i in range(10):
        assert attempt("1.1.1.1", "alice", "wrong-wrong-wrong") == (401 if i < 4 else 429)
    assert attempt("1.1.1.1", "alice", USER_PASSWORD) == 429
    # ... but never alice (or the owner) for anyone else, so nobody can lock a name from afar.
    assert attempt("2.2.2.2", "alice", USER_PASSWORD) == 204
    assert attempt("2.2.2.2", "admin", PASSWORD) == 204
    # Guesses spread over many addresses lock none of them (bounded by scrypt and per-IP limits).
    for i in range(20):
        assert attempt(f"5.5.5.{i}", "alice", "wrong-wrong-wrong") == 401
    assert attempt("6.6.6.6", "alice", USER_PASSWORD) == 204
    # Signing in as someone else does not reset the count against one username.
    for _ in range(4):
        assert attempt("4.4.4.4", "alice", "wrong-wrong-wrong") == 401
    assert attempt("4.4.4.4", "bob", USER_PASSWORD) == 204  # clears the per-IP counter only
    assert attempt("4.4.4.4", "alice", "wrong-wrong-wrong") == 429  # the 5th for (4.4.4.4, alice)
    # Five wrong guesses from one address lock that address, whatever the username.
    for i in range(4):
        assert attempt("3.3.3.3", f"ghost{i}", "wrong-wrong-wrong") == 401
    assert attempt("3.3.3.3", "ghost4", "wrong-wrong-wrong") == 429
    assert attempt("3.3.3.3", "admin", PASSWORD) == 429


def test_password_change_limit_is_per_signed_in_user(multi: Multi) -> None:
    bad = {"current": "nope-nope-nope", "new": "n" * 12}
    codes = [multi.alice.put("/api/me/password", json=bad).status_code for _ in range(10)]
    assert codes[:9] == [401] * 9 and codes[9] == 401  # the tenth failure trips the lock ...
    assert multi.alice.put("/api/me/password", json=bad).status_code == 429
    # ... for alice only: bob (and logging in as alice elsewhere) is unaffected.
    assert multi.bob.put("/api/me/password", json=bad).status_code == 401
    other = multi.new_client()
    login = other.post("/api/auth/login", json={"username": "alice", "password": USER_PASSWORD})
    assert login.status_code == 204


def test_local_accounts_need_the_password_method(
    make_client: Callable[..., TestClient],
) -> None:
    client = make_client()  # open mode: just the owner
    assert [u["role"] for u in client.get("/api/users").json()] == ["admin"]
    res = client.post(
        "/api/users",
        json={"username": "x", "name": "X", "password": USER_PASSWORD, "role": "user"},
    )
    assert res.status_code == 400
    assert client.post("/api/auth/login", json={"password": "x"}).status_code == 400


def test_open_mode_is_the_owner_user(make_client: Callable[..., TestClient]) -> None:
    client = make_client()
    me = client.get("/api/me").json()
    assert me["id"] == client.app.state.accounts.owner_id() and me["role"] == "admin"
    assert me["method"] == "open"
    assert client.post("/api/watchlists", json={"name": "W", "items": []}).status_code == 201


def test_session_without_user_is_rejected(multi: Multi) -> None:
    """Cookies of the previous (user-less) v2 format sign in again, instead of guessing a user."""
    from tickerglass_api.auth import make_session, password_tag

    app = multi.root.app
    secret = app.state.auth_secret
    token = make_session(
        secret,
        sub="admin",
        name="Password user",
        email=None,
        method="password",
        ttl_s=100,
        tag=password_tag(secret, PASSWORD),
    )
    c = multi.new_client()
    c.cookies.set("tickerglass_session", token)
    assert c.get("/api/watchlists").status_code == 401


def test_disabled_user_is_cut_off_at_once(multi: Multi) -> None:
    assert multi.alice.get("/api/watchlists").status_code == 200
    res = multi.owner.patch(f"/api/users/{multi.ids['alice']}", json={"disabled": True})
    assert res.status_code == 200 and res.json()["disabled"] is True
    assert multi.alice.get("/api/watchlists").status_code == 401
    assert multi.alice.get("/api/auth/state").json()["authed"] is False
    login = multi.new_client().post(
        "/api/auth/login", json={"username": "alice", "password": USER_PASSWORD}
    )
    assert login.status_code == 401 and login.json()["detail"] == "account disabled"
    multi.owner.patch(f"/api/users/{multi.ids['alice']}", json={"disabled": False})
    assert multi.alice.get("/api/watchlists").status_code == 200


def test_password_change_ends_other_sessions_but_keeps_this_one(multi: Multi) -> None:
    other = multi.new_client()
    other.post("/api/auth/login", json={"username": "alice", "password": USER_PASSWORD})
    assert other.get("/api/watchlists").status_code == 200
    bad = multi.alice.put("/api/me/password", json={"current": "nope-nope-nope", "new": "n" * 12})
    assert bad.status_code == 401
    short = multi.alice.put("/api/me/password", json={"current": USER_PASSWORD, "new": "short"})
    assert short.status_code == 422
    ok = multi.alice.put("/api/me/password", json={"current": USER_PASSWORD, "new": "n" * 12})
    assert ok.status_code == 204
    assert multi.alice.get("/api/watchlists").status_code == 200  # fresh cookie in the response
    assert other.get("/api/watchlists").status_code == 401
    relogin = multi.new_client().post(
        "/api/auth/login", json={"username": "alice", "password": "n" * 12}
    )
    assert relogin.status_code == 204


def test_admin_password_reset_ends_the_users_sessions(multi: Multi) -> None:
    uid = multi.ids["bob"]
    res = multi.owner.put(f"/api/users/{uid}/password", json={"new": "reset-password-1"})
    assert res.status_code == 204
    assert multi.bob.get("/api/watchlists").status_code == 401
    ok = multi.new_client().post(
        "/api/auth/login", json={"username": "bob", "password": "reset-password-1"}
    )
    assert ok.status_code == 204
    # The owner signs in with AUTH_PASSWORD: there is nothing to reset.
    owner_id = multi.root.app.state.accounts.owner_id()
    assert (
        multi.owner.put(f"/api/users/{owner_id}/password", json={"new": "x" * 12}).status_code
        == 400
    )


def test_me_endpoints(multi: Multi) -> None:
    me = multi.alice.get("/api/me").json()
    assert me["name"] == "Alice" and me["role"] == "user" and me["canManageUsers"] is False
    assert multi.alice.patch("/api/me", json={"name": "  Alice B  "}).json()["name"] == "Alice B"
    assert multi.alice.patch("/api/me", json={"role": "admin"}).status_code == 422  # extra field
    assert multi.alice.get("/api/me").json()["name"] == "Alice B"
    # The bootstrap account has no password of its own to change.
    res = multi.owner.put("/api/me/password", json={"current": PASSWORD, "new": "x" * 12})
    assert res.status_code == 400


def test_service_token_is_not_a_user(multi: Multi) -> None:
    res = multi.new_client().get(
        "/api/me", headers={"X-Alerts-Token": "svc-token-0123456789abcdef0123456789abcdef"}
    )
    assert res.status_code == 403
    assert multi.new_client().get("/api/me").status_code == 401


# --------------------------------------------------------------- users admin


def test_user_management_and_secrets(multi: Multi) -> None:
    listing = multi.owner.get("/api/users").json()
    assert {u["name"] for u in listing} == {"Owner", "Alice", "Bob"}
    assert "passwordHash" not in json.dumps(listing) and "scrypt" not in json.dumps(listing)
    alice = next(u for u in listing if u["name"] == "Alice")
    assert alice["methods"] == ["password"] and alice["local"] is True
    owner = next(u for u in listing if u["name"] == "Owner")
    assert owner["methods"] == ["password"] and owner["local"] is False and owner["role"] == "admin"

    base = {"name": "Dup", "password": USER_PASSWORD, "role": "user"}
    assert multi.owner.post("/api/users", json={"username": "ALICE", **base}).status_code == 409
    assert multi.owner.post("/api/users", json={"username": "admin", **base}).status_code == 422
    assert multi.owner.post("/api/users", json={"username": "a b", **base}).status_code == 422
    short = {"username": "carol", "name": "C", "password": "short", "role": "user"}
    assert multi.owner.post("/api/users", json=short).status_code == 422
    role = {"username": "carol", "name": "C", "password": USER_PASSWORD, "role": "root"}
    assert multi.owner.post("/api/users", json=role).status_code == 422
    assert multi.owner.patch("/api/users/nope", json={"name": "x"}).status_code == 404

    res = multi.owner.patch(
        f"/api/users/{multi.ids['bob']}", json={"name": "Robert", "role": "admin"}
    )
    assert res.status_code == 200 and res.json()["role"] == "admin"
    assert multi.bob.get("/api/me").json()["role"] == "admin"  # the user row is the authority


def test_last_admin_and_self_protection(multi: Multi) -> None:
    owner_id = multi.root.app.state.accounts.owner_id()
    # The owner is the only admin.
    assert multi.owner.patch(f"/api/users/{owner_id}", json={"role": "user"}).status_code == 409
    assert multi.owner.patch(f"/api/users/{owner_id}", json={"disabled": True}).status_code == 409
    assert multi.owner.delete(f"/api/users/{owner_id}").status_code == 409
    # A second admin: still not allowed to demote / disable / delete yourself.
    multi.create("boss", role="admin")
    boss = multi.users["boss"]
    boss_id = multi.ids["boss"]
    assert boss.patch(f"/api/users/{boss_id}", json={"role": "user"}).status_code == 409
    assert boss.patch(f"/api/users/{boss_id}", json={"disabled": True}).status_code == 409
    assert boss.delete(f"/api/users/{boss_id}").status_code == 409
    # The owner account itself cannot be deleted, even by another admin.
    assert boss.delete(f"/api/users/{owner_id}").status_code == 409
    # Demoting the owner is fine while another enabled admin remains, and then the last
    # admin (boss) cannot be demoted by anyone.
    assert boss.patch(f"/api/users/{owner_id}", json={"role": "user"}).status_code == 200
    assert multi.owner.patch(f"/api/users/{boss_id}", json={"role": "user"}).status_code == 403
    only = multi.new_client()
    only.cookies.update(boss.cookies)
    assert only.patch(f"/api/users/{boss_id}", json={"role": "user"}).status_code == 409
    # A disabled admin does not count: with boss disabled the owner (now a user) is nothing.
    assert multi.owner.get("/api/users").status_code == 403


def test_delete_user_removes_their_data(multi: Multi) -> None:
    assert multi.alice.post("/api/watchlists", json={"name": "A", "items": []}).status_code == 201
    assert multi.alice.put("/api/settings/theme", json={"value": "dark"}).status_code == 204
    assert multi.bob.post("/api/watchlists", json={"name": "B", "items": []}).status_code == 201
    uid = multi.ids["alice"]
    assert multi.owner.delete(f"/api/users/{uid}").status_code == 204
    assert multi.alice.get("/api/watchlists").status_code == 401
    with engine_of(multi.root).connect() as conn:
        names = conn.exec_driver_sql("SELECT name FROM watchlists").scalars().all()
        assert names == ["B"]
        assert conn.exec_driver_sql("SELECT count(*) FROM settings").scalar() == 0
        left = conn.exec_driver_sql(f"SELECT count(*) FROM user_identities WHERE user_id = '{uid}'")
        assert left.scalar() == 0
    assert multi.owner.delete(f"/api/users/{uid}").status_code == 404


# ---------------------------------------------------------------- admin guards


ADMIN_ONLY: list[tuple[str, str, dict[str, Any] | None]] = [
    ("GET", "/api/users", None),
    (
        "POST",
        "/api/users",
        {"username": "x", "name": "X", "password": USER_PASSWORD, "role": "user"},
    ),
    ("PATCH", "/api/users/anything", {"name": "X"}),
    ("PUT", "/api/users/anything/password", {"new": "x" * 12}),
    ("DELETE", "/api/users/anything", None),
    ("POST", "/api/server/cache/clear", None),
    ("GET", "/api/server/backup", None),
    ("POST", "/api/providers/active", {"id": "demo"}),
    ("POST", "/api/providers/test", None),
    ("POST", "/api/screener/runs", {"kind": "snapshot"}),
]


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_ONLY)
def test_admin_guards(multi: Multi, method: str, path: str, body: dict[str, Any] | None) -> None:
    res = multi.alice.request(method, path, json=body)
    assert res.status_code == 403, (path, res.text)
    assert multi.new_client().request(method, path, json=body).status_code == 401


def test_shared_screener_lists_are_admin_managed(multi: Multi) -> None:
    from tickerglass_api.services.screener import universe as uv

    bundled = next(iter(uv.bundle().lists))
    body = {"name": "Mine", "asOf": "2026-01", "symbols": ["AAPL"]}
    assert multi.alice.put(f"/api/screener/lists/{bundled}", json=body).status_code == 403
    assert multi.alice.delete(f"/api/screener/lists/{bundled}").status_code == 403
    # A custom list is the user's own; nobody else sees it.
    assert multi.alice.put("/api/screener/lists/alices", json=body).status_code == 200
    assert "alices" in {x["id"] for x in multi.alice.get("/api/screener/lists").json()}
    assert "alices" not in {x["id"] for x in multi.bob.get("/api/screener/lists").json()}
    assert bundled in {x["id"] for x in multi.bob.get("/api/screener/lists").json()}
    assert multi.bob.delete("/api/screener/lists/alices").status_code == 404
    # The admin overrides a shared one; everybody sees the override.
    assert multi.owner.put(f"/api/screener/lists/{bundled}", json=body).status_code == 200
    seen = {x["id"]: x for x in multi.bob.get("/api/screener/lists").json()}
    assert seen[bundled]["name"] == "Mine" and seen[bundled]["source"] == "upload"


def test_server_status_is_reduced_for_users(multi: Multi) -> None:
    full = multi.owner.get("/api/server/status").json()
    assert {"counts", "database", "alertsService", "uptimeSeconds"} <= set(full)
    reduced = multi.alice.get("/api/server/status").json()
    assert set(reduced) == {"version", "provider", "auth"}
    assert set(reduced["provider"]) == {"id", "name"}
    assert multi.alice.get("/api/providers/usage").status_code == 200
    assert multi.alice.get("/api/cache/stats").status_code == 200


# ------------------------------------------- owner claim and auto-provisioning

HEADER = {
    "auth_trusted_header": "Remote-User",
    "auth_trusted_groups_header": "Remote-Groups",
    "auth_header_proxies": "10.0.0.2",
}


def header_client(
    make_client: Callable[..., TestClient], **settings: Any
) -> tuple[TestClient, Callable[..., TestClient]]:
    # Header mode refuses to start without an allow-list: these tests are about accounts, so
    # open to every account unless a test sets AUTH_ALLOWED_* / AUTH_ALLOW_ANY_USER itself.
    lists = ("auth_allowed_users", "auth_allowed_groups", "auth_allow_any_user")
    open_ = {} if any(k in settings for k in lists) else {"auth_allow_any_user": True}
    base = make_client(**{**HEADER, **open_, **settings})

    def as_user(name: str, groups: str | None = None, email: str | None = None) -> TestClient:
        # Bytes: a proxy sends UTF-8, which httpx's str headers (ASCII) cannot carry.
        headers: dict[str, Any] = {"Remote-User": name.encode()}
        if groups is not None:
            headers["Remote-Groups"] = groups
        if email is not None:
            headers["Remote-Email"] = email.encode()
        c = TestClient(base.app, client=("10.0.0.2", 1), headers=headers)
        base.app.state.accounts.invalidate()  # identity lookups are cached for a few seconds
        return c

    return base, as_user


def test_first_sso_identity_claims_the_owner_on_a_pure_sso_install(
    make_client: Callable[..., TestClient],
) -> None:
    base, as_user = header_client(make_client)
    owner_id = base.app.state.accounts.owner_id()
    first = as_user("Alice").get("/api/me").json()
    assert first["id"] == owner_id and first["role"] == "admin" and first["name"] == "Alice"
    second = as_user("bob").get("/api/me").json()
    assert second["id"] != owner_id and second["role"] == "user"
    # The owner now has an SSO identity: nobody else can claim it.
    assert as_user("carol").get("/api/me").json()["id"] not in (owner_id, second["id"])
    # Lowercased identity key: the same person.
    assert as_user("ALICE").get("/api/me").json()["id"] == owner_id


def test_admin_lists_decide_who_claims_the_owner(
    make_client: Callable[..., TestClient],
) -> None:
    base, as_user = header_client(make_client, auth_admin_users="boss")
    owner_id = base.app.state.accounts.owner_id()
    alice = as_user("alice").get("/api/me").json()
    assert alice["id"] != owner_id and alice["role"] == "user"
    boss = as_user("Boss").get("/api/me").json()
    assert boss["id"] == owner_id and boss["role"] == "admin"


def test_admin_groups_provision_and_promote_but_never_demote(
    make_client: Callable[..., TestClient],
) -> None:
    base, as_user = header_client(
        make_client, auth_admin_groups="admins", auth_admin_users="someone-else"
    )
    owner_id = base.app.state.accounts.owner_id()
    # Not on a list: a plain user (and the owner stays unclaimed).
    carol = as_user("carol", "family").get("/api/me").json()
    assert carol["role"] == "user" and carol["id"] != owner_id
    # Signing in with a matching group promotes ...
    promoted = as_user("carol", "family, admins").get("/api/me").json()
    assert promoted["id"] == carol["id"] and promoted["role"] == "admin"
    # ... the first admin-list match claims the (still unclaimed) owner account, any later
    # one gets an account of its own, created as an admin ...
    dave = as_user("dave", "admins").get("/api/me").json()
    assert dave["role"] == "admin" and dave["id"] == owner_id
    erin = as_user("erin", "admins").get("/api/me").json()
    assert erin["role"] == "admin" and erin["id"] not in (owner_id, carol["id"])
    # ... but losing the group never demotes (admins demote in the UI).
    assert as_user("carol", "family").get("/api/me").json()["role"] == "admin"


def test_no_implicit_claim_when_the_password_method_owns_the_account(
    make_client: Callable[..., TestClient],
) -> None:
    base, as_user = header_client(make_client, auth_password=PASSWORD)
    owner_id = base.app.state.accounts.owner_id()
    me = as_user("alice").get("/api/me").json()
    assert me["id"] != owner_id and me["role"] == "user"


def test_auto_provision_off_denies_unknown_identities(
    make_client: Callable[..., TestClient],
) -> None:
    base, as_user = header_client(make_client, auth_auto_provision="false")
    # No admin lists: the implicit claim is a form of provisioning, so it is denied too.
    assert as_user("alice").get("/api/me").status_code == 401
    assert as_user("alice").get("/api/watchlists").status_code == 401
    assert base.app.state.accounts.owner_id()  # and nothing was created
    with engine_of(base).connect() as conn:
        assert conn.exec_driver_sql("SELECT count(*) FROM users").scalar() == 1
    # An explicit admin list still lets that admin claim the owner account.
    base2, as_user2 = header_client(
        make_client, auth_auto_provision="false", auth_admin_users="boss"
    )
    assert as_user2("alice").get("/api/me").status_code == 401
    boss = as_user2("boss").get("/api/me")
    assert boss.status_code == 200 and boss.json()["role"] == "admin"
    assert as_user2("other").get("/api/me").status_code == 401


def test_disabled_header_user_is_refused(make_client: Callable[..., TestClient]) -> None:
    base, as_user = header_client(make_client, auth_admin_users="boss")
    boss = as_user("boss")
    uid = as_user("alice").get("/api/me").json()["id"]
    assert boss.patch(f"/api/users/{uid}", json={"disabled": True}).status_code == 200
    assert as_user("alice").get("/api/me").status_code == 401
    assert boss.get("/api/me").status_code == 200


def test_header_names_cannot_collide_through_unicode(
    make_client: Callable[..., TestClient],
) -> None:
    base, as_user = header_client(make_client, auth_admin_users="kate")
    owner_id = base.app.state.accounts.owner_id()
    kate = as_user("kate").get("/api/me").json()
    assert kate["id"] == owner_id and kate["role"] == "admin"
    # U+212A KELVIN SIGN + "ate" folds to "kate" under NFKC: refused, not merged (or promoted).
    assert as_user("\u212aate").get("/api/me").status_code == 401
    # Full-width letters, a control character and a no-break space: refused too.
    for name in ("\uff4bate", "ka\x07te", "kate\u00a0x", "ka\u200bte"):
        assert as_user(name).get("/api/me").status_code == 401, repr(name)
    # Case variants are the same person; no other account came into being.
    assert as_user("KATE").get("/api/me").json()["id"] == owner_id
    with engine_of(base).connect() as conn:
        assert conn.exec_driver_sql("SELECT count(*) FROM users").scalar() == 1


def test_identity_key_and_list_matching_fold_names() -> None:
    from tickerglass_api.accounts import fold_name, identity_key, norm_names
    from tickerglass_api.auth import Identity
    from tickerglass_api.settings import Settings

    settings = Settings()
    assert identity_key(settings, Identity("KATE", "k", None, (), "header")) == "header:kate"
    assert identity_key(settings, Identity("\u212aate", "k", None, (), "header")) is None
    assert fold_name("\u212aate") == "kate"  # lenient (operator-typed lists)
    assert fold_name("\u212aate", strict=True) is None  # strict (client-sent)
    assert norm_names(["Kate@Example.com", "\u212aate@example.com"], strict=True) == {
        "kate@example.com"
    }


def test_admin_list_ignores_look_alike_emails(make_client: Callable[..., TestClient]) -> None:
    base, as_user = header_client(
        make_client, auth_admin_users="kate@example.com", auth_trusted_email_header="Remote-Email"
    )
    owner_id = base.app.state.accounts.owner_id()
    me = as_user("someone", email="\u212aate@example.com").get("/api/me").json()
    assert me["role"] == "user" and me["id"] != owner_id
    assert as_user("kate2", email="Kate@Example.com").get("/api/me").json()["role"] == "admin"


def test_oidc_claims_the_owner_then_provisions(
    make_oidc: Callable[..., TestClient], idp: Any
) -> None:
    client = make_oidc()
    owner_id = client.app.state.accounts.owner_id()
    assert signin(client, idp).status_code == 302
    me = client.get("/api/me").json()
    assert me["id"] == owner_id and me["role"] == "admin" and me["name"] == "Alice Example"
    other = TestClient(client.app, base_url="https://testserver", follow_redirects=False)
    assert signin(other, idp, sub="user-2", preferred_username="bob").status_code == 302
    bob = other.get("/api/me").json()
    assert bob["id"] != owner_id and bob["role"] == "user"
    assert other.get("/api/users").status_code == 403


def test_oidc_admin_list_matches_sub_or_verified_email_not_preferred_username(
    make_oidc: Callable[..., TestClient], idp: Any
) -> None:
    # `preferred_username` ("alice") may be user-editable at the IdP: never an admin match.
    client = make_oidc(auth_admin_users="alice")
    assert signin(client, idp).status_code == 302
    me = client.get("/api/me").json()
    assert me["role"] == "user" and me["id"] != client.app.state.accounts.owner_id()
    # The immutable sub matches ...
    client = make_oidc(auth_admin_users="user-1")
    assert signin(client, idp).status_code == 302
    assert client.get("/api/me").json()["role"] == "admin"
    # ... and so does a verified email, but not an unverified one.
    client = make_oidc(auth_admin_users="alice@example.com")
    assert signin(client, idp, email_verified=False).status_code == 302
    assert client.get("/api/me").json()["role"] == "user"
    client = make_oidc(auth_admin_users="alice@example.com")
    assert signin(client, idp).status_code == 302
    assert client.get("/api/me").json()["role"] == "admin"
    # The sign-in allow-list still accepts preferred_username (unchanged from 2.1).
    client = make_oidc(auth_allowed_users="alice")
    assert signin(client, idp).headers["location"] == "/"


def test_oidc_auto_provision_off_is_oidc_denied(
    make_oidc: Callable[..., TestClient], idp: Any
) -> None:
    client = make_oidc(auth_auto_provision="false")
    assert error_of(signin(client, idp)) == "oidc_denied"
    assert client.get("/api/watchlists").status_code == 401
    # The admin list still opens the owner account to its admin.
    client = make_oidc(auth_auto_provision="false", auth_admin_users="user-1")
    assert signin(client, idp).headers["location"] == "/"
    assert client.get("/api/me").json()["role"] == "admin"


def test_oidc_session_dies_with_the_account(make_oidc: Callable[..., TestClient], idp: Any) -> None:
    client = make_oidc(auth_admin_users="admin-person")
    assert signin(client, idp, sub="u1", preferred_username="x").status_code == 302
    assert client.get("/api/watchlists").status_code == 200
    uid = client.get("/api/me").json()["id"]
    with engine_of(client).begin() as conn:
        conn.exec_driver_sql(f"UPDATE users SET disabled = 1 WHERE id = '{uid}'")
    client.app.state.accounts.invalidate()
    assert client.get("/api/watchlists").status_code == 401
    # The claim went to the owner only when it matched an admin list: this user is new.
    assert uid != client.app.state.accounts.owner_id()


# ----------------------------------------------------------------- isolation


def test_watchlists_are_private(multi: Multi) -> None:
    created = multi.alice.post("/api/watchlists", json={"name": "Mine", "items": []})
    wid = created.json()["id"]
    assert [w["id"] for w in multi.alice.get("/api/watchlists").json()] == [wid]
    assert multi.bob.get("/api/watchlists").json() == []
    assert multi.bob.get(f"/api/watchlists/{wid}").status_code == 404
    put = multi.bob.put(f"/api/watchlists/{wid}", json={"name": "x", "items": [], "revision": 1})
    assert put.status_code == 404
    assert multi.bob.delete(f"/api/watchlists/{wid}").status_code == 404
    assert multi.alice.get(f"/api/watchlists/{wid}").status_code == 200


def test_settings_keys_collide_per_owner_only(multi: Multi) -> None:
    assert multi.alice.put("/api/settings/theme", json={"value": "dark"}).status_code == 204
    assert multi.bob.put("/api/settings/theme", json={"value": "light"}).status_code == 204
    assert multi.alice.get("/api/settings/theme").json() == "dark"
    assert multi.bob.get("/api/settings/theme").json() == "light"
    assert multi.alice.patch("/api/settings", json={"theme": None}).json() == {}
    assert multi.bob.get("/api/settings").json() == {"theme": "light"}
    assert multi.alice.get("/api/settings/theme").status_code == 404
    assert multi.alice.delete("/api/settings/theme").status_code == 204
    assert multi.bob.get("/api/settings/theme").json() == "light"


def test_flags_templates_notes_and_layouts_are_private(multi: Multi) -> None:
    for c, color in ((multi.alice, "red"), (multi.bob, "blue")):
        assert c.patch("/api/flags", json={"AAPL": color}).status_code == 200
        assert c.post(
            "/api/indicator-templates", json={"name": "T", "instances": []}
        ).status_code in (200, 201)
    assert [f["color"] for f in multi.alice.get("/api/flags").json()] == ["red"]
    assert [f["color"] for f in multi.bob.get("/api/flags").json()] == ["blue"]
    note = multi.alice.post("/api/notes", json={"text": "secret", "symbol": "AAPL"}).json()
    assert multi.bob.get("/api/notes").json() == []
    assert multi.bob.get(f"/api/notes/{note['id']}").status_code == 404
    layout = multi.alice.post("/api/layouts", json={"name": "L", "state": STATE}).json()
    assert multi.bob.get("/api/layouts").json() == []
    assert multi.bob.get(f"/api/layouts/{layout['id']}").status_code == 404
    # `is_last_used` is per owner too.
    assert multi.alice.put("/api/layouts/last-used", json={"id": layout["id"]}).status_code == 204
    own = multi.bob.post("/api/layouts", json={"name": "B", "state": STATE}).json()
    assert multi.bob.put("/api/layouts/last-used", json={"id": own["id"]}).status_code == 204
    assert multi.alice.get("/api/layouts/last-used").json()["id"] == layout["id"]
    assert multi.bob.get("/api/layouts/last-used").json()["id"] == own["id"]


def test_alerts_and_their_log_are_private(multi: Multi) -> None:
    created = multi.alice.post("/api/alerts", json=alert_body(id="a-1"))
    assert created.status_code == 201
    assert multi.bob.get("/api/alerts").json() == []
    assert multi.bob.get("/api/alerts/a-1").status_code == 404
    assert multi.bob.patch("/api/alerts/a-1", json={"status": "paused"}).status_code == 404
    assert multi.bob.delete("/api/alerts/a-1").status_code == 404
    # The service (system principal) fires it; the log entry belongs to its owner.
    svc = {"X-Alerts-Token": "svc-token-0123456789abcdef0123456789abcdef"}
    fire = {
        "fireId": "f1",
        "revision": 1,
        "firedAt": "2026-10-15T14:30:00Z",
        "barTime": 1_791_000_000,
        "final": False,
        "delayed": False,
        "message": "AAPL crossed",
        "values": {"x": 190.5, "y": 190, "open": 1, "high": 2, "low": 1, "close": 190.5},
    }
    res = multi.new_client().post("/api/alerts/a-1/fire", json=fire, headers=svc)
    assert res.status_code == 200, res.text
    assert len(multi.alice.get("/api/alerts/log").json()["entries"]) == 1
    bob_log = multi.bob.get("/api/alerts/log").json()
    assert bob_log["entries"] == [] and bob_log["unread"] == 0
    assert multi.alice.get("/api/alerts/log").json()["unread"] == 1
    # Bob cannot mark / clear Alice's entries.
    multi.bob.post("/api/alerts/log/read", json={"upTo": 10_000})
    assert multi.alice.get("/api/alerts/log").json()["unread"] == 1
    assert multi.bob.delete("/api/alerts/log").status_code == 204
    assert len(multi.alice.get("/api/alerts/log").json()["entries"]) == 1
    with engine_of(multi.root).connect() as conn:
        owners = conn.exec_driver_sql("SELECT DISTINCT owner_id FROM alert_log").scalars().all()
        assert owners == [multi.ids["alice"]]


def test_export_and_import_are_per_user(multi: Multi) -> None:
    multi.alice.post("/api/watchlists", json={"name": "A", "items": []})
    multi.alice.put("/api/settings/k", json={"value": 1})
    multi.bob.post("/api/watchlists", json={"name": "B", "items": []})
    bundle = multi.bob.get("/api/export").json()
    assert [w["name"] for w in bundle["watchlists"]] == ["B"] and bundle["settings"] == {}
    replace = multi.bob.post("/api/import?mode=replace&confirm=true", json=bundle)
    assert replace.status_code == 200, replace.text
    assert [w["name"] for w in multi.alice.get("/api/watchlists").json()] == ["A"]
    assert multi.alice.get("/api/settings").json() == {"k": 1}
    # A token (service) cannot export every user's data.
    svc = multi.new_client().get(
        "/api/export", headers={"X-Alerts-Token": "svc-token-0123456789abcdef0123456789abcdef"}
    )
    assert svc.status_code == 403


def test_portfolio_children_and_journal_links_are_private(multi: Multi) -> None:
    from test_portfolio import PNG, buy, mk_note, mk_portfolio, post_tx

    pa = mk_portfolio(multi.alice)["id"]
    pb = mk_portfolio(multi.bob)["id"]
    tx = post_tx(multi.alice, pa)
    note = mk_note(multi.alice)
    entry = multi.alice.post(
        f"/api/portfolios/{pa}/journal", json={"transactionId": tx["id"], "noteId": note["id"]}
    )
    assert entry.status_code == 201, entry.text
    eid = entry.json()["id"]
    assert (
        multi.alice.put(
            f"/api/journal/{eid}/screenshot", content=PNG, headers={"content-type": "image/png"}
        ).status_code
        == 200
    )

    # Bob reaches none of it by id ...
    assert multi.bob.get(f"/api/portfolios/{pa}").status_code == 404
    assert multi.bob.get(f"/api/portfolios/{pa}/transactions").status_code == 404
    put_tx = multi.bob.put(f"/api/transactions/{tx['id']}", json=buy())
    assert put_tx.status_code == 404
    assert multi.bob.delete(f"/api/transactions/{tx['id']}").status_code == 404
    assert multi.bob.put(f"/api/journal/{eid}", json={}).status_code == 404
    assert multi.bob.delete(f"/api/journal/{eid}").status_code == 404
    assert multi.bob.get(f"/api/journal/{eid}/screenshot").status_code == 404
    assert multi.bob.delete(f"/api/journal/{eid}/screenshot").status_code == 404
    # ... cannot link his journal entry to Alice's note or transaction ...
    mine = multi.bob.post(f"/api/portfolios/{pb}/journal", json={"noteId": note["id"]})
    assert mine.status_code == 422
    mine = multi.bob.post(f"/api/portfolios/{pb}/journal", json={"transactionId": tx["id"]})
    assert mine.status_code == 422
    # ... and his export / replace-import neither shows nor deletes her rows.
    bundle = multi.bob.get("/api/export").json()
    assert bundle["portfolios"][0]["id"] == pb
    assert bundle["portfolioTransactions"] == [] and bundle["journalEntries"] == []
    res = multi.bob.post("/api/import?mode=replace&confirm=true", json=bundle)
    assert res.status_code == 200, res.text
    assert len(multi.alice.get(f"/api/portfolios/{pa}/transactions").json()) == 1
    assert multi.alice.get(f"/api/journal/{eid}/screenshot").status_code == 200
    again = multi.alice.get("/api/export").json()
    assert len(again["portfolioTransactions"]) == 1 and len(again["journalEntries"]) == 1
    assert again["journalEntries"][0]["screenshot"] is not None


def test_alert_states_are_private(multi: Multi) -> None:
    assert multi.alice.post("/api/alerts", json=alert_body(id="s-1")).status_code == 201
    svc = {"X-Alerts-Token": "svc-token-0123456789abcdef0123456789abcdef"}
    put = multi.new_client().put(
        "/api/alerts/states",
        json={"states": [{"alertId": "s-1", "revision": 1, "state": {"x": 1}}]},
        headers=svc,
    )
    assert put.status_code == 200, put.text
    assert [x["alertId"] for x in multi.alice.get("/api/alerts/states").json()] == ["s-1"]
    assert multi.bob.get("/api/alerts/states").json() == []
    assert len(multi.new_client().get("/api/alerts/states", headers=svc).json()) == 1


def test_screener_scan_cache_is_per_user(multi: Multi) -> None:
    wl = multi.alice.post("/api/watchlists", json={"name": "W", "items": []}).json()["id"]
    body = {"universe": {"kind": "watchlist", "id": wl}, "filter": None}
    mine = multi.alice.post("/api/screener/scan", json=body)
    assert mine.status_code in (200, 422), mine.text
    theirs = multi.bob.post("/api/screener/scan", json=body)
    # Same request, same ETag inputs: Bob must not be served Alice's cached answer.
    assert theirs.status_code in (404, 422), theirs.text
    if mine.status_code == 200:
        etag = mine.headers["ETag"]
        again = multi.bob.post("/api/screener/scan", json=body, headers={"If-None-Match": etag})
        assert again.status_code != 304


# --------------------------------------------------------------------- /ws


def _drain(ws: Any) -> list[dict[str, Any]]:
    """Frames queued for this socket so far (a ping marks the end)."""
    ws.send_json({"op": "ping"})
    out: list[dict[str, Any]] = []
    while True:
        frame = ws.receive_json()
        if frame.get("type") == "pong":
            return out
        out.append(frame)


def test_ws_events_reach_only_their_owner_and_the_service(multi: Multi) -> None:
    root = multi.root
    a_head, b_head = multi.cookie_header(multi.alice), multi.cookie_header(multi.bob)
    with (
        root.websocket_connect("/ws", headers=a_head) as wa,
        root.websocket_connect("/ws", headers=b_head) as wb,
        root.websocket_connect("/ws?auth_token=svc-token-0123456789abcdef0123456789abcdef") as wsvc,
    ):
        for ws in (wa, wb, wsvc):
            ws.send_json({"op": "events", "topics": ["alerts", "drawings"]})
        _drain(wa), _drain(wb), _drain(wsvc)
        res = multi.alice.post("/api/alerts", json=alert_body(id="ws-1"))
        assert res.status_code == 201
        res = multi.alice.post(
            "/api/drawings/batch",
            json={
                "upserts": [
                    {
                        "drawing": {
                            "id": "d1",
                            "type": "trend-line",
                            "points": [{"time": 1, "price": 2.5}],
                            "style": {},
                            "text": "",
                            "locked": False,
                            "hidden": False,
                            "zIndex": 0,
                            "visibility": None,
                            "scope": "symbol",
                            "symbol": "AAPL",
                            "paneId": "main",
                        }
                    }
                ]
            },
        )
        assert res.status_code == 200, res.text
        got_a = [(f["topic"], f["type"]) for f in _drain(wa)]
        got_b = _drain(wb)
        got_svc = [(f["topic"], f["type"]) for f in _drain(wsvc)]
        assert got_a == [("alerts", "alerts.changed"), ("drawings", "drawings.changed")]
        assert got_svc == got_a
        assert got_b == []
        # Bob's own change reaches Bob, not Alice.
        assert multi.bob.post("/api/alerts", json=alert_body(id="ws-2")).status_code == 201
        assert [f["type"] for f in _drain(wb)] == ["alerts.changed"]
        assert _drain(wa) == []


def test_ws_needs_a_user_and_dies_with_the_account(multi: Multi) -> None:
    with pytest.raises(WebSocketDisconnect), multi.root.websocket_connect("/ws"):
        pass
    head = multi.cookie_header(multi.bob)
    with multi.root.websocket_connect("/ws", headers=head) as ws:
        ws.send_json({"op": "ping"})
        assert ws.receive_json()["type"] == "pong"
        assert (
            multi.owner.patch(f"/api/users/{multi.ids['bob']}", json={"disabled": True}).status_code
            == 200
        )
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 4401


def _closed_after(multi: Multi, name: str, act: Callable[[], Any]) -> None:
    head = multi.cookie_header(multi.users[name])
    with multi.root.websocket_connect("/ws", headers=head) as ws:
        ws.send_json({"op": "ping"})
        assert ws.receive_json()["type"] == "pong"
        res = act()
        assert res.status_code in (200, 204), res.text
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


def test_open_sockets_close_when_the_account_changes(multi: Multi) -> None:
    uid = multi.ids["bob"]
    _closed_after(
        multi,
        "bob",
        lambda: multi.owner.put(f"/api/users/{uid}/password", json={"new": "reset-password-1"}),
    )
    multi.bob.post("/api/auth/login", json={"username": "bob", "password": "reset-password-1"})
    _closed_after(
        multi,
        "alice",
        lambda: multi.alice.put(
            "/api/me/password", json={"current": USER_PASSWORD, "new": "n" * 12}
        ),
    )
    # Role change (sockets reconnect with the new role), disable and delete.
    carol = multi.create("carol")
    cid = multi.ids["carol"]
    _closed_after(
        multi, "carol", lambda: multi.owner.patch(f"/api/users/{cid}", json={"role": "admin"})
    )
    assert carol.get("/api/auth/state").json()["user"]["role"] == "admin"
    _closed_after(
        multi, "carol", lambda: multi.owner.patch(f"/api/users/{cid}", json={"disabled": True})
    )
    dave = multi.create("dave")
    del dave
    did = multi.ids["dave"]
    _closed_after(multi, "dave", lambda: multi.owner.delete(f"/api/users/{did}"))


def test_hub_publish_needs_an_owner() -> None:
    """Unit check of the fan-out rule: `owner_id=None` reaches only system sockets."""
    import asyncio

    from tickerglass_api.live import LiveHub

    async def run() -> None:
        hub = LiveHub(None, lambda symbols: asyncio.sleep(0, {}))  # type: ignore[arg-type, return-value]
        alice, bob = hub.register(user_id="a"), hub.register(user_id="b")
        service, nobody = hub.register(system=True), hub.register()
        for c in (alice, bob, service, nobody):
            c.topics = {"alerts"}
            while not c.queue.empty():
                c.queue.get_nowait()
        hub.publish("alerts", {"type": "x"}, owner_id="a")
        assert [c.queue.qsize() for c in (alice, bob, service, nobody)] == [1, 0, 1, 0]
        hub.publish("alerts", {"type": "y"}, owner_id=None)
        assert [c.queue.qsize() for c in (alice, bob, service, nobody)] == [1, 0, 2, 0]

    asyncio.run(run())


def test_models_used_by_helpers_exist() -> None:
    assert m.User.__tablename__ == "users" and m.UserIdentity.__tablename__ == "user_identities"
