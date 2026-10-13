from fastapi.testclient import TestClient

from investopen_api.app import create_app


def test_health() -> None:
    client = TestClient(create_app())
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
