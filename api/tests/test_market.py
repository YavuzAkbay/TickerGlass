import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from investopen_api.app import create_app
from investopen_api.providers.base import BAR_COLUMNS, PartialQuotes, ProviderError, SymbolNotFound
from investopen_api.providers.yahoo import YahooProvider

KNOWN = {"AAPL", "MSFT"}
V7_FIXTURE = Path(__file__).parent / "fixtures" / "v7_quote_mixed.json"


def v7_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = json.loads(V7_FIXTURE.read_text())["quoteResponse"]["result"]
    return rows


class FakeProvider:
    def __init__(self) -> None:
        self.quote_calls: list[list[str]] = []
        self.news_calls = 0
        self.extended_calls: list[list[str]] = []
        self.news_by_symbol: dict[str, list[dict[str, Any]]] | None = None
        self.news_fail: set[str] = set()

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

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.extended_calls.append(list(symbols))
        yahoo = YahooProvider()
        yahoo._v7_quote = lambda chunk: [r for r in v7_rows() if r["symbol"] in chunk]  # type: ignore[method-assign]
        return yahoo.extended_quotes(symbols)

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
        if symbol in self.news_fail:
            raise ProviderError(f"boom {symbol}")
        if self.news_by_symbol is not None:
            return self.news_by_symbol.get(symbol, [])
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


def test_extended_quotes_mapping(client: TestClient) -> None:
    res = client.get("/api/quotes/extended", params={"symbols": "aapl,MSFT,ILQ,BRK,NOPE"})
    assert res.status_code == 200
    by = {q["symbol"]: q for q in res.json()}
    assert list(by) == ["AAPL", "MSFT", "ILQ", "BRK"]
    pre = by["AAPL"]
    assert pre["marketState"] == "PRE" and pre["preMarketPrice"] == 232.1
    # Change fields are computed against the regular price, not taken from Yahoo.
    assert pre["preMarketChange"] == pytest.approx(0.6)
    assert pre["preMarketChangePercent"] == pytest.approx(0.6 / 231.5 * 100)
    assert pre["preMarketTime"] == 1760430000 and pre["regularMarketTime"] == 1760385600
    post = by["MSFT"]
    assert post["postMarketChange"] == pytest.approx(-4.2)
    assert post["postMarketChangePercent"] == pytest.approx(-4.2 / 420.0 * 100)
    assert post["preMarketPrice"] is None and post["preMarketChange"] is None
    reg = by["ILQ"]
    assert reg["marketState"] == "REGULAR"
    assert reg["preMarketPrice"] is None and reg["postMarketChangePercent"] is None
    # Base <= 0: price kept, change fields null.
    brk = by["BRK"]
    assert brk["preMarketPrice"] == 1.0
    assert brk["preMarketChange"] is None and brk["preMarketChangePercent"] is None


def test_extended_quotes_cache_and_limits(client: TestClient, fake: FakeProvider) -> None:
    client.get("/api/quotes/extended", params={"symbols": "AAPL"})
    client.get("/api/quotes/extended", params={"symbols": "AAPL,NOPE"})
    client.get("/api/quotes/extended", params={"symbols": "AAPL,NOPE"})
    assert fake.extended_calls == [["AAPL"], ["NOPE"]]
    assert client.get("/api/quotes/extended", params={"symbols": ","}).status_code == 422
    too_many = ",".join(f"S{i}" for i in range(101))
    assert client.get("/api/quotes/extended", params={"symbols": too_many}).status_code == 422


def test_yahoo_extended_chunks_and_failure() -> None:
    yahoo = YahooProvider(min_interval=0, retries=0)
    seen: list[list[str]] = []

    def v7(chunk: list[str]) -> list[dict[str, Any]]:
        seen.append(chunk)
        if len(seen) == 2:
            raise RuntimeError("v7 changed")
        return [{"symbol": s, "regularMarketPrice": 10.0} for s in chunk]

    yahoo._v7_quote = v7  # type: ignore[method-assign]
    with pytest.raises(PartialQuotes) as ei:
        yahoo.extended_quotes([f"S{i}" for i in range(120)])
    assert [len(c) for c in seen] == [50, 50, 20]
    # The failed middle chunk is reported (no per-symbol fallback), successes kept.
    assert len(ei.value.quotes) == 70 and ei.value.failed == [f"S{i}" for i in range(50, 100)]


def test_v7_shape_error_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    import yfinance.data

    calls = 0

    def raw(self: Any, url: str, params: Any = None) -> Any:
        nonlocal calls
        calls += 1
        return {"quoteResponse": {"result": "oops"}}

    monkeypatch.setattr(yfinance.data.YfData, "get_raw_json", raw)
    yahoo = YahooProvider(min_interval=0, retries=3)
    with pytest.raises(PartialQuotes):
        yahoo.extended_quotes(["AAPL"])
    assert calls == 1


class FlakyExtended(FakeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.fail = True

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        if self.fail:
            self.extended_calls.append(list(symbols))
            raise PartialQuotes("down", [], list(symbols))
        return super().extended_quotes(symbols)


def test_failed_extended_chunk_is_not_cached_as_unknown(tmp_path: Path) -> None:
    prov = FlakyExtended()
    with TestClient(create_app(provider=prov, database_url=f"sqlite:///{tmp_path}/f.db")) as c:
        # Everything failed: 502, like /quotes on a provider error.
        assert c.get("/api/quotes/extended", params={"symbols": "AAPL"}).status_code == 502
        prov.fail = False
        res = c.get("/api/quotes/extended", params={"symbols": "AAPL"})
        assert [q["symbol"] for q in res.json()] == ["AAPL"]
        # Upstream recovered: not served from a poisoned None cache entry.
        assert prov.extended_calls == [["AAPL"], ["AAPL"]]


def _news(nid: str, t: int | None, url: str = "https://x") -> dict[str, Any]:
    return {"id": nid, "title": nid, "publisher": "P", "url": url, "time": t}


def test_news_multi_merge(client: TestClient, fake: FakeProvider) -> None:
    fake.news_by_symbol = {
        "AAPL": [_news("a", 10), _news("shared", 30), _news("old", None)],
        "MSFT": [_news("m", 20), _news("shared", 30)],
    }
    res = client.get("/api/news", params={"symbols": "aapl,msft,aapl", "limit": 4})
    assert res.status_code == 200
    body = res.json()
    assert [(n["id"], n["symbol"]) for n in body] == [
        ("shared", "AAPL"),
        ("m", "MSFT"),
        ("a", "AAPL"),
        ("old", "AAPL"),
    ]
    assert [
        n["id"] for n in client.get("/api/news", params={"symbols": "AAPL,MSFT", "limit": 2}).json()
    ] == ["shared", "m"]


def test_news_multi_failures_and_limits(client: TestClient, fake: FakeProvider) -> None:
    fake.news_fail = {"AAPL"}
    ok = client.get("/api/news", params={"symbols": "AAPL,MSFT"})
    assert ok.status_code == 200 and ok.json()[0]["symbol"] == "MSFT"
    fake.news_fail = {"AAPL", "MSFT"}
    assert client.get("/api/news", params={"symbols": "AAPL,MSFT,TSLA"}).status_code == 200
    both = client.get("/api/news", params={"symbols": "AAPL,MSFT", "limit": 7})
    assert both.status_code == 502
    eleven = ",".join(f"S{i}" for i in range(11))
    assert client.get("/api/news", params={"symbols": eleven}).status_code == 422
    assert client.get("/api/news", params={"symbols": ","}).status_code == 422
    assert client.get("/api/news", params={"symbols": "A", "limit": 101}).status_code == 422


def test_partial_extended_failure_caches_only_successes(tmp_path: Path) -> None:
    class Half(FakeProvider):
        def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
            self.extended_calls.append(list(symbols))
            good = [r for r in v7_rows() if r["symbol"] == "AAPL"]
            yahoo = YahooProvider()
            yahoo._v7_quote = lambda chunk: good  # type: ignore[method-assign]
            out = yahoo.extended_quotes(["AAPL"])
            raise PartialQuotes("half", out, [s for s in symbols if s != "AAPL"])

    prov = Half()
    with TestClient(create_app(provider=prov, database_url=f"sqlite:///{tmp_path}/h.db")) as c:
        res = c.get("/api/quotes/extended", params={"symbols": "AAPL,MSFT"})
        assert [q["symbol"] for q in res.json()] == ["AAPL"]
        c.get("/api/quotes/extended", params={"symbols": "AAPL,MSFT"})
        # AAPL cached; MSFT (failed chunk) is asked again.
        assert prov.extended_calls == [["AAPL", "MSFT"], ["MSFT"]]


def test_news_multi_keeps_items_without_id_or_url(client: TestClient, fake: FakeProvider) -> None:
    def item(title: str) -> dict[str, Any]:
        return {"id": None, "title": title, "publisher": "P", "url": None, "time": 1}

    fake.news_by_symbol = {"AAPL": [item("one"), item("two")], "MSFT": [item("three")]}
    res = client.get("/api/news", params={"symbols": "aapl,msft"})
    assert sorted(n["title"] for n in res.json()) == ["one", "three", "two"]
