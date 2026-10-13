from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from investopen_api.app import create_app
from investopen_api.providers.base import BAR_COLUMNS, SymbolNotFound

KNOWN = {"AAPL", "MSFT"}


class FakeProvider:
    def __init__(self) -> None:
        self.quote_calls: list[list[str]] = []
        self.news_calls = 0

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        return pd.DataFrame(columns=BAR_COLUMNS)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        raise SymbolNotFound(symbol)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return []

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.quote_calls.append(list(symbols))
        return [
            {
                "symbol": s,
                "last": 101.0,
                "prevClose": 100.0,
                "change": 1.0,
                "changePercent": 1.0,
                "volume": 5,
                "currency": "USD",
                "marketState": None,
                "time": 1_700_000_000,
            }
            for s in symbols
            if s in KNOWN
        ]

    def events(self, symbol: str) -> dict[str, Any]:
        if symbol not in KNOWN:
            raise SymbolNotFound(symbol)
        return {
            "dividends": [{"t": 1, "amount": 0.25}],
            "splits": [{"t": 2, "ratio": 4.0}],
            "earnings": [{"t": 3, "epsEstimate": 1.0, "epsActual": None, "surprisePercent": None}],
        }

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        self.news_calls += 1
        return [
            {
                "id": "n1",
                "title": "T",
                "publisher": "P",
                "url": "https://x",
                "time": 1,
                "summary": None,
                "thumbnail": None,
            }
        ]

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        if symbol not in KNOWN:
            raise SymbolNotFound(symbol)
        stmt = {"periods": ["2025-09-30"], "rows": {"Revenue": [1.0], "Other": [None]}}
        return {
            "info": {"marketCap": 10, "sector": "Tech"},
            "financials": {"income": stmt, "balance": stmt, "cashflow": stmt},
        }


@pytest.fixture
def fake() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def client(fake: FakeProvider, tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(provider=fake, database_url=f"sqlite:///{tmp_path}/t.db")
    with TestClient(app) as c:
        yield c


def test_quotes_shape_and_unknown_omitted(client: TestClient) -> None:
    res = client.get("/api/quotes", params={"symbols": "aapl,NOPE,msft"})
    assert res.status_code == 200
    body = res.json()
    assert [q["symbol"] for q in body] == ["AAPL", "MSFT"]
    assert {"last", "prevClose", "change", "changePercent", "volume", "currency", "time"} <= set(
        body[0]
    )


def test_quotes_cache_hit(client: TestClient, fake: FakeProvider) -> None:
    client.get("/api/quotes", params={"symbols": "AAPL"})
    client.get("/api/quotes", params={"symbols": "AAPL,MSFT"})
    client.get("/api/quotes", params={"symbols": "AAPL,MSFT"})
    assert fake.quote_calls == [["AAPL"], ["MSFT"]]


def test_quotes_limits(client: TestClient) -> None:
    assert client.get("/api/quotes", params={"symbols": ","}).status_code == 422
    too_many = ",".join(f"S{i}" for i in range(101))
    assert client.get("/api/quotes", params={"symbols": too_many}).status_code == 422
    ok = ",".join(f"S{i}" for i in range(100))
    assert client.get("/api/quotes", params={"symbols": ok}).status_code == 200


def test_events(client: TestClient) -> None:
    res = client.get("/api/events/aapl")
    assert res.status_code == 200
    body = res.json()
    assert body["dividends"] == [{"t": 1, "amount": 0.25}]
    assert body["splits"] == [{"t": 2, "ratio": 4.0}]
    assert body["earnings"][0]["epsEstimate"] == 1.0


def test_events_404(client: TestClient) -> None:
    assert client.get("/api/events/NOPE").status_code == 404


def test_news_and_cache(client: TestClient, fake: FakeProvider) -> None:
    res = client.get("/api/news/AAPL", params={"limit": 5})
    assert res.status_code == 200
    assert res.json()[0]["title"] == "T"
    client.get("/api/news/aapl", params={"limit": 5})
    assert fake.news_calls == 1
    assert client.get("/api/news/AAPL", params={"limit": 0}).status_code == 422


def test_fundamentals(client: TestClient) -> None:
    res = client.get("/api/fundamentals/AAPL")
    assert res.status_code == 200
    body = res.json()
    assert body["info"]["marketCap"] == 10
    assert body["financials"]["income"]["rows"]["Other"] == [None]
    assert body["financials"]["balance"]["periods"] == ["2025-09-30"]


def test_fundamentals_404(client: TestClient) -> None:
    assert client.get("/api/fundamentals/NOPE").status_code == 404
