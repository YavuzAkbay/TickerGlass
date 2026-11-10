"""Server maintenance routes: status, cache clear, SQLite backup."""

import sqlite3
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient


def test_status_shape(make_client: Callable[..., TestClient]) -> None:
    client = make_client(auth_password="sesame")
    assert client.post("/api/auth/login", json={"password": "sesame"}).status_code == 204
    res = client.get("/api/server/status")
    assert res.status_code == 200
    body = res.json()
    # The test app runs a custom provider (no registry spec), so the id is None.
    assert set(body["provider"]) == {"id", "name", "configured", "cacheSource"}
    assert body["provider"]["id"] is None
    assert body["database"]["kind"] == "sqlite"
    assert body["database"]["sizeBytes"] is None or body["database"]["sizeBytes"] > 0
    for key in ("watchlists", "layouts", "drawings", "notes", "userScripts", "alerts", "bars"):
        assert isinstance(body["counts"][key], int)
    assert body["alertsService"] == {"online": False}
    assert body["auth"] == {"enabled": True}


def test_cache_clear_empties_bars(make_client: Callable[..., TestClient]) -> None:
    client = make_client()
    res = client.post("/api/server/cache/clear")
    assert res.status_code == 200
    body = res.json()
    assert body["cleared"] is True
    assert body["generation"] >= 1
    # Clearing again is safe (idempotent, next generation).
    again = client.post("/api/server/cache/clear")
    assert again.status_code == 200
    assert again.json()["generation"] == body["generation"] + 1


def test_cache_clear_keeps_user_data(make_client: Callable[..., TestClient]) -> None:
    client = make_client()
    res = client.post(
        "/api/watchlists",
        json={"id": "wl-1", "name": "Mine", "items": [{"type": "symbol", "symbol": "AAPL"}]},
    )
    assert res.status_code in (200, 201), res.text
    assert client.post("/api/server/cache/clear").status_code == 200
    lists = client.get("/api/watchlists").json()
    assert [w["name"] for w in lists] == ["Mine"]


def test_backup_sqlite(make_client: Callable[..., TestClient], tmp_path: Path) -> None:
    client = make_client()
    res = client.get("/api/server/backup")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/x-sqlite3")
    assert "tickerglass-backup-" in res.headers["content-disposition"]
    out = tmp_path / "backup.db"
    out.write_bytes(res.content)
    # A real, readable SQLite file.
    con = sqlite3.connect(out)
    try:
        tables = {
            row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        assert "watchlists" in tables
    finally:
        con.close()
