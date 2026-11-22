"""Binance spot public market data (`data-api.binance.vision`, `data-stream.binance.vision`),
no key. Those are Binance's public market-data-only hosts: they serve spot data without the geo
block (HTTP 451) that `api.binance.com` applies to some regions. binance.us is a different
exchange and not covered.

Confirmed against the live API on 2026-11-17 (fixtures in tests/fixtures/crypto/ are trimmed
recordings):

- `GET /api/v3/exchangeInfo` lists `symbols` with `symbol` (`BTCUSDT`), `status` (`TRADING`),
  `baseAsset`, `quoteAsset`, `isSpotTradingAllowed` and the `PRICE_FILTER` `tickSize`; its
  `rateLimits` say 6000 request weight a minute. The request carries `symbolStatus=TRADING`
  (a documented filter, not run against the live API; the status is checked here as well).
- `GET /api/v3/klines?symbol=&interval=&limit=&endTime=` answers rows `[openTime ms, open, high,
  low, close, volume, closeTime, ...]` with prices as strings; at most 1000. With only `endTime`
  it answers the newest bars before it, which is how history pages walk backwards (with a
  `startTime` too it would answer the oldest bars after it). Weekly (`1w`) bars open on Mondays
  00:00 UTC and monthly (`1M`) on the first of the month; `2m`, `90m` and `3mo` are built.
- `GET /api/v3/ticker/24hr?symbols=["A","B"]` answers a rolling 24-hour row per symbol:
  `lastPrice`, `openPrice` (24 hours ago), `highPrice`, `lowPrice`, `volume` (base asset),
  `closeTime`. One unknown symbol refuses the whole request, so the provider only asks for
  symbols the markets list holds.
- An unknown symbol is a 400 `{"code": -1121, "msg": "Invalid symbol."}`.
- WebSocket `wss://data-stream.binance.vision/ws`: `{"method": "SUBSCRIBE", "params":
  ["btcusdt@miniTicker"], "id": 1}` is acknowledged `{"result": null, "id": 1}`; an unknown
  symbol is accepted and simply never streams. `24hrMiniTicker` frames carry `s`, `c` (last),
  `o` (24-hour open), `h`, `l`, `v` (base volume), `E` (event time ms), about once a second.

Unverified: the 429 / 418 answers (a ban says "banned until <ms>" in `msg`) and `Retry-After`.
"""

import json
import logging
import math
import re
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from ..base import ProviderError, RateLimited, SymbolNotFound
from .base import (
    INTERVAL_SECONDS,
    CryptoExchange,
    Market,
    Page,
    Profile,
    Row,
    Stream,
    Ticker,
    num,
    positive_price,
)

log = logging.getLogger(__name__)

#: Bars per klines request (the API maximum).
PAGE_SIZE = 1000
_SECONDS = {**INTERVAL_SECONDS, "1wk": 7 * 86400, "1mo": 30 * 86400}
_BANNED_UNTIL = re.compile(r"banned until (\d{10,})")
_SUBSCRIBE_CHUNK = 100


class BinanceStream(Stream):
    url = "wss://data-stream.binance.vision/ws"

    def __init__(self) -> None:
        self._request_id = 0

    def symbol(self, canonical: str) -> str:
        return canonical.replace("-", "").lower()

    def _frames(self, method: str, ids: Sequence[str]) -> list[Any]:
        frames: list[Any] = []
        for i in range(0, len(ids), _SUBSCRIBE_CHUNK):
            self._request_id += 1
            params = [f"{s}@miniTicker" for s in ids[i : i + _SUBSCRIBE_CHUNK]]
            frames.append({"method": method, "params": params, "id": self._request_id})
        return frames

    def subscribe(self, ids: Sequence[str]) -> list[Any]:
        return self._frames("SUBSCRIBE", ids)

    def unsubscribe(self, ids: Sequence[str]) -> list[Any]:
        return self._frames("UNSUBSCRIBE", ids)

    def parse(self, message: Any) -> list[dict[str, Any]]:
        if not isinstance(message, Mapping):
            return []
        if "code" in message and "msg" in message:
            log.warning("Binance stream error %s: %s", message.get("code"), message.get("msg"))
            return []
        symbol, last = message.get("s"), positive_price(message.get("c"))
        if message.get("e") != "24hrMiniTicker" or not isinstance(symbol, str) or last is None:
            return []
        before = num(message.get("o"))
        tick: dict[str, Any] = {
            "id": symbol.lower(),
            "price": last,
            "day_volume": num(message.get("v")),
            "day_high": num(message.get("h")),
            "day_low": num(message.get("l")),
            "market_hours": 1,
        }
        if before:
            tick["change"] = last - before
            tick["change_percent"] = (last - before) / before * 100
        event = num(message.get("E"))
        if event is not None:
            tick["time"] = int(event)
        return [tick]


class Binance(CryptoExchange):
    id = "binance"
    name = "Binance"
    base_url = "https://data-api.binance.vision"
    native = {
        "1m": "1m",
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "60m": "1h",
        "1d": "1d",
        "1wk": "1w",
        "1mo": "1M",
    }
    # 24hr statistics of up to 20 symbols weigh 2; more cost 40.
    quote_batch = 20
    profile = Profile(
        calls_per_min=300,
        burst=10,
        quote_ttl_s=10,
        poll_interval_s=10,
        tail_ttl_intraday_s=15,
        tail_ttl_daily_s=60,
    )
    stream = BinanceStream

    def error(self, status: int, body: Any, symbol: str) -> ProviderError:
        code = body.get("code") if isinstance(body, Mapping) else None
        message = str(body.get("msg") or "") if isinstance(body, Mapping) else ""
        if status in (401, 403, 451):
            return self.refused(status)
        if code == -1121:
            return SymbolNotFound(symbol)
        if status == 418:
            # The IP is banned for ignoring 429s: "banned until <unix ms>".
            match = _BANNED_UNTIL.search(message)
            wait = int(int(match[1]) / 1000 - time.time()) if match else 120
            return RateLimited(f"{self.name}: IP banned for too many requests", max(1, wait))
        return ProviderError(f"{self.name}: {message or f'HTTP {status}'}")

    def load_markets(self) -> list[Market]:
        # `symbolStatus` filters server-side (documented in the Spot REST API, `exchangeInfo`);
        # the status is still checked below.
        body = self.get("/api/v3/exchangeInfo", {"symbolStatus": "TRADING"})
        symbols = body.get("symbols") if isinstance(body, Mapping) else None
        if not isinstance(symbols, list):
            raise ProviderError(f"{self.name}: unexpected exchangeInfo payload")
        markets: list[Market] = []
        for item in symbols:
            if not isinstance(item, Mapping):
                continue
            ident, base, quote = item.get("symbol"), item.get("baseAsset"), item.get("quoteAsset")
            if not isinstance(ident, str) or not isinstance(base, str):
                continue
            if not isinstance(quote, str) or item.get("status") != "TRADING":
                continue
            if item.get("isSpotTradingAllowed") is False:
                continue
            markets.append(
                Market(
                    symbol=f"{base.upper()}-{quote.upper()}",
                    base=base.upper(),
                    quote=quote.upper(),
                    name=f"{base.upper()} / {quote.upper()}",
                    id=ident,
                    tick=_tick_size(item),
                )
            )
        return markets

    def bars_page(
        self, market: Market, interval: str, start: datetime | None, end: datetime
    ) -> Page:
        limit = PAGE_SIZE
        if start is not None:
            span = (end - start).total_seconds()
            limit = min(PAGE_SIZE, max(2, math.ceil(span / _SECONDS[interval]) + 2))
        params = {
            "symbol": market.id,
            "interval": self.native[interval],
            "limit": str(limit),
            "endTime": str(int(end.timestamp() * 1000) - 1),
        }
        body = self.get("/api/v3/klines", params, market.symbol)
        if not isinstance(body, list):
            raise ProviderError(f"{self.name}: unexpected klines payload")
        rows: list[Row] = []
        for item in body:
            if not isinstance(item, list) or len(item) < 6:
                continue
            ts = num(item[0])
            o, h, low, c, v = (num(x) for x in item[1:6])
            if ts is None or o is None or h is None or low is None or c is None:
                continue
            rows.append((int(ts // 1000), o, h, low, c, v or 0.0))
        if not rows or len(body) < limit:
            return Page(rows, None)
        oldest = min(r[0] for r in rows)
        if start is not None and oldest <= start.timestamp():
            return Page(rows, None)
        return Page(rows, datetime.fromtimestamp(oldest, UTC))

    def tickers(self, markets: Sequence[Market]) -> dict[str, Ticker]:
        symbols = json.dumps([m.id for m in markets], separators=(",", ":"))
        body = self.get("/api/v3/ticker/24hr", {"symbols": symbols})
        if not isinstance(body, list):
            raise ProviderError(f"{self.name}: unexpected ticker payload")
        by_id = {m.id: m for m in markets}
        out: dict[str, Ticker] = {}
        for item in body:
            if not isinstance(item, Mapping):
                continue
            market = by_id.get(str(item.get("symbol")))
            last = positive_price(item.get("lastPrice"))
            if market is None or last is None:
                continue
            closed = num(item.get("closeTime"))
            out[market.symbol] = Ticker(
                last=last,
                open=num(item.get("openPrice")),
                high=num(item.get("highPrice")),
                low=num(item.get("lowPrice")),
                volume=num(item.get("volume")),
                time=int(closed // 1000) if closed is not None else None,
            )
        return out


def _tick_size(item: Mapping[str, Any]) -> float | None:
    filters = item.get("filters")
    for f in filters if isinstance(filters, list) else []:
        if isinstance(f, Mapping) and f.get("filterType") == "PRICE_FILTER":
            return num(f.get("tickSize"))
    return None
