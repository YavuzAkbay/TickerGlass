"""Crypto exchanges for tests: `Send`s answering like Kraken, Coinbase and Binance. Markets,
tickers, errors and stream frames come from the trimmed recordings in `tests/fixtures/crypto/`
(live responses of 2026-11-17); bars are generated, deterministically, so ranges, paging limits
and bar alignment can be exercised for any window. Nothing touches the network."""

import json
from calendar import monthrange
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

FIXTURES = Path(__file__).parent / "fixtures" / "crypto"
Answer = tuple[int, dict[str, str], Any]
MONDAY_OFFSET = 4 * 86400


def fixture(name: str) -> Any:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def ohlcv(ts: int) -> tuple[float, float, float, float, float]:
    """The bar opening at `ts`: open, high, low, close, volume (a function of the time)."""
    base = 100.0 + (ts // 60) % 97
    return base, base + 2, base - 2, base + 1, 10.0


def newest(step: int | str, hi: int, count: int) -> list[int]:
    """The `count` newest bar open times at or before `hi` (unix seconds), newest first. `step`
    is seconds, `"week"` (Mondays 00:00 UTC) or `"month"` (the first, 00:00 UTC)."""
    out: list[int] = []
    if step == "month":
        moment = datetime.fromtimestamp(hi, UTC)
        year, month = moment.year, moment.month
        while len(out) < count:
            out.append(int(datetime(year, month, 1, tzinfo=UTC).timestamp()))
            year, month = (year - 1, 12) if month == 1 else (year, month - 1)
        return out
    size = 7 * 86400 if step == "week" else int(step)
    offset = MONDAY_OFFSET if step == "week" else 0
    t = (hi - offset) // size * size + offset
    while len(out) < count and t >= 0:
        out.append(t)
        t -= size
    return out


class FakeExchange:
    """Callable `Send`. `calls` records (path, params); `urls` the raw URLs; `answers` maps a path
    to a function `(params) -> (status, headers, body)` replacing the default route. `now` is the
    exchange's clock, `listed_since` the open time of its oldest bar."""

    def __init__(self, now: datetime, listed_since: datetime | None = None) -> None:
        self.now = now
        self.now_s = int(now.timestamp())
        self.listed_s = int((listed_since or datetime(2025, 1, 1, tzinfo=UTC)).timestamp())
        self.calls: list[tuple[str, dict[str, str]]] = []
        self.urls: list[str] = []
        self.headers: list[Mapping[str, str]] = []
        self.answers: dict[str, Callable[[dict[str, str]], Answer]] = {}

    def paths(self) -> list[str]:
        return [path for path, _ in self.calls]

    def count(self, path: str) -> int:
        return self.paths().count(path)

    def __call__(
        self, url: str, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, Mapping[str, str], bytes]:
        parts = urlsplit(url)
        pairs = parse_qsl(parts.query)
        params = dict(pairs)
        self.urls.append(url)
        self.headers.append(headers)
        self.calls.append((parts.path, params))
        handler = self.answers.get(parts.path)
        if handler is not None:
            status, head, body = handler(params)
        else:
            status, head, body = self.route(parts.path, params, pairs)
        return status, head, json.dumps(body).encode()

    def route(self, path: str, params: dict[str, str], pairs: list[tuple[str, str]]) -> Answer:
        raise NotImplementedError


class FakeKraken(FakeExchange):
    KEYS = {"XBTUSD": "XXBTZUSD", "ETHUSD": "XETHZUSD", "XDGUSD": "XDGUSD", "ADAUSD": "ADAUSD"}
    STEPS = {"1": 60, "5": 300, "15": 900, "30": 1800, "60": 3600, "240": 14400, "1440": 86400}

    def route(self, path: str, params: dict[str, str], pairs: list[tuple[str, str]]) -> Answer:
        if path == "/0/public/AssetPairs":
            return 200, {}, fixture("kraken_assetpairs")
        if path == "/0/public/OHLC":
            return self._ohlc(params)
        if path == "/0/public/Ticker":
            names = params["pair"].split(",")
            if any(n not in self.KEYS for n in names):
                return 200, {}, fixture("kraken_error_unknown_pair")
            rows = fixture("kraken_ticker")["result"]
            found = {self.KEYS[n]: rows[self.KEYS[n]] for n in names if self.KEYS[n] in rows}
            return 200, {}, {"error": [], "result": found}
        return 404, {}, {"error": [f"unknown endpoint {path}"]}

    def _ohlc(self, params: dict[str, str]) -> Answer:
        key = self.KEYS.get(params["pair"])
        if key is None:
            return 200, {}, fixture("kraken_error_unknown_pair")
        step = self.STEPS[params["interval"]]
        # Kraken keeps the latest 720 bars; the last one is still forming. A `since` older than
        # the kept window answers all of them.
        times = sorted(newest(step, self.now_s, 720))
        since = int(params.get("since", 0))
        rows = []
        for t in times:
            if t > since:
                o, h, low, c, v = ohlcv(t)
                rows.append([t, f"{o}", f"{h}", f"{low}", f"{c}", f"{c}", f"{v}", 5])
        return 200, {}, {"error": [], "result": {key: rows, "last": times[-2]}}


class FakeCoinbase(FakeExchange):
    IDS = {"BTC-USD", "ETH-USD", "ETH-BTC", "BTC-USDT"}
    STEPS = {
        "ONE_MINUTE": 60,
        "FIVE_MINUTE": 300,
        "FIFTEEN_MINUTE": 900,
        "THIRTY_MINUTE": 1800,
        "ONE_HOUR": 3600,
        "TWO_HOUR": 7200,
        "SIX_HOUR": 21600,
        "ONE_DAY": 86400,
    }
    PRODUCTS = "/api/v3/brokerage/market/products"

    def route(self, path: str, params: dict[str, str], pairs: list[tuple[str, str]]) -> Answer:
        if path == self.PRODUCTS:
            body = fixture("coinbase_products")
            wanted = [v for k, v in pairs if k == "product_ids"]
            if wanted:
                found = [p for p in body["products"] if p["product_id"] in wanted]
                body = {"products": found, "num_products": len(found)}
            return 200, {}, body
        prefix = f"{self.PRODUCTS}/"
        if path.startswith(prefix) and path.endswith("/candles"):
            return self._candles(path[len(prefix) : -len("/candles")], params)
        return 404, {}, {"error": "NOT_FOUND", "message": f"unknown endpoint {path}"}

    def _candles(self, product: str, params: dict[str, str]) -> Answer:
        if product not in self.IDS:
            return 400, {}, fixture("coinbase_error_product")
        step = self.STEPS[params["granularity"]]
        start, end = int(params["start"]), int(params["end"])
        if (end - start) / step >= 350:
            message = (
                "start and end argument is invalid - "
                "number of candles requested should be less than 350"
            )
            return 400, {}, {"error": "INVALID_ARGUMENT", "message": message}
        out = []
        for t in newest(step, min(end, self.now_s), 400):
            if t < start or t < self.listed_s:
                break
            o, h, low, c, v = ohlcv(t)
            out.append(
                {
                    "start": str(t),
                    "low": str(low),
                    "high": str(h),
                    "open": str(o),
                    "close": str(c),
                    "volume": str(v),
                }
            )
        return 200, {}, {"candles": out}


class FakeBinance(FakeExchange):
    SYMBOLS = {"BTCUSDT", "ETHUSDT", "ETHBTC", "BTCUSDC"}
    STEPS: dict[str, int | str] = {
        "1m": 60,
        "5m": 300,
        "15m": 900,
        "30m": 1800,
        "1h": 3600,
        "1d": 86400,
        "1w": "week",
        "1M": "month",
    }

    def route(self, path: str, params: dict[str, str], pairs: list[tuple[str, str]]) -> Answer:
        if path == "/api/v3/exchangeInfo":
            return 200, {}, fixture("binance_exchangeinfo")
        if path == "/api/v3/klines":
            return self._klines(params)
        if path == "/api/v3/ticker/24hr":
            names = json.loads(params["symbols"])
            if any(n not in self.SYMBOLS for n in names):
                return 400, {}, fixture("binance_error_symbol")
            return 200, {}, [r for r in fixture("binance_ticker24h") if r["symbol"] in names]
        return 404, {}, {"code": -1, "msg": f"unknown endpoint {path}"}

    def _klines(self, params: dict[str, str]) -> Answer:
        if params["symbol"] not in self.SYMBOLS:
            return 400, {}, fixture("binance_error_symbol")
        step = self.STEPS[params["interval"]]
        limit = min(int(params.get("limit", 500)), 1000)
        hi = min(int(params["endTime"]) // 1000 if "endTime" in params else self.now_s, self.now_s)
        times = [t for t in newest(step, hi, limit) if t >= self.listed_s]
        rows = []
        for t in reversed(times):
            o, h, low, c, v = ohlcv(t)
            span = _span(step, t)
            rows.append(
                [t * 1000, f"{o}", f"{h}", f"{low}", f"{c}", f"{v}", (t + span) * 1000 - 1, "0"]
            )
        return 200, {}, rows


def _span(step: int | str, t: int) -> int:
    if step == "week":
        return 7 * 86400
    if step == "month":
        moment = datetime.fromtimestamp(t, UTC)
        return monthrange(moment.year, moment.month)[1] * 86400
    return int(step)
