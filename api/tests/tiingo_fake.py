"""A Tiingo server for tests: a `Send` answering from the hand-built responses in
`tests/fixtures/tiingo/` (documented shapes, not recordings), so nothing touches the network."""

import json
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "tiingo"

Answer = tuple[int, dict[str, str], Any]

KNOWN_STOCKS = {"aapl", "brk-b"}
KNOWN_CRYPTO = {"btcusd"}


def record(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((FIXTURES / f"{name}.json").read_text())
    return data


def body_of(name: str) -> Any:
    return record(name)["body"]


def error(name: str) -> Answer:
    """One of the canned error answers of `errors.json`."""
    rec = record("errors")[name]
    return rec["status"], rec["headers"], rec["body"]


def daily_rows() -> list[dict[str, Any]]:
    """Daily bars: a generated weekday series (2025-01-01 .. 2026-10-19) followed by the six
    hand-built ones of `daily_aapl.json` (2026-10-20 .. 2026-10-27)."""
    rows: list[dict[str, Any]] = []
    day = date(2025, 1, 1)
    n = 0
    while day < date(2026, 10, 20):
        if day.weekday() < 5:
            base = 200 + n * 0.25
            rows.append(
                {
                    "date": f"{day.isoformat()}T00:00:00.000Z",
                    "close": base + 1,
                    "high": base + 2,
                    "low": base - 1,
                    "open": base,
                    "volume": 1_000_000 + n,
                    "adjClose": base + 0.5,
                    "splitFactor": 1.0,
                    "divCash": 0.0,
                }
            )
            n += 1
        day += timedelta(days=1)
    return rows + list(body_of("daily_aapl"))


def crypto_5min_rows() -> list[dict[str, Any]]:
    """Two hours of 5-minute crypto bars from 00:00 UTC of 2026-10-26 and 2026-10-27."""
    rows = []
    for day in (26, 27):
        start = datetime(2026, 10, day, tzinfo=UTC)
        for i in range(24):
            stamp = start + timedelta(minutes=5 * i)
            price = 93000.0 + day * 10 + i
            rows.append(
                {
                    "date": stamp.isoformat(),
                    "open": price,
                    "high": price + 5,
                    "low": price - 5,
                    "close": price + 1,
                    "volume": 2.5,
                }
            )
    return rows


def _within(rows: list[dict[str, Any]], params: Mapping[str, str]) -> list[dict[str, Any]]:
    start, end = params.get("startDate", "0000-00-00"), params.get("endDate", "9999-99-99")
    return [r for r in rows if start <= r["date"][:10] <= end]


class FakeTiingo:
    """Callable `Send`. `calls` records (path, params, request headers); `urls` the full URLs;
    `answers` maps an exact path to a function `(params) -> (status, headers, body)` replacing
    the default route."""

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
        params = dict(parse_qsl(parts.query))
        self.urls.append(url)
        self.calls.append((parts.path, params, dict(headers)))
        handler = self.answers.get(parts.path)
        status, head, body = handler(params) if handler else self.route(parts.path, params)
        return status, head, json.dumps(body).encode()

    # -- default route ------------------------------------------------------------------

    def route(self, path: str, params: dict[str, str]) -> Answer:
        segments = [s for s in path.split("/") if s]
        if segments[:2] == ["tiingo", "daily"] and len(segments) == 4 and segments[3] == "prices":
            return self._stock_bars(segments[2], daily_rows(), params)
        if segments[:2] == ["tiingo", "daily"] and len(segments) == 3:
            return self._stock_meta(segments[2])
        if segments[0] == "iex" and len(segments) == 3 and segments[2] == "prices":
            return self._stock_bars(segments[1], body_of("intraday_5min_aapl"), params)
        if path == "/iex/":
            return self._quotes(params)
        if path == "/tiingo/crypto/prices":
            return self._crypto_bars(params)
        if path == "/tiingo/crypto":
            wanted = set(params.get("tickers", "").split(","))
            return 200, {}, [m for m in body_of("meta_crypto_btcusd") if m["ticker"] in wanted]
        if path == "/tiingo/utilities/search":
            return 200, {}, body_of("search_aapl")
        return 404, {}, {"detail": "Not found."}

    @staticmethod
    def _stock_bars(ticker: str, rows: list[dict[str, Any]], params: dict[str, str]) -> Answer:
        if ticker not in KNOWN_STOCKS:
            return error("not_found")
        return 200, {}, _within(rows, params)

    @staticmethod
    def _stock_meta(ticker: str) -> Answer:
        if ticker not in KNOWN_STOCKS:
            return error("not_found")
        meta = dict(body_of("meta_aapl"))
        meta["ticker"] = ticker.upper()
        if ticker != "aapl":
            meta["name"] = "Berkshire Hathaway Inc"
            meta["exchangeCode"] = "NYSE"
        return 200, {}, meta

    @staticmethod
    def _quotes(params: dict[str, str]) -> Answer:
        wanted = set(params.get("tickers", "").lower().split(","))
        return 200, {}, [q for q in body_of("quotes_iex") if q["ticker"].lower() in wanted]

    @staticmethod
    def _crypto_bars(params: dict[str, str]) -> Answer:
        out = []
        for ticker in params.get("tickers", "").split(","):
            if ticker not in KNOWN_CRYPTO:
                continue
            if params.get("resampleFreq") == "1day":
                data = _within(body_of("crypto_daily_btcusd")[0]["priceData"], params)
            else:
                data = _within(crypto_5min_rows(), params)
            out.append(
                {"ticker": ticker, "baseCurrency": "btc", "quoteCurrency": "usd", "priceData": data}
            )
        return 200, {}, out
