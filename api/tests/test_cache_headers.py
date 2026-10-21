import time
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from test_bars import DAILY
from test_market import FakeProvider as MarketFake

from tickerglass_api.app import create_app
from tickerglass_api.providers.base import SymbolNotFound

DAY = 86_400


class HeaderFake(MarketFake):
    """Market fake plus daily bars, symbol info and search."""

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        if (symbol, interval) != ("AAPL", "1d"):
            return super().history(symbol, interval, start, end, prepost)
        df = DAILY
        if start is not None:
            df = df[df["ts"] >= int(start.timestamp())]
        if end is not None:
            df = df[df["ts"] < int(end.timestamp())]
        return df.reset_index(drop=True)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        if symbol != "AAPL":
            raise SymbolNotFound(symbol)
        return {"symbol": symbol, "name": "Apple Inc.", "timezone": "America/New_York"}

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return [{"symbol": "AAPL", "name": "Apple Inc."}]


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(provider=HeaderFake(), database_url=f"sqlite:///{tmp_path}/h.db")
    with TestClient(app) as c:
        yield c


def cc(client: TestClient, url: str, **params: Any) -> tuple[int, str | None]:
    res = client.get(url, params=params)
    return res.status_code, res.headers.get("Cache-Control")


@pytest.mark.parametrize(
    ("url", "params", "expected"),
    [
        ("/api/symbols/AAPL", {}, "private, max-age=3600"),
        ("/api/symbols/search", {"q": "app"}, "private, max-age=3600"),
        ("/api/fundamentals/AAPL", {}, "private, max-age=600"),
        ("/api/events/AAPL", {}, "private, max-age=600"),
        ("/api/news", {"symbols": "AAPL,MSFT"}, "private, max-age=120"),
        ("/api/news/AAPL", {}, "private, max-age=120"),
        ("/api/quotes", {"symbols": "AAPL"}, "private, no-cache"),
        ("/api/quotes/extended", {"symbols": "AAPL"}, "private, no-cache"),
        ("/api/performance/AAPL", {}, "private, no-cache"),
    ],
)
def test_cache_control_on_success(
    client: TestClient, url: str, params: dict[str, str], expected: str
) -> None:
    assert cc(client, url, **params) == (200, expected)


@pytest.mark.parametrize(
    ("url", "params", "status"),
    [
        ("/api/symbols/NOPE", {}, 404),
        ("/api/fundamentals/NOPE", {}, 404),
        ("/api/events/NOPE", {}, 404),
        ("/api/performance/NOPE", {}, 404),
        ("/api/quotes", {"symbols": " , "}, 422),
        ("/api/quotes/extended", {"symbols": " , "}, 422),
        ("/api/news", {"symbols": " , "}, 422),
        ("/api/symbols/search", {"q": ""}, 422),
        ("/api/bars", {"symbol": "NOPE", "to": 1_000_000_000}, 404),
        ("/api/bars", {"symbol": "AAPL", "interval": "7m", "to": 1_000_000_000}, 422),
    ],
)
def test_errors_carry_no_cache_control(
    client: TestClient, url: str, params: dict[str, str | int], status: int
) -> None:
    res = client.get(url, params=params)
    assert res.status_code == status
    assert "Cache-Control" not in res.headers


def test_bars_historical_page_is_cacheable(client: TestClient) -> None:
    mid = DAILY["ts"].tolist()[len(DAILY) // 2]
    assert cc(client, "/api/bars", symbol="AAPL", limit=3, to=mid) == (
        200,
        "private, max-age=300",
    )


def test_bars_open_ended_or_recent_is_no_cache(client: TestClient) -> None:
    now = int(time.time())
    expected = (200, "private, no-cache")
    assert cc(client, "/api/bars", symbol="AAPL", limit=3) == expected
    assert cc(client, "/api/bars", symbol="AAPL", limit=3, to=now + DAY) == expected
    # Within two bar intervals of now: the last bar may still be settling.
    assert cc(client, "/api/bars", symbol="AAPL", limit=3, to=now - DAY) == expected
    assert cc(client, "/api/bars", symbol="AAPL", limit=3, to=now - 3 * DAY) == (
        200,
        "private, max-age=300",
    )


def test_header_survives_gzip(client: TestClient) -> None:
    mid = DAILY["ts"].tolist()[len(DAILY) // 2]
    res = client.get(
        "/api/bars",
        params={"symbol": "AAPL", "limit": 200, "to": mid},
        headers={"Accept-Encoding": "gzip"},
    )
    assert res.status_code == 200
    assert res.headers["Content-Encoding"] == "gzip"
    assert res.headers["Cache-Control"] == "private, max-age=300"
