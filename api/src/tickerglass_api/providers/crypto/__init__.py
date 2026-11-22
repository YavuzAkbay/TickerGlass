"""Crypto market data straight from an exchange's public API (docs/design/more-providers.md
section 6): Kraken, Coinbase or Binance spot, one at a time (`CRYPTO_EXCHANGE`, default
`kraken`), no key and no CCXT. Each exchange is a small adapter (`kraken.py`, `coinbase.py`,
`binance.py`, interface in `base.py`); this module is the `MarketDataProvider` over them and the
registry glue.

How it maps onto the app:

- Canonical symbols are `BASE-QUOTE` (`BTC-USD`, `ETH-USDT`, `ETH-BTC`). Kraken's `XBT` and `XDG`
  are accepted and read as `BTC` and `DOGE`. Anything not shaped like a pair (stocks, indices,
  FX, futures, `VOD.L`) is answered locally (`billable` / `answers_locally`), never sent.
- The exchange's markets list is loaded once a day (one request, charged to the guard) and
  serves symbol info, search and the check that a pair exists (`SymbolNotFound`).
- Bars: every interval is offered. Native ones come straight from the exchange; the rest are built
  from finer bars with `resample.py` (`2m` from 1m, `90m` from 30m, `1wk` from daily with Monday
  weeks (Binance has them natively), `1mo` and `3mo` from daily or monthly bars, all in UTC).
  Native intervals: Kraken 1m 5m 15m 30m 60m 1d; Coinbase the same; Binance those plus 1wk and
  1mo. History is paged newest first, so a range cut short by `max_pages` keeps its newest bars.
  Volume is in the base asset, `adj_close` is `close`, sessions are 24/7 (`prepost` is ignored)
  and daily bars open at 00:00 UTC.
- Kraken keeps only the latest 720 bars of each interval (12 hours of 1m, 60 days of 1h, 720 days
  of 1d): older history does not exist there, so deep ranges return what is kept and the
  synthesized weekly, monthly and quarterly bars reach back about two years. Coinbase and
  Binance page back as far as `max_pages` allows (300 and 1000 bars a request).
- Quotes are the exchange's rolling statistics: `volume`, `dayHigh` and `dayLow` cover the last
  24 hours ("day" is a rolling 24 hours for crypto, there is no session), the change is measured
  from the price 24 hours ago (Kraken's REST ticker only has the 00:00 UTC open, so its quotes
  measure from that; its live ticks carry the rolling 24-hour change). `volume` is the base-asset
  volume truncated to an integer.
- Live: every exchange has a public ticker WebSocket (`live.py`, via `providers/stream.py`); no
  key. Symbols the exchange lacks are never acknowledged and stay polled by the hub.
- Budget: per exchange, well under its documented public limits (`Profile`): Kraken 50 a minute,
  Coinbase and Binance 300, burst 10. Further pages and the markets load are charged with
  `charge_upstream`.
- Not offered: extended-hours quotes, events, news and fundamentals. The screener's universe is
  equities, so it stays off by default.

Facts confirmed against the live APIs on 2026-11-17 and what is still unverified are listed in the
module docstring of each adapter.
"""

import logging
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import pandas as pd
from pydantic import Field, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from ...live import LiveSource
from ...settings import Settings
from ..base import (
    Capabilities,
    CostModel,
    MarketDataProvider,
    PartialQuotes,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    charge_upstream,
)
from ..http import JsonHttp, Send, overridden_host, require_https
from ..stream import require_wss
from .base import (
    INTERVALS,
    CryptoExchange,
    Market,
    Ticker,
    align_start,
    bars_frame,
    canonical_asset,
    canonical_symbol,
    decimals,
    empty_frame,
    parse_symbol,
    plan_interval,
    synthesize,
)
from .binance import Binance
from .coinbase import Coinbase
from .kraken import Kraken
from .live import CryptoLiveSource

log = logging.getLogger(__name__)

PROVIDER_NAME = "Crypto"
#: Pages one history call may fetch (each after the first is a request more).
MAX_PAGES = 12
#: Seconds the markets list is reused, and how long a failed refresh keeps serving the old one.
MARKETS_TTL_S = 24 * 3600
MARKETS_RETRY_S = 300

EXCHANGES: dict[str, type[CryptoExchange]] = {
    Kraken.id: Kraken,
    Coinbase.id: Coinbase,
    Binance.id: Binance,
}


class CryptoConfig(BaseSettings):
    """`CRYPTO_*` settings: the exchange, and optional endpoint overrides (a proxy, a mirror)."""

    model_config = SettingsConfigDict(
        env_prefix="CRYPTO_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    exchange: Literal["kraken", "coinbase", "binance"] = Field(default="kraken", title="Exchange")
    base_url: str | None = Field(default=None, title="REST base URL")
    stream_url: str | None = Field(default=None, title="WebSocket URL")

    @field_validator("base_url", "stream_url")
    @classmethod
    def _secure_url(cls, value: str | None, info: ValidationInfo) -> str | None:
        # No key is sent, but a plain-http / ws endpoint can be tampered with in transit.
        if value is None:
            return None
        setting = f"CRYPTO_{info.field_name}".upper()
        if info.field_name == "stream_url":
            return require_wss(value, setting)
        return require_https(value, setting)


def exchange_class(config: BaseSettings | None) -> type[CryptoExchange]:
    """The adapter the config names; `None` (not configured yet) gives Kraken."""
    return EXCHANGES[config.exchange] if isinstance(config, CryptoConfig) else Kraken


def cache_identity(config: BaseSettings | None) -> str | None:
    """What tells one crypto cache from another: the exchange (bars, volumes and symbol info
    differ between them) and, for a proxy or mirror, its host."""
    if not isinstance(config, CryptoConfig):
        return None
    cls = EXCHANGES[config.exchange]
    host = overridden_host(config.base_url, cls.base_url) if config.base_url else None
    return f"{cls.id}@{host}" if host else cls.id


def capabilities_for(_: BaseSettings | None = None) -> Capabilities:
    return Capabilities(
        intervals=INTERVALS,
        extended_history=False,
        extended_quotes=False,
        adjusted_close=False,
        search=True,
        events=frozenset(),
        news=False,
        fundamentals_info=False,
        fundamentals_statements=False,
        streaming=True,
        markets=frozenset({"crypto"}),
    )


def costs_for(config: BaseSettings | None = None) -> CostModel:
    """Requests per operation as the guard charges them. The markets list behind search and
    symbol info is charged by the provider when it loads it (it is cached)."""
    return CostModel(
        history=1,
        symbol_info=0,
        search=0,
        quote_batch=exchange_class(config).quote_batch,
        quote_per_request=1,
        quote_per_symbol=0,
        events=0,
        news=0,
        fundamentals=0,
    )


def setting_defaults_for(config: BaseSettings | None) -> dict[str, Any]:
    profile = exchange_class(config).profile
    return {
        "upstream_rate_per_min": float(profile.calls_per_min),
        "upstream_burst": profile.burst,
        "quote_ttl_s": profile.quote_ttl_s,
        "live_poll_interval_s": profile.poll_interval_s,
        "bars_tail_ttl_intraday_s": profile.tail_ttl_intraday_s,
        "bars_tail_ttl_daily_s": profile.tail_ttl_daily_s,
    }


def plan_of(_: BaseSettings | None = None) -> str | None:
    return None


def make_provider(settings: Settings, config: BaseSettings | None) -> MarketDataProvider:
    assert isinstance(config, CryptoConfig)
    # A deep history call may page as far as the burst pays for, keeping one request of it.
    return CryptoProvider(config, max_pages=max(1, settings.upstream_burst - 1))


def make_live(_: MarketDataProvider, config: BaseSettings | None) -> LiveSource | None:
    assert isinstance(config, CryptoConfig)
    return CryptoLiveSource(exchange_class(config).stream(), url=config.stream_url)


@dataclass
class _Markets:
    by_symbol: dict[str, Market]
    expires: float


class CryptoProvider:
    """`MarketDataProvider` over one exchange's public REST API (stdlib HTTP, no key). Also a
    `SymbolRouting` provider."""

    def __init__(
        self,
        config: CryptoConfig,
        *,
        send: Send | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        max_pages: int | None = None,
    ) -> None:
        cls = exchange_class(config)
        self._clock = clock
        self._max_pages = max_pages
        http = JsonHttp(config.base_url or cls.base_url, send=send, provider="crypto")
        self.exchange: CryptoExchange = cls(http)
        self._name = cls.name
        #: The batch size the guard priced a quote call with (`costs_for`): chunks beyond what
        #: it paid for are charged here. `self.exchange.quote_batch` is what is sent.
        self._paid_batch = cls.quote_batch
        # Requests run on several threads: one markets load at a time.
        self._lock = threading.Lock()
        self._markets_cache: _Markets | None = None

    # -- symbols and markets ------------------------------------------------------------

    def billable(self, symbols: list[str]) -> list[str]:
        """The symbols a quote call would send: each once, without those that are not shaped like
        a crypto pair."""
        return [
            s
            for s in dict.fromkeys(x.strip().upper() for x in symbols)
            if parse_symbol(s) is not None
        ]

    def answers_locally(self, op: str, symbol: str) -> bool:
        """Events, news and fundamentals (not offered), symbols that are no crypto pair and, once
        the markets list is cached, pairs the exchange does not list cost no request."""
        if op in ("events", "fundamentals", "news"):
            return True
        canonical = canonical_symbol(symbol)
        if canonical is None:
            return True
        cached = self._markets_cache
        return (
            cached is not None
            and time.monotonic() < cached.expires
            and (canonical not in cached.by_symbol)
        )

    def _markets(self) -> dict[str, Market]:
        """The exchange's markets by canonical symbol, cached for a day. A load is a request of
        its own and charged as one; a failing refresh keeps serving the old list for a while."""
        with self._lock:
            cached = self._markets_cache
            now = time.monotonic()
            if cached is not None and now < cached.expires:
                return cached.by_symbol
            try:
                charge_upstream(1)
            except ProviderError as exc:
                if cached is None:
                    raise
                # The guard cannot pay for a refresh now: the old list serves meanwhile.
                log.info("%s: markets refresh skipped, keeping the old list: %s", self._name, exc)
                self._markets_cache = _Markets(cached.by_symbol, now + MARKETS_RETRY_S)
                return cached.by_symbol
            try:
                loaded = self.exchange.load_markets()
            except (ProviderNotConfigured, RateLimited):
                raise
            except ProviderError as exc:
                if cached is None:
                    raise
                log.warning("%s: markets refresh failed, keeping the old list: %s", self._name, exc)
                self._markets_cache = _Markets(cached.by_symbol, now + MARKETS_RETRY_S)
                return cached.by_symbol
            by_symbol: dict[str, Market] = {}
            for market in loaded:
                by_symbol.setdefault(market.symbol, market)
            self._markets_cache = _Markets(by_symbol, now + MARKETS_TTL_S)
            return by_symbol

    @staticmethod
    def _servable(symbol: str) -> str:
        """The canonical symbol, or `ProviderUnsupported` for what is no crypto pair."""
        canonical = canonical_symbol(symbol)
        if canonical is None:
            s = symbol.strip().upper()
            what = (
                "futures"
                if s.endswith("=F")
                else "index symbols"
                if s.startswith("^")
                else "forex pairs"
                if s.endswith("=X")
                else "stock symbols"
            )
            raise ProviderUnsupported(what, PROVIDER_NAME)
        return canonical

    def _market(self, symbol: str) -> Market:
        canonical = self._servable(symbol)
        market = self._markets().get(canonical)
        if market is None:
            raise SymbolNotFound(symbol)
        return market

    @staticmethod
    def _pay_for_page() -> bool:
        """Charge a request beyond the one the guard paid for. False when the guard's budget
        cannot pay (nothing is sent; what was already fetched is worth more than an error)."""
        try:
            charge_upstream(1)
        except ProviderError as exc:
            log.info("%s: guard refused a further request: %s", PROVIDER_NAME, exc)
            return False
        return True

    # -- history ------------------------------------------------------------------------

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        self._servable(symbol)
        plan = plan_interval(self.exchange.native, interval)
        if plan is None:
            raise ProviderUnsupported(f"{interval} bars", PROVIDER_NAME)
        source, synth = plan
        market = self._market(symbol)
        fetch_start = start
        if start is not None and synth is not None:
            # A bucket is built from all of its source bars: start at its first one.
            fetch_start = align_start(start, synth.rule, synth.factor)
        frame = bars_frame(self._bars(market, source, fetch_start, end))
        if frame.empty:
            return empty_frame()
        if synth is not None:
            frame = synthesize(frame, synth)
        mask = pd.Series(True, index=frame.index)
        if start is not None:
            mask &= frame["ts"] >= int(start.timestamp())
        if end is not None:
            mask &= frame["ts"] < int(end.timestamp())
        return frame[mask].sort_values("ts").reset_index(drop=True)

    def _bars(
        self, market: Market, interval: str, start: datetime | None, end: datetime | None
    ) -> list[Any]:
        """Raw bars of `[start, end)` of a native interval, newest page first, so a range cut
        short by the page limit or the budget keeps its newest part. The first request is
        already paid for by the guard."""
        now = self._clock()
        cursor = now if end is None or end > now else end
        limit = MAX_PAGES if self._max_pages is None else min(MAX_PAGES, self._max_pages)
        rows: list[Any] = []
        for page in range(limit):
            if page and not self._pay_for_page():
                break
            result = self.exchange.bars_page(market, interval, start, cursor)
            rows.extend(result.rows)
            older = result.older
            if older is None or older >= cursor or (start is not None and older <= start):
                break
            cursor = older
        else:
            log.info("%s: bars paging stopped after %d pages", self._name, limit)
        return rows

    # -- symbol info and search ---------------------------------------------------------

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        market = self._market(symbol)
        hint = decimals(market.tick)
        return {
            "symbol": symbol.strip().upper(),
            "name": market.name,
            "exchange": self._name,
            "exchangeName": self._name,
            "type": "cryptocurrency",
            "currency": market.quote,
            "timezone": "UTC",
            "session": "0000-2359",
            "priceHint": hint,
            "minTick": market.tick if market.tick else 10.0**-hint,
            "hasIntraday": True,
        }

    #: Quote currencies a bare base asset query ("btc") lists first.
    _QUOTE_ORDER = ("USD", "USDT", "USDC", "EUR", "GBP", "BTC")

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        q = canonical_asset(query)  # "xbt" asks for BTC
        if not q or limit < 1:
            return []
        wanted = {q, canonical_symbol(q) or q}
        compact = {w.replace("-", "").replace("/", "") for w in wanted}
        ranked: list[tuple[tuple[int, int, int, str], Market]] = []
        for market in self._markets().values():
            joined = market.symbol.replace("-", "")
            if market.symbol in wanted or market.base in wanted or joined in compact:
                rank = 0
            elif market.symbol.startswith(q) or market.base.startswith(q):
                rank = 1
            elif q in market.name.upper() or market.quote in wanted:
                rank = 2
            else:
                continue
            order = self._QUOTE_ORDER
            quote_rank = order.index(market.quote) if market.quote in order else len(order)
            ranked.append(((rank, quote_rank, len(market.symbol), market.symbol), market))
        ranked.sort(key=lambda item: item[0])
        return [
            {
                "symbol": market.symbol,
                "name": market.name,
                "exchange": self._name,
                "type": "cryptocurrency",
                "typeDisplay": "Crypto",
            }
            for _, market in ranked[:limit]
        ]

    # -- quotes -------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest rolling statistics per known pair. `confirmed` when every symbol asked for was
        a crypto pair and the exchange answered for each one it lists (the others are then known
        not to exist); symbols that are no pair are not sent, `ProviderUnsupported` only when
        none is one."""
        requested = list(dict.fromkeys(s.strip().upper() for s in symbols))
        servable = [s for s in requested if canonical_symbol(s) is not None]
        if not servable:
            if requested:
                raise ProviderUnsupported("non-crypto symbols", PROVIDER_NAME)
            return QuoteList()
        markets = self._markets()
        # Several spellings (XBT-USD, BTC-USD) may name one pair: one request entry, one row each.
        names: dict[str, list[str]] = {}
        for name in servable:
            market = markets.get(canonical_symbol(name) or "")
            if market is not None:
                names.setdefault(market.symbol, []).append(name)
        listed = [markets[s] for s in names]
        batch = self.exchange.quote_batch
        # The guard paid for ceil(servable / batch) requests: only chunks beyond that are
        # charged here, and a refusal leaves those symbols out of a partial answer.
        paid = math.ceil(len(servable) / self._paid_batch)
        now = self._clock()
        rows: list[dict[str, Any]] = []
        answered: set[str] = set()
        failed: list[str] = []
        first_error: ProviderError | None = None
        for i, chunk_start in enumerate(range(0, len(listed), batch)):
            chunk = listed[chunk_start : chunk_start + batch]
            if i >= paid:
                try:
                    charge_upstream(1)
                except ProviderError as exc:  # no budget: what was fetched is worth more
                    first_error = first_error or exc
                    failed += [n for m in chunk for n in names[m.symbol]]
                    continue
            try:
                tickers = self.exchange.tickers(chunk)
            except RateLimited:
                raise
            except ProviderError as exc:
                first_error = first_error or exc
                failed += [n for m in chunk for n in names[m.symbol]]
                continue
            for market in chunk:
                ticker = tickers.get(market.symbol)
                if ticker is None:
                    continue
                answered.add(market.symbol)
                rows += [_quote_row(n, market, ticker, now) for n in names[market.symbol]]
        if first_error is not None:
            if not rows:
                raise first_error
            raise PartialQuotes(str(first_error), rows, failed)
        every_asked = len(servable) == len(requested)
        return QuoteList(rows, confirmed=every_asked and answered == set(names))

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise ProviderUnsupported("extended-hours quotes", PROVIDER_NAME)

    # -- not offered --------------------------------------------------------------------

    def events(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("events", PROVIDER_NAME)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise ProviderUnsupported("news", PROVIDER_NAME)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("fundamentals", PROVIDER_NAME)


def _quote_row(name: str, market: Market, ticker: Ticker, now: datetime) -> dict[str, Any]:
    before = ticker.open if ticker.open else None
    change = ticker.last - before if before is not None else None
    percent = change / before * 100 if change is not None and before else None
    volume = ticker.volume
    row: dict[str, Any] = {
        "symbol": name,
        "last": ticker.last,
        "prevClose": before,
        "change": change,
        "changePercent": percent,
        "volume": int(volume) if volume is not None and math.isfinite(volume) else None,
        "currency": market.quote,
        # Crypto never closes.
        "marketState": "REGULAR",
        "time": ticker.time if ticker.time is not None else int(now.timestamp()),
    }
    if ticker.open is not None:
        row["open"] = ticker.open
    if ticker.high is not None:
        row["dayHigh"] = ticker.high
    if ticker.low is not None:
        row["dayLow"] = ticker.low
    return row


__all__ = [
    "EXCHANGES",
    "CryptoConfig",
    "CryptoLiveSource",
    "CryptoProvider",
    "cache_identity",
    "capabilities_for",
    "costs_for",
    "exchange_class",
    "make_live",
    "make_provider",
    "plan_of",
    "setting_defaults_for",
]
