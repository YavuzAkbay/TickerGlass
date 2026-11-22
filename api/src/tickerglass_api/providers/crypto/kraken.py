"""Kraken public market data (`api.kraken.com`, `wss://ws.kraken.com/v2`), no key.

Confirmed against the live API on 2026-11-17 (fixtures in tests/fixtures/crypto/ are trimmed
recordings):

- `GET /0/public/AssetPairs` keys pairs by Kraken's internal name (`XXBTZUSD`) and carries
  `altname` (`XBTUSD`), `wsname` (`XBT/USD`, the v1 spelling) and `tick_size`. Requests take the
  `altname`; answers are keyed by the internal name, so markets remember both.
- `GET /0/public/OHLC?pair=&interval=&since=` answers `{"error": [], "result": {"<key>": [[time,
  open, high, low, close, vwap, volume, count], ...], "last": <id>}}`, prices as strings, `time`
  the bar's open. It holds the latest 720 bars of each interval (a `since` older than that still
  answers those 720), and the last row is the bar still forming. So history is capped: 12 hours
  of 1m bars, 60 days of 1h, 720 days of 1d. Daily bars open at 00:00 UTC; weekly (`10080`) bars
  open on Thursdays (epoch aligned), so weeks are built from daily bars instead (Monday
  anchored, about two years of them).
- `GET /0/public/Ticker?pair=a,b` answers `c` (last, volume), `o` (today's open, 00:00 UTC), `h`,
  `l`, `v` (today, last 24 hours). A quote's change is measured from the day's open; live ticks
  carry the rolling 24-hour change, so the two differ a little.
- Errors arrive inside a 200 answer: `{"error": ["EQuery:Unknown asset pair"]}`. Rate limits are
  `EAPI:Rate limit exceeded` (and 429 behind a proxy).
- WebSocket v2 (`wss://ws.kraken.com/v2`) takes `{"method": "subscribe", "params": {"channel":
  "ticker", "symbol": ["BTC/USD"]}}` and uses the standard asset names (`BTC`, `DOGE`, not
  `XBT`, `XDG`). A symbol it does not know is refused alone (`success: false`) while the others
  subscribe. Ticker frames carry `last`, `volume`, `high`, `low`, `change`, `change_pct`
  (rolling 24 hours) and an RFC 3339 `timestamp`.
"""

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from ..base import ProviderError, RateLimited, SymbolNotFound, UpstreamUnavailable
from .base import (
    CryptoExchange,
    Market,
    Page,
    Profile,
    Row,
    Stream,
    Ticker,
    canonical_asset,
    num,
    parse_time,
    positive_price,
)

log = logging.getLogger(__name__)

#: Frames of a subscribe request hold at most this many symbols.
_SUBSCRIBE_CHUNK = 100


class KrakenStream(Stream):
    url = "wss://ws.kraken.com/v2"

    def symbol(self, canonical: str) -> str:
        return canonical.replace("-", "/")

    def _frames(self, method: str, ids: Sequence[str]) -> list[Any]:
        return [
            {
                "method": method,
                "params": {"channel": "ticker", "symbol": list(ids[i : i + _SUBSCRIBE_CHUNK])},
            }
            for i in range(0, len(ids), _SUBSCRIBE_CHUNK)
        ]

    def subscribe(self, ids: Sequence[str]) -> list[Any]:
        return self._frames("subscribe", ids)

    def unsubscribe(self, ids: Sequence[str]) -> list[Any]:
        return self._frames("unsubscribe", ids)

    def parse(self, message: Any) -> list[dict[str, Any]]:
        if not isinstance(message, Mapping):
            return []
        if message.get("success") is False:
            # One symbol refused (unknown pair): the others are unaffected, and the hub polls it.
            log.info("Kraken stream: %s", message.get("error"))
            return []
        if message.get("channel") != "ticker":
            return []
        data = message.get("data")
        ticks: list[dict[str, Any]] = []
        for item in data if isinstance(data, list) else []:
            if not isinstance(item, Mapping):
                continue
            symbol, price = item.get("symbol"), positive_price(item.get("last"))
            if not isinstance(symbol, str) or price is None:
                continue
            tick: dict[str, Any] = {
                "id": symbol,
                "price": price,
                "change": num(item.get("change")),
                "change_percent": num(item.get("change_pct")),
                "day_volume": num(item.get("volume")),
                "day_high": num(item.get("high")),
                "day_low": num(item.get("low")),
                "market_hours": 1,
            }
            moment = parse_time(item.get("timestamp"))
            if moment is not None:
                tick["time"] = int(moment.timestamp() * 1000)
            ticks.append(tick)
        return ticks


class Kraken(CryptoExchange):
    id = "kraken"
    name = "Kraken"
    base_url = "https://api.kraken.com"
    native = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60", "1d": "1440"}
    quote_batch = 40
    # Public calls are metered by Kraken per IP (about one a second sustained).
    profile = Profile(
        calls_per_min=50,
        burst=10,
        quote_ttl_s=15,
        poll_interval_s=15,
        tail_ttl_intraday_s=30,
        tail_ttl_daily_s=120,
    )
    stream = KrakenStream

    # -- errors -------------------------------------------------------------------------

    def unwrap(self, body: Any, symbol: str) -> Any:
        if not isinstance(body, Mapping):
            raise ProviderError(f"{self.name}: unexpected payload")
        errors = body.get("error")
        if isinstance(errors, list) and errors:
            raise self._api_error([str(e) for e in errors], symbol)
        result = body.get("result")
        if not isinstance(result, Mapping):
            raise ProviderError(f"{self.name}: unexpected payload")
        return result

    def _api_error(self, errors: list[str], symbol: str) -> ProviderError:
        text = "; ".join(errors)
        first = errors[0]
        if first.startswith("EQuery:Unknown asset pair"):
            return SymbolNotFound(symbol)
        if first.startswith(
            ("EAPI:Rate limit", "EGeneral:Too many requests", "EService:Throttled")
        ):
            return RateLimited(f"{self.name}: {text}", 60)
        if first.startswith(("EService:", "EGeneral:Temporary lockout", "EGeneral:Internal")):
            return UpstreamUnavailable(f"{self.name}: {text}")
        return ProviderError(f"{self.name}: {text}")

    def error(self, status: int, body: Any, symbol: str) -> ProviderError:
        if status in (401, 403, 451):
            return self.refused(status)
        return ProviderError(f"{self.name}: HTTP {status}")

    # -- data ---------------------------------------------------------------------------

    def load_markets(self) -> list[Market]:
        result = self.get("/0/public/AssetPairs", {})
        markets: list[Market] = []
        for key, info in result.items():
            if not isinstance(info, Mapping):
                continue
            wsname, altname = info.get("wsname"), info.get("altname")
            if not isinstance(wsname, str) or not isinstance(altname, str) or "/" not in wsname:
                continue
            base, _, quote = wsname.partition("/")
            base, quote = canonical_asset(base), canonical_asset(quote)
            names = tuple(dict.fromkeys([str(key), altname]))
            markets.append(
                Market(
                    symbol=f"{base}-{quote}",
                    base=base,
                    quote=quote,
                    name=f"{base} / {quote}",
                    id=altname,
                    tick=num(info.get("tick_size")),
                    aliases=names,
                )
            )
        return markets

    def bars_page(
        self, market: Market, interval: str, start: datetime | None, end: datetime
    ) -> Page:
        params = {"pair": market.id, "interval": self.native[interval]}
        if start is not None:
            params["since"] = str(max(0, int(start.timestamp()) - 1))
        result = self.get("/0/public/OHLC", params, market.symbol)
        rows: list[Row] = []
        for key, value in result.items():
            if key == "last" or not isinstance(value, list):
                continue
            for item in value:
                if not isinstance(item, list) or len(item) < 7:
                    continue
                ts = num(item[0])
                o, h, low, c, v = (num(x) for x in (item[1], item[2], item[3], item[4], item[6]))
                if ts is None or o is None or h is None or low is None or c is None:
                    continue
                rows.append((int(ts), o, h, low, c, v or 0.0))
        # One request holds everything Kraken keeps (the newest 720 bars).
        return Page(rows, None)

    def tickers(self, markets: Sequence[Market]) -> dict[str, Ticker]:
        by_name = {name: m for m in markets for name in (m.id, *m.aliases)}
        result = self.get("/0/public/Ticker", {"pair": ",".join(m.id for m in markets)})
        out: dict[str, Ticker] = {}
        for key, item in result.items():
            market = by_name.get(str(key))
            if market is None or not isinstance(item, Mapping):
                continue
            last = _first(item.get("c"))
            if last is None:
                continue
            out[market.symbol] = Ticker(
                last=last,
                open=num(item.get("o")),
                high=_last_of_two(item.get("h")),
                low=_last_of_two(item.get("l")),
                volume=_last_of_two(item.get("v")),
            )
        return out


def _first(value: Any) -> float | None:
    """The price (above zero) at the head of a `[price, lot volume]` pair."""
    return positive_price(value[0]) if isinstance(value, list) and value else None


def _last_of_two(value: Any) -> float | None:
    """The 24-hour member of a `[today, last 24 hours]` pair."""
    return num(value[1]) if isinstance(value, list) and len(value) > 1 else None
