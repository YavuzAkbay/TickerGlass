"""Coinbase Advanced Trade public market data (`api.coinbase.com` and the WebSocket at
`advanced-trade-ws.coinbase.com`), no key.

Confirmed against the live API on 2026-11-17 (fixtures in tests/fixtures/crypto/ are trimmed
recordings); the `/market/` endpoints answer without credentials:

- `GET /api/v3/brokerage/market/products?product_type=SPOT` lists every product with its current
  `price`, `price_percentage_change_24h`, `volume_24h`, `high_24h`, `low_24h`, `price_increment`,
  `status` (`online`, `delisted`), `trading_disabled`, `base_display_symbol`,
  `quote_display_symbol`, `base_name` and `quote_name`. The same endpoint with repeated
  `product_ids=` answers just those products (unknown ones are left out), which serves as the
  batch quote request. Coinbase's product ids are the canonical `BASE-QUOTE` symbols.
- `GET /api/v3/brokerage/market/products/{id}/candles?start=&end=&granularity=` answers
  `{"candles": [{"start": "<unix s>", "low", "high", "open", "close", "volume"}]}`, newest first,
  numbers as strings; more than 349 candles in the window is a 400, so a page is 300. The
  granularities are ONE_MINUTE, FIVE_MINUTE, FIFTEEN_MINUTE, THIRTY_MINUTE, ONE_HOUR, TWO_HOUR,
  SIX_HOUR and ONE_DAY: weekly and longer bars are built from daily ones.
- A bad product id is a 400 `INVALID_ARGUMENT` ("valid product_id is required").
- WebSocket: no authentication for the `ticker` channel. `{"type": "subscribe", "product_ids":
  [...], "channel": "ticker"}`; frames are `{"channel": "ticker", "timestamp", "events": [{"type":
  "snapshot" | "update", "tickers": [{"product_id", "price", "volume_24_h", "low_24_h",
  "high_24_h", "price_percent_chg_24_h", ...}]}]}`. Unknown products are dropped silently
  (the `subscriptions` acknowledgement lists the accepted ones).

Unverified: the 429 answer and its `Retry-After`, that ONE_DAY candles start at 00:00 UTC (the
provider assumes so, as the UTC day is what Coinbase documents), and the 5-second rule for
sending a first subscribe after connecting (the live source only connects once it has symbols).
"""

import logging
import urllib.parse
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from ..base import ProviderError, SymbolNotFound
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
    parse_time,
    positive_price,
)

log = logging.getLogger(__name__)

#: Candles per page (the API refuses 350 and more).
PAGE_SIZE = 300
_PRODUCTS = "/api/v3/brokerage/market/products"


def open_from_percent(last: float, percent: float | None) -> float | None:
    """The price `percent` ago that `last` is `percent` away from."""
    if percent is None or percent <= -100:
        return None
    return last / (1 + percent / 100)


class CoinbaseStream(Stream):
    url = "wss://advanced-trade-ws.coinbase.com"

    def symbol(self, canonical: str) -> str:
        return canonical

    def subscribe(self, ids: Sequence[str]) -> list[Any]:
        return [{"type": "subscribe", "product_ids": list(ids), "channel": "ticker"}] if ids else []

    def unsubscribe(self, ids: Sequence[str]) -> list[Any]:
        return (
            [{"type": "unsubscribe", "product_ids": list(ids), "channel": "ticker"}] if ids else []
        )

    def parse(self, message: Any) -> list[dict[str, Any]]:
        if not isinstance(message, Mapping):
            return []
        if message.get("type") == "error" or message.get("channel") == "error":
            log.warning("Coinbase stream error: %s", message.get("message"))
            return []
        if message.get("channel") != "ticker":
            return []
        stamp = parse_time(message.get("timestamp"))
        ticks: list[dict[str, Any]] = []
        for event in _list(message.get("events")):
            for item in _list(event.get("tickers") if isinstance(event, Mapping) else None):
                if not isinstance(item, Mapping):
                    continue
                product, price = item.get("product_id"), positive_price(item.get("price"))
                if not isinstance(product, str) or price is None:
                    continue
                percent = num(item.get("price_percent_chg_24_h"))
                before = open_from_percent(price, percent)
                tick: dict[str, Any] = {
                    "id": product,
                    "price": price,
                    "change": price - before if before is not None else None,
                    "change_percent": percent,
                    "day_volume": num(item.get("volume_24_h")),
                    "day_high": num(item.get("high_24_h")),
                    "day_low": num(item.get("low_24_h")),
                    "market_hours": 1,
                }
                if stamp is not None:
                    tick["time"] = int(stamp.timestamp() * 1000)
                ticks.append(tick)
        return ticks


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


class Coinbase(CryptoExchange):
    id = "coinbase"
    name = "Coinbase"
    base_url = "https://api.coinbase.com"
    native = {
        "1m": "ONE_MINUTE",
        "5m": "FIVE_MINUTE",
        "15m": "FIFTEEN_MINUTE",
        "30m": "THIRTY_MINUTE",
        "60m": "ONE_HOUR",
        "1d": "ONE_DAY",
    }
    quote_batch = 50
    # Public endpoints allow about ten requests a second per IP.
    profile = Profile(
        calls_per_min=300,
        burst=10,
        quote_ttl_s=10,
        poll_interval_s=10,
        tail_ttl_intraday_s=15,
        tail_ttl_daily_s=60,
    )
    stream = CoinbaseStream

    def error(self, status: int, body: Any, symbol: str) -> ProviderError:
        message = ""
        if isinstance(body, Mapping):
            message = str(body.get("message") or body.get("error") or "")
        if status in (401, 403, 451):
            return self.refused(status)
        if status == 404 or (status == 400 and "product_id" in message.lower()):
            return SymbolNotFound(symbol)
        return ProviderError(f"{self.name}: {message or f'HTTP {status}'}")

    def load_markets(self) -> list[Market]:
        body = self.get(_PRODUCTS, {"product_type": "SPOT"})
        return [m for m in (_market(p) for p in _products(body)) if m is not None]

    def bars_page(
        self, market: Market, interval: str, start: datetime | None, end: datetime
    ) -> Page:
        seconds = INTERVAL_SECONDS[interval]
        end_s = int(end.timestamp())
        floor_s = int(start.timestamp()) if start is not None else None
        window_s = end_s - PAGE_SIZE * seconds
        if floor_s is not None:
            window_s = max(window_s, floor_s)
        rows: list[Row] = []
        if window_s < end_s:
            body = self.get(
                f"{_PRODUCTS}/{market.id}/candles",
                {"start": str(window_s), "end": str(end_s), "granularity": self.native[interval]},
                market.symbol,
            )
            candles = body.get("candles") if isinstance(body, Mapping) else None
            for c in _list(candles):
                if not isinstance(c, Mapping):
                    continue
                ts = num(c.get("start"))
                o, h, low, close, v = (
                    num(c.get(k)) for k in ("open", "high", "low", "close", "volume")
                )
                if ts is None or o is None or h is None or low is None or close is None:
                    continue
                rows.append((int(ts), o, h, low, close, v or 0.0))
        # An empty window may be a gap, so a bounded request goes on to the start; without
        # a start an empty window means the history has begun.
        more = (floor_s is not None and window_s > floor_s) or (floor_s is None and bool(rows))
        return Page(rows, datetime.fromtimestamp(window_s, UTC) if more else None)

    def tickers(self, markets: Sequence[Market]) -> dict[str, Ticker]:
        # `product_ids` repeats, which a params mapping cannot say: it rides on the path.
        query = "&".join(f"product_ids={urllib.parse.quote(m.id, safe='-')}" for m in markets)
        body = self.get(f"{_PRODUCTS}?{query}", {})
        by_id = {m.id: m for m in markets}
        out: dict[str, Ticker] = {}
        for item in _products(body):
            market = by_id.get(str(item.get("product_id")))
            last = positive_price(item.get("price"))
            if market is None or last is None:
                continue
            out[market.symbol] = Ticker(
                last=last,
                open=open_from_percent(last, num(item.get("price_percentage_change_24h"))),
                high=num(item.get("high_24h")),
                low=num(item.get("low_24h")),
                volume=num(item.get("volume_24h")),
            )
        return out


def _products(body: Any) -> list[Mapping[str, Any]]:
    products = body.get("products") if isinstance(body, Mapping) else None
    return [p for p in _list(products) if isinstance(p, Mapping)]


def _market(product: Mapping[str, Any]) -> Market | None:
    product_id = product.get("product_id")
    base, quote = product.get("base_display_symbol"), product.get("quote_display_symbol")
    if not isinstance(product_id, str) or not isinstance(base, str) or not isinstance(quote, str):
        return None
    if product.get("status", "online") != "online" or product.get("trading_disabled"):
        return None
    if product.get("is_disabled"):
        return None
    base_name, quote_name = product.get("base_name"), product.get("quote_name")
    name = f"{base_name} / {quote_name}" if base_name and quote_name else f"{base} / {quote}"
    return Market(
        symbol=f"{base.upper()}-{quote.upper()}",
        base=base.upper(),
        quote=quote.upper(),
        name=name,
        id=product_id,
        tick=num(product.get("price_increment")),
    )
