"""A Twelve Data server for tests: a `Send` answering from the responses recorded in
`tests/fixtures/twelvedata/` (see docs/providers.md), so nothing touches the network."""

import json
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "twelvedata"
CREDIT_HEADERS = ("api-credits-used", "api-credits-left")

Answer = tuple[int, dict[str, str], Any]


def record(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return data


def body_of(name: str) -> Any:
    return record(name)["body"]


def error(code: int, message: str) -> dict[str, Any]:
    return {"code": code, "message": message, "status": "error"}


def monthly_rows() -> list[dict[str, str]]:
    """Ten monthly bars (newest first), January to October 2026."""
    return [
        {
            "datetime": f"2026-{m:02d}-01",
            "open": str(100 + m),
            "high": str(110 + m),
            "low": str(90 + m),
            "close": str(105 + m),
            "volume": "1000",
        }
        for m in range(10, 0, -1)
    ]


def stock_search_row(symbol: str, name: str, exchange: str, mic: str, kind: str) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "instrument_name": name,
        "exchange": exchange,
        "mic_code": mic,
        "instrument_type": kind,
        "country": "",
        "currency": "USD",
    }


SEARCH: dict[str, list[dict[str, Any]]] = {
    "VOD": [
        {
            **stock_search_row("VOD", "Vodafone Group Plc", "LSE", "XLON", "Common Stock"),
            "currency": "GBp",
            "exchange_timezone": "Europe/London",
        }
    ],
    "EUR/USD": [stock_search_row("EUR/USD", "Euro / US Dollar", "Forex", "", "Physical Currency")],
    "BTC/USD": [
        stock_search_row("BTC/USD", "Bitcoin / US Dollar", "Binance", "", "Digital Currency")
    ],
    "SPX": [stock_search_row("SPX", "S&P 500", "INDEX", "", "Index")],
}


class FakeTD:
    """Callable `Send`. `calls` records (path, params, request headers); `answers` maps a
    path to a function `(params) -> (status, headers, body)` replacing the default route;
    `credits` (used, left) adds the credit headers a real server sends."""

    def __init__(self, credits: tuple[int, int] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, str], Mapping[str, str]]] = []
        self.urls: list[str] = []
        self.credits = credits
        self.answers: dict[str, Callable[[dict[str, str]], Answer]] = {}

    def paths(self) -> list[str]:
        return [path for path, _, _ in self.calls]

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, Mapping[str, str], bytes]:
        parts = urlsplit(url)
        params = dict(parse_qsl(parts.query))
        self.urls.append(url)
        self.calls.append((parts.path, params, dict(headers)))
        handler = self.answers.get(parts.path)
        if handler is not None:
            status, head, body = handler(params)
        else:
            status, head, body = self.route(parts.path, params)
            head = {k: v for k, v in head.items() if k not in CREDIT_HEADERS}
        if self.credits is not None:
            head["api-credits-used"], head["api-credits-left"] = map(str, self.credits)
        return status, head, json.dumps(body).encode()

    # -- default route ------------------------------------------------------------------

    def route(self, path: str, params: dict[str, str]) -> Answer:
        match path:
            case "/symbol_search":
                return 200, {}, self._search(params["symbol"].upper())
            case "/time_series":
                return self._time_series(params)
            case "/quote":
                return self._quote(params["symbol"].split(","))
            case "/dividends" | "/splits" | "/earnings" | "/profile" | "/api_usage":
                rec = record({"/api_usage": "api_usage_start"}.get(path, f"{path.strip('/')}_aapl"))
                return rec["status"], rec["headers"], rec["body"]
        return 404, {}, error(404, f"unknown endpoint {path}")

    @staticmethod
    def _search(query: str) -> dict[str, Any]:
        if query in ("AAPL", "APPLE"):
            return body_of("symbol_search_aapl")  # type: ignore[no-any-return]
        if query in ("BRK", "BRK.B"):
            return body_of("symbol_search_brk")  # type: ignore[no-any-return]
        return {"data": SEARCH.get(query, []), "status": "ok"}

    @staticmethod
    def _time_series(params: dict[str, str]) -> Answer:
        symbol, interval = params["symbol"], params["interval"]
        if symbol == "ZZZZNOTREAL":
            rec = record("time_series_notfound")
            return rec["status"], rec["headers"], rec["body"]
        if symbol == "BRK.B":
            rec = record("time_series_brkb")
            return rec["status"], rec["headers"], rec["body"]
        if interval == "1day":
            rec = record("time_series_1day_aapl")
        elif interval == "1week":
            rec = record("time_series_1week_aapl")
        elif interval == "1month":
            rec = record("time_series_1day_aapl")
            return 200, {}, {**rec["body"], "values": monthly_rows()}
        elif params.get("end_date") == "2026-10-26 12:42:00":  # the page after the first
            rec = record("time_series_1min_aapl_page2_synthetic")
        else:
            rec = record("time_series_1min_aapl")
        return rec["status"], rec["headers"], rec["body"]

    @staticmethod
    def _quote(keys: list[str]) -> Answer:
        batch = body_of("quote_batch")
        if len(keys) == 1:
            key = keys[0]
            if key == "ZZZZNOTREAL":
                return 404, {}, error(404, "**symbol** not found: ZZZZNOTREAL.")
            if key == "VOD:LSE":
                return 404, {}, error(404, "This symbol is available starting with the Grow plan")
            return 200, {}, {**batch["AAPL"], "symbol": key}
        out: dict[str, Any] = {}
        for key in keys:
            out[key] = batch.get(key) or {**batch["AAPL"], "symbol": key}
        return 200, {}, out
