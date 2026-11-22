"""A Massive server for tests: a `Send` answering from the hand-built responses in
`tests/fixtures/massive/` (documented shapes, not recordings), so nothing touches the
network."""

import json
import re
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, unquote, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "massive"

Answer = tuple[int, dict[str, str], Any]

_AGGS = re.compile(r"/v2/aggs/ticker/([^/]+)/range/(\d+)/(\w+)/([^/]+)/([^/]+)")
_DETAILS = re.compile(r"/v3/reference/tickers/([^/]+)")


def record(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return data


def body_of(name: str) -> Any:
    return record(name)["body"]


def answer_of(name: str) -> Answer:
    rec = record(name)
    return rec["status"], rec["headers"], rec["body"]


def error(status: str, message: str) -> dict[str, Any]:
    return {"status": status, "request_id": "test", "message": message}


def monthly_results() -> list[dict[str, Any]]:
    """Ten monthly bars (newest first), January to October 2026, `t` at New York midnight."""
    starts = [
        1767243600000,
        1769922000000,
        1772341200000,
        1775016000000,
        1777608000000,
        1780286400000,
        1782878400000,
        1785556800000,
        1788235200000,
        1790827200000,
    ]
    return [
        {"v": 1000, "o": 100 + m, "h": 110 + m, "l": 90 + m, "c": 105 + m, "t": starts[m - 1]}
        for m in range(10, 0, -1)
    ]


class FakeMassive:
    """Callable `Send`. `calls` records (path, params, request headers); `urls` the full
    URLs; `answers` maps an exact path to a function `(params) -> (status, headers, body)`
    replacing the default route."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, str], Mapping[str, str]]] = []
        self.urls: list[str] = []
        self.answers: dict[str, Callable[[dict[str, str]], Answer]] = {}

    def paths(self) -> list[str]:
        return [path for path, _, _ in self.calls]

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, Mapping[str, str], bytes]:
        parts = urlsplit(url)
        path = unquote(parts.path)
        params = dict(parse_qsl(parts.query))
        self.urls.append(url)
        self.calls.append((path, params, dict(headers)))
        handler = self.answers.get(path)
        status, head, body = handler(params) if handler else self.route(path, params)
        return status, head, json.dumps(body).encode()

    # -- default route ------------------------------------------------------------------

    def route(self, path: str, params: dict[str, str]) -> Answer:
        if m := _AGGS.fullmatch(path):
            return self._aggs(m[1], m[3])
        if path == "/v3/reference/tickers":
            return self._search(params.get("search", "").upper())
        if m := _DETAILS.fullmatch(path):
            return self._details(m[1])
        if path == "/v2/snapshot/locale/us/markets/stocks/tickers":
            return self._snapshot("snapshot_stocks", params["tickers"].split(","))
        if path == "/v2/snapshot/locale/global/markets/crypto/tickers":
            return self._snapshot("snapshot_crypto", params["tickers"].split(","))
        return 404, {}, error("NOT_FOUND", f"unknown endpoint {path}")

    @staticmethod
    def _aggs(ticker: str, span: str) -> Answer:
        if ticker == "ZZZZNOTREAL":
            return answer_of("aggs_empty")
        status, head, body = answer_of("aggs_1m_aapl" if span == "minute" else "aggs_1d_aapl")
        body = {**body, "ticker": ticker}
        if span == "month":
            results = monthly_results()
            body = {**body, "results": results, "resultsCount": len(results)}
        return status, head, body

    @staticmethod
    def _search(query: str) -> Answer:
        if query in ("AAPL", "APPLE"):
            return answer_of("search_aapl")
        return 200, {}, {"status": "OK", "request_id": "test", "count": 0}

    @staticmethod
    def _details(ticker: str) -> Answer:
        if ticker == "AAPL":
            return answer_of("details_aapl")
        if ticker == "BRK.B":
            return answer_of("details_brkb")
        if ticker == "X:BTCUSD":
            row = {"ticker": ticker, "name": "Bitcoin - United States Dollar", "market": "crypto"}
            return 200, {}, {"status": "OK", "results": {**row, "currency_symbol": "USD"}}
        if ticker == "C:EURUSD":
            row = {"ticker": ticker, "name": "Euro - United States Dollar", "market": "fx"}
            return 200, {}, {"status": "OK", "results": {**row, "currency_symbol": "USD"}}
        return answer_of("details_notfound")

    @staticmethod
    def _snapshot(name: str, tickers: list[str]) -> Answer:
        body = body_of(name)
        rows = [t for t in body["tickers"] if t["ticker"] in tickers]
        return 200, {}, {**body, "tickers": rows, "count": len(rows)}
