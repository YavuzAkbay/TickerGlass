"""`X-TickerGlass-Priority: background` reaches events, fundamentals and news calls."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_market import FakeProvider

from tickerglass_api.app import create_app
from tickerglass_api.providers.guard import UpstreamGuard

HEADER = "X-TickerGlass-Priority"


class SpyProvider(FakeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.seen: dict[str, str] = {}

    def events(self, symbol: str) -> dict[str, Any]:
        self.seen["events"] = UpstreamGuard.current_priority()
        return super().events(symbol)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        self.seen["fundamentals"] = UpstreamGuard.current_priority()
        return super().fundamentals(symbol)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        self.seen["news"] = UpstreamGuard.current_priority()
        return super().news(symbol, limit)


@pytest.fixture
def spy() -> SpyProvider:
    return SpyProvider()


@pytest.fixture
def client(spy: SpyProvider, tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(provider=spy, database_url=f"sqlite:///{tmp_path}/t.db")
    with TestClient(app) as c:
        yield c


def test_defaults_without_header(client: TestClient, spy: SpyProvider) -> None:
    client.get("/api/events/AAPL")
    client.get("/api/fundamentals/AAPL")
    client.get("/api/news/AAPL")
    assert spy.seen == {"events": "visible", "fundamentals": "visible", "news": "interactive"}


def test_background_header(client: TestClient, spy: SpyProvider) -> None:
    h = {HEADER: "background"}
    assert client.get("/api/events/MSFT", headers=h).status_code == 200
    assert client.get("/api/fundamentals/MSFT", headers=h).status_code == 200
    assert client.get("/api/news/MSFT", headers=h).status_code == 200
    assert set(spy.seen.values()) == {"background"}
    assert set(spy.seen) == {"events", "fundamentals", "news"}


def test_unaskable_priority_is_ignored(client: TestClient, spy: SpyProvider) -> None:
    client.get("/api/events/AAPL", headers={HEADER: "prefetch"})
    assert spy.seen["events"] == "visible"
