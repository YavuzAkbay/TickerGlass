import asyncio
import json
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
import yfinance as yf
from fastapi.testclient import TestClient
from yfinance.exceptions import YFRateLimitError

from tickerglass_api.app import create_app
from tickerglass_api.live import Poller, market_poller
from tickerglass_api.providers.base import (
    BAR_COLUMNS,
    PartialQuotes,
    ProviderError,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    UpstreamUnavailable,
)
from tickerglass_api.providers.guard import UpstreamGuard
from tickerglass_api.providers.yahoo import YahooProvider, _v7_to_quote
from tickerglass_api.services.market import MarketService
from tickerglass_api.settings import Settings

KNOWN = {"AAPL", "MSFT"}
V7_FIXTURE = Path(__file__).parent / "fixtures" / "v7_quote_mixed.json"


def v7_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = json.loads(V7_FIXTURE.read_text())["quoteResponse"]["result"]
    return rows


class FakeProvider:
    def __init__(self) -> None:
        self.quote_calls: list[list[str]] = []
        self.news_calls = 0
        self.news_limits: list[int] = []
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
        self.news_limits.append(limit)
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
        quarterly_income = {
            "periods": ["2025-06-30", "2025-09-30"],
            "rows": {"Revenue": [1.0, 2.0]},
        }
        return {
            "info": {"marketCap": 10, "sector": "Tech"},
            "financials": {
                "income": stmt,
                "balance": stmt,
                "cashflow": stmt,
                "quarterly": {"income": quarterly_income, "balance": stmt, "cashflow": stmt},
            },
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
    quarterly = body["financials"]["quarterly"]
    assert quarterly["income"]["periods"] == ["2025-06-30", "2025-09-30"]
    assert quarterly["income"]["rows"]["Revenue"] == [1.0, 2.0]
    assert res.headers["cache-control"].endswith("max-age=600")


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
    # MSFT and TSLA are cached per symbol now; two never-fetched symbols that both fail:
    fake.news_fail = {"AAPL", "AMZN"}
    both = client.get("/api/news", params={"symbols": "AAPL,AMZN", "limit": 7})
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


def test_provider_error_statuses(client: TestClient, fake: FakeProvider) -> None:
    errors: dict[str, ProviderError] = {
        "RATE": RateLimited("limited", 9),
        "DOWN": UpstreamUnavailable("offline"),
        "BAD": ProviderError("bad"),
    }
    expected = {"RATE": 429, "DOWN": 503, "BAD": 502}
    fake.events = lambda symbol: (_ for _ in ()).throw(errors[symbol])  # type: ignore[method-assign]
    for symbol, status in expected.items():
        res = client.get(f"/api/events/{symbol}")
        assert res.status_code == status, symbol
        assert res.headers.get("Retry-After") == ("9" if status == 429 else None)


def test_quotes_twice_within_ttl_one_call(client: TestClient, fake: FakeProvider) -> None:
    for _ in range(2):
        res = client.get("/api/quotes", params={"symbols": "AAPL,MSFT"})
        assert [q["symbol"] for q in res.json()] == ["AAPL", "MSFT"]
    assert fake.quote_calls == [["AAPL", "MSFT"]]


def test_unknown_quote_symbols_are_asked_again(client: TestClient, fake: FakeProvider) -> None:
    client.get("/api/quotes", params={"symbols": "AAPL,NOPE"})
    client.get("/api/quotes", params={"symbols": "AAPL,NOPE"})
    # The quote batch does not confirm absence, so NOPE is not remembered as unknown.
    assert fake.quote_calls == [["AAPL", "NOPE"], ["NOPE"]]


def test_news_routes_share_one_fetch(client: TestClient, fake: FakeProvider) -> None:
    assert client.get("/api/news", params={"symbols": "AAPL", "limit": 30}).status_code == 200
    assert client.get("/api/news/AAPL", params={"limit": 20}).status_code == 200
    assert fake.news_calls == 1 and fake.news_limits == [50]


def test_news_wider_request_refetches() -> None:
    fake = FakeProvider()
    fake.news_by_symbol = {"AAPL": [_news(f"n{i}", i) for i in range(100)]}
    market = MarketService(fake)
    assert len(market.news("aapl", 10)) == 10
    assert len(market.news("AAPL", 80)) == 80
    assert len(market.news("AAPL", 60)) == 60
    assert fake.news_limits == [50, 80]


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_quotes_stale_only_on_error() -> None:
    fake = FakeProvider()
    clock = Clock()
    market = MarketService(fake, settings=Settings(quote_ttl_s=15), clock=clock)
    first = market.quotes(["AAPL"])
    clock.now += 16
    # Stale: fetched again rather than served stale.
    assert market.quotes(["AAPL"]) == first
    assert len(fake.quote_calls) == 2
    clock.now += 16
    fake.quotes = lambda symbols: (_ for _ in ()).throw(UpstreamUnavailable("down"))  # type: ignore[method-assign]
    assert market.quotes(["AAPL"]) == first
    with pytest.raises(UpstreamUnavailable):
        market.quotes(["AAPL", "MSFT"])


def test_events_served_stale_while_refreshing() -> None:
    from concurrent.futures import ThreadPoolExecutor

    fake = FakeProvider()
    clock = Clock()
    calls: list[str] = []
    real_events = fake.events

    def events(symbol: str) -> dict[str, Any]:
        calls.append(symbol)
        return {**real_events(symbol), "n": len(calls)}

    fake.events = events  # type: ignore[method-assign]
    with ThreadPoolExecutor(max_workers=1) as pool:
        market = MarketService(fake, refresher=pool, clock=clock)
        assert market.events("AAPL")["n"] == 1
        clock.now += 6 * 3600 + 1
        assert market.events("AAPL")["n"] == 1  # stale, refresh queued
    assert market.events("AAPL")["n"] == 2
    assert calls == ["AAPL", "AAPL"]


def test_refresher_on_app_state(tmp_path: Path) -> None:
    app = create_app(provider=FakeProvider(), database_url=f"sqlite:///{tmp_path}/r.db")
    with TestClient(app):
        pool = app.state.cache_refresher
        assert pool.submit(lambda: 7).result(timeout=5) == 7
    with pytest.raises(RuntimeError):
        pool.submit(lambda: 7)


def _yahoo_v7(rows: list[dict[str, Any]] | None = None) -> tuple[YahooProvider, list[list[str]]]:
    """A YahooProvider whose v7 endpoint serves the fixture (or `rows`), and the chunks asked."""
    yahoo = YahooProvider(min_interval=0, retries=0)
    served = v7_rows() if rows is None else rows
    seen: list[list[str]] = []

    def v7(chunk: list[str]) -> list[dict[str, Any]]:
        seen.append(chunk)
        return [r for r in served if r["symbol"] in chunk]

    yahoo._v7_quote = v7  # type: ignore[method-assign]
    return yahoo, seen


def test_yahoo_quotes_map_v7_rows() -> None:
    yahoo, seen = _yahoo_v7()
    out = yahoo.quotes(["AAPL", "MSFT", "ILQ", "BRK", "NOPE"])
    assert seen == [["AAPL", "MSFT", "ILQ", "BRK", "NOPE"]]
    assert isinstance(out, QuoteList) and out.confirmed
    by = {q["symbol"]: q for q in out}
    assert list(by) == ["AAPL", "MSFT", "ILQ", "BRK"]
    assert by["AAPL"] == {
        "symbol": "AAPL",
        "last": 231.5,
        "prevClose": 229.59,
        "change": 1.91,
        "changePercent": 0.8312,
        "volume": None,
        "currency": "USD",
        "marketState": "PRE",
        "time": 1760385600,
    }
    # Without Yahoo's change fields they are derived from the previous close, if known.
    assert by["MSFT"]["change"] is None and by["MSFT"]["changePercent"] is None
    assert by["MSFT"]["marketState"] == "POST" and by["BRK"]["marketState"] == "CLOSED"
    assert by["BRK"]["last"] == 0.0
    derived = _yahoo_v7(
        [
            {
                "symbol": "X",
                "regularMarketPrice": 110.0,
                "regularMarketPreviousClose": 100.0,
                "regularMarketVolume": 1234.0,
            }
        ]
    )[0].quotes(["X"])[0]
    assert derived["change"] == pytest.approx(10.0)
    assert derived["changePercent"] == pytest.approx(10.0)
    assert derived["volume"] == 1234 and derived["currency"] is None and derived["time"] is None


def test_yahoo_quotes_chunks_of_fifty() -> None:
    yahoo, seen = _yahoo_v7([])
    out = yahoo.quotes([f"S{i}" for i in range(120)])
    assert [len(c) for c in seen] == [50, 50, 20]
    assert out == [] and isinstance(out, QuoteList) and not out.confirmed  # empty answers
    assert yahoo.quotes([]) == [] and len(seen) == 3


def _download_frame() -> pd.DataFrame:
    index = pd.to_datetime(["2025-10-13", "2025-10-14"])
    cols = pd.MultiIndex.from_tuples([("AAPL", "Close"), ("AAPL", "Volume")])
    return pd.DataFrame([[100.0, 10.0], [102.0, 20.0]], index=index, columns=cols)


def test_yahoo_quotes_fall_back_to_download(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def download(symbols: list[str], **kwargs: Any) -> pd.DataFrame:
        calls.append({"symbols": symbols, **kwargs})
        return _download_frame()

    monkeypatch.setattr(yf, "download", download)
    yahoo = YahooProvider(min_interval=0, retries=0)

    def v7(chunk: list[str]) -> list[dict[str, Any]]:
        raise ProviderError("Yahoo v7 quote: unexpected payload")

    yahoo._v7_quote = v7  # type: ignore[method-assign]
    out = yahoo.quotes(["AAPL", "NOPE"])
    assert len(calls) == 1 and calls[0]["symbols"] == ["AAPL", "NOPE"]
    assert calls[0]["threads"] is False
    assert not (isinstance(out, QuoteList) and out.confirmed)
    assert [(q["symbol"], q["last"], q["prevClose"], q["volume"]) for q in out] == [
        ("AAPL", 102.0, 100.0, 20)
    ]


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (YFRateLimitError(), RateLimited),
        (ConnectionError("offline"), UpstreamUnavailable),
    ],
)
def test_yahoo_quotes_rate_limit_and_outage_are_not_retried_by_download(
    monkeypatch: pytest.MonkeyPatch, failure: Exception, expected: type[ProviderError]
) -> None:
    def download(*args: Any, **kwargs: Any) -> pd.DataFrame:
        raise AssertionError("no fallback expected")

    monkeypatch.setattr(yf, "download", download)
    yahoo = YahooProvider(min_interval=0, retries=0, rate_limit_retries=0)

    def v7(chunk: list[str]) -> list[dict[str, Any]]:
        raise failure

    yahoo._v7_quote = v7  # type: ignore[method-assign]
    with pytest.raises(expected):
        yahoo.quotes(["AAPL"])


class V7Provider(FakeProvider):
    """Quotes from the v7 fixture through the real mapping; `v7_fails` forces the fallback."""

    def __init__(self) -> None:
        super().__init__()
        self.v7_fails = False

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.quote_calls.append(list(symbols))
        yahoo, _ = _yahoo_v7()
        if self.v7_fails:
            # What the download fallback returns: rows, but no confirmation.
            return QuoteList(
                q for r in v7_rows() if r["symbol"] in symbols if (q := _v7_to_quote(r))
            )
        return yahoo.quotes(symbols)


def test_unknown_symbols_tombstoned_only_when_confirmed() -> None:
    prov = V7Provider()
    market = MarketService(prov)
    assert [q["symbol"] for q in market.quotes(["AAPL", "NOPE"])] == ["AAPL"]
    assert [q["symbol"] for q in market.quotes(["AAPL", "NOPE"])] == ["AAPL"]
    assert prov.quote_calls == [["AAPL", "NOPE"]]  # NOPE confirmed unknown: not asked again

    other = V7Provider()
    other.v7_fails = True
    market = MarketService(other)
    market.quotes(["AAPL", "NOPE"])
    market.quotes(["AAPL", "NOPE"])
    assert other.quote_calls == [["AAPL", "NOPE"], ["NOPE"]]


def test_quote_ttl_follows_market_state() -> None:
    states = {"REG": "REGULAR", "PRE": "PRE", "POST": "POSTPOST", "CLS": "CLOSED", "UNK": None}

    class Stateful(FakeProvider):
        def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
            self.quote_calls.append(list(symbols))
            return [{"symbol": s, "last": 1.0, "marketState": states[s]} for s in symbols]

    prov = Stateful()
    clock = Clock()
    settings = Settings(quote_ttl_s=15, extended_ttl_s=60, quote_closed_ttl_s=600)
    market = MarketService(prov, settings=settings, clock=clock)
    symbols = list(states)
    market.quotes(symbols)

    def refetched() -> set[str]:
        before = len(prov.quote_calls)
        market.quotes(symbols)
        return set(prov.quote_calls[-1]) if len(prov.quote_calls) > before else set()

    clock.now += 16
    assert refetched() == {"REG", "UNK"}
    clock.now += 50  # 66s after the first fetch; the pair was refetched 50s ago
    assert refetched() == {"REG", "UNK", "PRE", "POST"}
    clock.now += 540
    assert refetched() == {"REG", "UNK", "PRE", "POST", "CLS"}


def poll_once(poll: Poller, symbols: list[str]) -> dict[str, dict[str, Any]]:
    async def run() -> dict[str, dict[str, Any]]:
        return await poll(symbols)

    return asyncio.run(run())


def test_market_poller_shares_the_quote_cache(tmp_path: Path) -> None:
    fake = FakeProvider()
    app = create_app(provider=fake, database_url=f"sqlite:///{tmp_path}/p.db")
    with TestClient(app) as client:
        poll = market_poller(app.state.market_service, app.state.upstream_guard)
        polled = poll_once(poll, ["AAPL", "MSFT", "NOPE"])
        assert polled == {
            s: {"price": 101.0, "change": 1.0, "changePercent": 1.0, "dayVolume": 5}
            for s in ("AAPL", "MSFT")
        }
        res = client.get("/api/quotes", params={"symbols": "AAPL,MSFT"})
        assert [q["symbol"] for q in res.json()] == ["AAPL", "MSFT"]
        poll_once(poll, ["AAPL", "MSFT"])
    assert fake.quote_calls == [["AAPL", "MSFT", "NOPE"]]


def test_market_poller_runs_in_background_and_skips_rate_limits() -> None:
    guard = UpstreamGuard()
    modes: list[bool] = []
    fake = FakeProvider()
    outcome: list[Exception] = []

    def quotes(symbols: list[str]) -> list[dict[str, Any]]:
        modes.append(guard.in_background())
        if outcome:
            raise outcome[0]
        return []

    fake.quotes = quotes  # type: ignore[method-assign]
    poll = market_poller(MarketService(fake), guard)
    assert poll_once(poll, ["AAPL"]) == {}
    outcome.append(RateLimited("cooling down", 30))
    assert poll_once(poll, ["MSFT"]) == {}  # skipped, not raised
    assert modes == [True, True] and not guard.in_background()


# ---------------------------------------------------------------- v7 circuit


def _broken_v7(
    monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> tuple[YahooProvider, list[list[str]], list[list[str]]]:
    """A YahooProvider whose v7 endpoint fails with a payload error; returns it, the v7
    chunks asked and the symbols downloaded."""
    v7_calls: list[list[str]] = []
    downloads: list[list[str]] = []

    def download(symbols: list[str], **kwargs: Any) -> pd.DataFrame:
        downloads.append(list(symbols))
        return _download_frame()

    monkeypatch.setattr(yf, "download", download)
    yahoo = YahooProvider(min_interval=0, retries=0, quote_v7_retry_s=300, clock=clock)

    def v7(chunk: list[str]) -> list[dict[str, Any]]:
        v7_calls.append(chunk)
        raise ProviderError("Yahoo v7 quote: unexpected payload")

    yahoo._v7_quote = v7  # type: ignore[method-assign]
    return yahoo, v7_calls, downloads


def test_v7_failure_skips_v7_for_a_while(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock()
    yahoo, v7_calls, downloads = _broken_v7(monkeypatch, clock)
    yahoo.quotes(["AAPL"])
    assert len(v7_calls) == 1 and len(downloads) == 1
    clock.now += 200
    yahoo.quotes(["AAPL"])
    assert len(v7_calls) == 1 and len(downloads) == 2  # v7 skipped, small batch downloaded
    clock.now += 101
    yahoo.quotes(["AAPL"])
    assert len(v7_calls) == 2  # retried after `quote_v7_retry_s`


def test_large_batches_are_not_downloaded(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = Clock()
    yahoo, v7_calls, downloads = _broken_v7(monkeypatch, clock)
    many = [f"S{i}" for i in range(11)]
    with pytest.raises(UpstreamUnavailable):
        yahoo.quotes(many)
    assert len(v7_calls) == 1 and downloads == []
    with pytest.raises(UpstreamUnavailable):
        yahoo.quotes(many)
    assert len(v7_calls) == 1 and downloads == []


def test_skipped_quotes_do_not_open_the_unavailable_breaker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tickerglass_api.providers.guard import GuardedProvider

    yahoo, _, _ = _broken_v7(monkeypatch, Clock())
    guard = UpstreamGuard(burst=1000, rate_per_min=1e6)
    prov = GuardedProvider(yahoo, guard)
    with pytest.raises(UpstreamUnavailable):
        prov.quotes([f"S{i}" for i in range(11)])
    assert guard.snapshot()["unavailable"] is False


# ---------------------------------------------------------------- unknown quote symbols


def test_empty_v7_answer_is_not_confirmed() -> None:
    yahoo, _ = _yahoo_v7([])
    out = yahoo.quotes(["AAPL", "MSFT"])
    assert out == [] and not (isinstance(out, QuoteList) and out.confirmed)
    # A chunk that answered with some rows still confirms the rest of it.
    out = _yahoo_v7()[0].quotes(["AAPL", "NOPE"])
    assert isinstance(out, QuoteList) and out.confirmed


def test_unknown_quote_symbols_use_the_short_negative_ttl() -> None:
    prov = V7Provider()
    clock = Clock()
    settings = Settings(quote_negative_ttl_s=300, cache_negative_ttl_s=3600)
    market = MarketService(prov, settings=settings, clock=clock)
    market.quotes(["AAPL", "NOPE"])
    clock.now += 299
    market.quotes(["NOPE"])
    assert prov.quote_calls == [["AAPL", "NOPE"]]
    clock.now += 2
    market.quotes(["NOPE"])
    assert prov.quote_calls == [["AAPL", "NOPE"], ["NOPE"]]


# ---------------------------------------------------------------- live poller


class StatefulQuotes(FakeProvider):
    def __init__(self, state: str | None) -> None:
        super().__init__()
        self.state = state

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        self.quote_calls.append(list(symbols))
        return [
            {"symbol": s, "last": 101.0, "change": 1.0, "marketState": self.state}
            for s in symbols
            if s in KNOWN
        ]


def test_closed_market_poll_respects_the_closed_ttl(tmp_path: Path) -> None:
    import time

    fake = StatefulQuotes("CLOSED")
    settings = Settings(live_poll_interval_s=0.01, quote_closed_ttl_s=600)
    app = create_app(
        provider=fake, database_url=f"sqlite:///{tmp_path}/c.db", settings_override=settings
    )
    with TestClient(app):
        poll = app.state.live_hub._poller
        assert set(poll_once(poll, ["AAPL"])) == {"AAPL"}
        time.sleep(0.05)
        assert set(poll_once(poll, ["AAPL"])) == {"AAPL"}
    assert fake.quote_calls == [["AAPL"]]  # the second poll came from the cache


def test_poll_during_cooldown_broadcasts_nothing(tmp_path: Path) -> None:
    import time

    fake = StatefulQuotes("REGULAR")
    settings = Settings(quote_ttl_s=0.01, upstream_cooldown_max_s=900)
    app = create_app(
        provider=fake, database_url=f"sqlite:///{tmp_path}/d.db", settings_override=settings
    )
    with TestClient(app) as client:
        poll = app.state.live_hub._poller
        assert set(poll_once(poll, ["AAPL", "MSFT"])) == {"AAPL", "MSFT"}
        time.sleep(0.05)
        app.state.upstream_guard.on_rate_limited(60)
        assert poll_once(poll, ["AAPL", "MSFT"]) == {}  # stale values are not live ticks
        # Interactive requests still get the stale values.
        res = client.get("/api/quotes", params={"symbols": "AAPL,MSFT"})
        assert [q["symbol"] for q in res.json()] == ["AAPL", "MSFT"]
    assert fake.quote_calls == [["AAPL", "MSFT"]]
