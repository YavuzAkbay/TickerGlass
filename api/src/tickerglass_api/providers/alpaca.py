"""Alpaca Market Data (alpaca.markets) as a `MarketDataProvider` plus a `LiveSource`: US stocks
and ETFs (IEX feed on the free plan, SIP on Algo Trader Plus) and crypto, over keyed REST
(`data.alpaca.markets`, the assets list on the trading API) and the WebSocket stream
(`stream.data.alpaca.markets`). Design: docs/design/more-providers.md section 2.

How it maps onto the app:

- Canonical symbols are Yahoo-style; `to_provider` / `from_provider` map `BRK-B` <-> `BRK.B` and
  `BTC-USD` <-> `BTC/USD`. Indices, FX, futures and suffixed (non-US) symbols are unsupported
  and answered locally (`billable` / `answers_locally`), never sent.
- Bars: every interval is native (`{n}Min`, `1Hour`, `1Day`, `1Week`, `{n}Month`) except 90m,
  built from 30m with `resample.py` (session buckets), and stock 60m without pre/post-market,
  built the same way from 30m so the first bar opens at 09:30 (native 1Hour bars are
  clock-aligned: the 09:00 one holds pre-market trades; they are used with pre/post-market and
  for crypto). Pages are walked newest first
  (`sort=desc`), so a deep range cut short by `max_pages` still holds the newest bars.
  Daily and longer stock bars carry Yahoo's semantics: `close` is split-adjusted and `adj_close`
  split+dividend adjusted, which takes a second request (`adjustment=all`) whose failure only
  costs `adj_close` (it then equals `close`). Intraday bars are raw. `prepost=False` drops stock
  bars outside the regular session (a bar counts when it overlaps 09:30-16:00 New York).
- Quotes: batched snapshots (stocks and crypto on their own endpoints); the previous close is
  `prevDailyBar.c`, or `dailyBar.c` while the latest trade belongs to a later day than the
  daily bar (pre-market). Alpaca has no "unknown symbol" answer, so quotes never claim
  `confirmed`.
- Search and symbol_info read the active-assets lists (stocks, crypto), cached for 24 hours.
  An empty bar answer is checked against the cached list to tell "no data" from "no such
  symbol" (`SymbolNotFound`).
- Budget: the plan's calls per minute (`PlanProfile`); response `X-RateLimit-*` headers are fed
  to the guard (`report_usage`). Everything beyond the first request of a guarded call is
  charged with `charge_upstream` (further pages, the adjusted pass, the assets lists, extra
  quote chunks).
- Live: `AlpacaLiveSource` streams trades (+ daily bars for the day's range and volume). Basic
  allows 30 symbols and one connection per stream: symbols past the limit stay unstreamed (the
  hub polls them), a connection-limit, credential or subscription error ends `listen` so the hub
  backs off and polls meanwhile. Crypto has its own connection, opened only when a crypto symbol
  is subscribed.

Unverified (built from the documented shapes, never run against the real API):

- `/v2/stocks/snapshots` answering `{SYMBOL: snapshot}` (a `{"snapshots": {...}}` wrapper is
  accepted too) and omitting unknown symbols; an invalid symbol answering 400 "invalid symbol".
- The `sort=desc` + `page_token` paging of the multi-symbol bars endpoint; `bars: null` for no data.
- Daily bar stamps (`...T04:00Z`/`T05:00Z` for stocks) and 1Hour / 3Month bar alignment; crypto
  daily bars (assumed to fall on the UTC date of their stamp).
- The assets list with paper-trading keys on `paper-api.alpaca.markets`, and `/v2/assets` having
  no ETF flag (every stock is typed "equity").
- 403 text of a plan-gated feed ("subscription does not permit..."), the 429 `Retry-After`.
- Stream: the server's `connected` message arriving first (auth is sent in reaction to it),
  the `subscription` acknowledgement listing the symbols it accepted, and what a 405 leaves
  subscribed. Crypto stream on `wss://.../v1beta3/crypto/us`.
"""

import asyncio
import logging
import math
import re
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import pandas as pd
from pydantic import Field, SecretStr, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from ..intervals import INTERVALS as ALL_INTERVALS
from ..live import MessageHandler
from .base import (
    BAR_COLUMNS,
    Capabilities,
    CostModel,
    PartialQuotes,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    charge_upstream,
    report_usage,
)
from .exchanges import by_mic, split_symbol
from .http import HttpRateLimited, HttpStatusError, JsonHttp, Send, require_https
from .resample import resample_bars
from .stream import (
    MAX_FAILURES,
    Backoff,
    ConnectFactory,
    StreamClient,
    StreamError,
    StreamFatal,
    StreamUnavailable,
    websockets_connect,
)

log = logging.getLogger(__name__)

PROVIDER_NAME = "Alpaca"
DATA_URL = "https://data.alpaca.markets"
TRADING_URL = "https://paper-api.alpaca.markets"
STREAM_URL = "wss://stream.data.alpaca.markets"
#: Bars per page (the API maximum).
PAGE_SIZE = 10000
#: Pages one bars request may fetch (each after the first is a request more).
MAX_PAGES = 12
#: Symbols per snapshots request.
QUOTE_BATCH = 100
#: Seconds the assets lists are reused.
ASSETS_TTL_S = 24 * 3600
#: Start of a history call without `start` (SIP data begins in 2016; the API's own default is
#: the start of the current day).
EARLIEST = datetime(2016, 1, 1, tzinfo=UTC)
NEW_YORK = "America/New_York"
_XNYS = by_mic("XNYS")
_REGULAR_SESSION = _XNYS.session if _XNYS is not None else "0930-1600"

# -- plans -------------------------------------------------------------------------------


@dataclass(frozen=True)
class PlanProfile:
    """What an Alpaca market-data plan allows and how the app should pace itself on it."""

    calls_per_min: int
    burst: int
    #: May query recent SIP data (and so use `feed=sip`).
    sip: bool
    #: Symbols one stream connection may subscribe to, None without a limit.
    stream_symbols: int | None
    #: Seconds a quote is served from cache, and the polling interval per symbol.
    quote_ttl_s: float
    poll_interval_s: float
    poll_closed_interval_s: float
    #: Bar tail refresh TTLs while the market is open.
    tail_ttl_intraday_s: float
    tail_ttl_daily_s: float


_BASIC = PlanProfile(
    calls_per_min=200,
    burst=50,
    sip=False,
    stream_symbols=30,
    quote_ttl_s=15,
    poll_interval_s=15,
    poll_closed_interval_s=300,
    tail_ttl_intraday_s=30,
    tail_ttl_daily_s=300,
)
PLAN_PROFILES: dict[str, PlanProfile] = {
    "basic": _BASIC,
    "algo_trader_plus": replace(
        _BASIC,
        calls_per_min=10_000,
        burst=500,
        sip=True,
        stream_symbols=None,
        quote_ttl_s=5,
        poll_interval_s=5,
        poll_closed_interval_s=60,
        tail_ttl_intraday_s=10,
        tail_ttl_daily_s=120,
    ),
}


class AlpacaConfig(BaseSettings):
    """`ALPACA_*` settings. `feed` defaults to the plan's (basic: iex, algo: sip)."""

    model_config = SettingsConfigDict(
        env_prefix="ALPACA_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    key_id: SecretStr = Field(title="API key ID")
    secret_key: SecretStr = Field(title="API secret key")
    plan: Literal["basic", "algo_trader_plus"] = Field(default="basic", title="Plan")
    feed: Literal["iex", "sip"] | None = Field(default=None, title="Data feed")
    data_base_url: str = Field(default=DATA_URL, title="Market data base URL")
    #: Only the assets list is read from it; paper keys work there too (unverified).
    trading_base_url: str = Field(default=TRADING_URL, title="Trading API base URL")
    extended_hours: bool = Field(default=True, title="Pre/post-market bars")
    crypto_location: Literal["us", "us-1", "eu-1"] = Field(default="us", title="Crypto location")

    @field_validator("data_base_url", "trading_base_url")
    @classmethod
    def _https_only(cls, value: str, info: ValidationInfo) -> str:
        # The key pair travels in the request headers.
        return require_https(value, f"ALPACA_{info.field_name}".upper())


def effective_profile(config: BaseSettings | None) -> PlanProfile:
    """The plan's profile; `None` (not configured yet) gives the basic one."""
    if not isinstance(config, AlpacaConfig):
        return _BASIC
    return PLAN_PROFILES[config.plan]


def effective_feed(config: AlpacaConfig) -> Literal["iex", "sip"]:
    """The feed requests use. Basic is always `iex`: recent SIP data answers 403 there."""
    profile = PLAN_PROFILES[config.plan]
    if not profile.sip:
        return "iex"
    return config.feed or "sip"


#: Canonical interval names served (5d is not offered).
INTERVALS = frozenset({"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1d", "1wk", "1mo", "3mo"})


def capabilities_for(config: BaseSettings | None) -> Capabilities:
    extended = config.extended_hours if isinstance(config, AlpacaConfig) else True
    return Capabilities(
        intervals=INTERVALS,
        extended_history=extended,
        extended_quotes=False,
        adjusted_close=True,
        search=True,
        events=frozenset(),
        news=False,
        fundamentals_info=False,
        fundamentals_statements=False,
        streaming=True,
        markets=frozenset({"us", "crypto"}),
    )


def costs_for(_: BaseSettings | None = None) -> CostModel:
    """Requests per operation as the guard charges them. The assets lists behind search and
    symbol_info are charged by the provider when it loads one (they are cached)."""
    return CostModel(
        history=1,
        symbol_info=0,
        search=0,
        quote_batch=QUOTE_BATCH,
        quote_per_request=1,
        quote_per_symbol=0,
        events=0,
        news=0,
        fundamentals=0,
    )


def setting_defaults_for(config: BaseSettings | None) -> dict[str, Any]:
    profile = effective_profile(config)
    return {
        "upstream_rate_per_min": float(profile.calls_per_min),
        "upstream_burst": profile.burst,
        "quote_ttl_s": profile.quote_ttl_s,
        "live_poll_interval_s": profile.poll_interval_s,
        "live_poll_closed_interval_s": profile.poll_closed_interval_s,
        "bars_tail_ttl_intraday_s": profile.tail_ttl_intraday_s,
        "bars_tail_ttl_daily_s": profile.tail_ttl_daily_s,
    }


def plan_of(config: BaseSettings | None) -> str | None:
    return config.plan if isinstance(config, AlpacaConfig) else "basic"


# -- symbols -----------------------------------------------------------------------------

_CRYPTO_QUOTES = frozenset({"USD", "USDT", "USDC", "BTC"})
_CRYPTO_PAIR = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3,4})")
_STOCK = re.compile(r"[A-Z0-9]{1,6}(?:[-.][A-Z]{1,2})?")


@dataclass(frozen=True)
class AlpacaSymbol:
    """A canonical symbol as Alpaca names it."""

    #: `AAPL`, `BRK.B`, `BTC/USD`.
    symbol: str
    crypto: bool

    @property
    def timezone(self) -> str:
        return "UTC" if self.crypto else NEW_YORK


def to_provider(symbol: str) -> AlpacaSymbol | None:
    """Alpaca's name for a canonical symbol, or None when it has none (indices, FX, futures,
    non-US listings, crypto pairs outside USD / USDT / USDC / BTC)."""
    s = symbol.strip().upper()
    if not s or s.startswith("^") or s.endswith(("=X", "=F")):
        return None
    pair = _CRYPTO_PAIR.fullmatch(s)
    if pair and pair[2] in _CRYPTO_QUOTES:
        return AlpacaSymbol(f"{pair[1]}/{pair[2]}", True)
    if split_symbol(s)[1] is not None:  # a suffix naming another exchange: VOD.L
        return None
    if not _STOCK.fullmatch(s):
        return None
    # Class shares: Yahoo "BRK-B", Alpaca "BRK.B".
    return AlpacaSymbol(s.replace("-", "."), False)


def from_provider(symbol: str) -> str | None:
    """The canonical symbol of an Alpaca one (`BRK.B` -> `BRK-B`, `BTC/USD` -> `BTC-USD`)."""
    s = symbol.strip().upper()
    if "/" in s:
        base, _, quote = s.partition("/")
        return f"{base}-{quote}" if base and quote in _CRYPTO_QUOTES else None
    return s.replace(".", "-") or None


# -- helpers -----------------------------------------------------------------------------

_NATIVE = {
    "1m": "1Min",
    "2m": "2Min",
    "5m": "5Min",
    "15m": "15Min",
    "30m": "30Min",
    "60m": "1Hour",
    "1d": "1Day",
    "1wk": "1Week",
    "1mo": "1Month",
    "3mo": "3Month",
}
#: Intervals built from a finer one: (source, resample rule, factor, source span).
_Synth = tuple[str, Literal["epoch", "session", "quarter"], int, timedelta]
_SYNTH: dict[str, _Synth] = {
    "90m": ("30m", "session", 90, timedelta(minutes=90)),
}
#: Stock 60m bars without pre/post-market: native 1Hour bars are clock-aligned, so the 09:00 one
#: also holds the half hour before the open. Built from 30m bars anchored on the 09:30 open
#: instead (Yahoo's 60m bars). With pre/post-market, and for crypto, the native bars are used.
_REGULAR_HOURLY: _Synth = ("30m", "session", 60, timedelta(minutes=60))
_DAILY = frozenset({"1d", "1wk", "1mo", "3mo"})
_PLAN_GATED = ("subscription", "not permit", "recent sip")


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def _empty_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=BAR_COLUMNS)


def _parse_time(value: Any) -> datetime | None:
    """A UTC datetime from an RFC 3339 stamp (`2026-10-27T13:35:00.123456789Z`)."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _message(body: Any, default: str) -> str:
    if isinstance(body, Mapping) and isinstance(body.get("message"), str):
        return str(body["message"])
    return default


def _session_minutes() -> tuple[int, int]:
    opens, _, closes = _REGULAR_SESSION.partition("-")
    return int(opens[:2]) * 60 + int(opens[2:]), int(closes[:2]) * 60 + int(closes[2:])


def _market_hours(moment: datetime) -> int:
    """Stream `market_hours` of a stock tick: 0 pre-market (04:00-09:30), 1 regular, 2
    post-market (16:00-20:00 New York); outside those 3. Holidays are not known."""
    local = moment.astimezone(ZoneInfo(NEW_YORK))
    if local.weekday() >= 5:
        return 3
    minute = local.hour * 60 + local.minute
    opens, closes = _session_minutes()
    if opens <= minute < closes:
        return 1
    if 4 * 60 <= minute < opens:
        return 0
    if closes <= minute < 20 * 60:
        return 2
    return 3


def _frame(rows: Sequence[Any], tz: str, daily: bool) -> pd.DataFrame:
    """Bars from a bars answer (`t`, `o`, `h`, `l`, `c`, `v`). Intraday `t` is the bar open;
    daily and longer bars are stamped at exchange-local midnight of the date they fall on."""
    bars = [r for r in rows if isinstance(r, Mapping)]
    if not bars:
        return _empty_frame()
    raw = pd.DataFrame(bars)
    for column in ("t", "o", "h", "l", "c"):
        if column not in raw:
            raise ProviderError(f"{PROVIDER_NAME}: bar lacks {column!r}")
    stamp = pd.to_datetime(raw["t"], utc=True, errors="coerce")
    ohlc = {n: pd.to_numeric(raw[c], errors="coerce") for n, c in _OHLC.items()}
    volume = pd.to_numeric(raw["v"], errors="coerce") if "v" in raw else None
    # A bar with a missing or non-positive price is a bad row (it would poison the charts).
    ok = stamp.notna() & pd.concat(ohlc, axis=1).gt(0).all(axis=1)
    if not ok.any():
        return _empty_frame()
    when = stamp[ok]
    if daily:
        # `...T04:00Z` / `T05:00Z` is New York midnight: the UTC date is the bar's date.
        day = when.dt.tz_localize(None).dt.normalize()
        when = day.dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
        when = when.dt.tz_convert("UTC")
    secs = when.dt.tz_localize(None).dt.as_unit("s")
    out = pd.DataFrame(
        {
            "ts": secs.to_numpy().astype("int64"),
            "open": ohlc["open"][ok].to_numpy(float),
            "high": ohlc["high"][ok].to_numpy(float),
            "low": ohlc["low"][ok].to_numpy(float),
            "close": ohlc["close"][ok].to_numpy(float),
        }
    )
    out["adj_close"] = out["close"]
    out["volume"] = volume[ok].fillna(0).to_numpy(float) if volume is not None else 0.0
    return out[BAR_COLUMNS]


_OHLC = {"open": "o", "high": "h", "low": "l", "close": "c"}


@dataclass(frozen=True)
class _Asset:
    symbol: str
    name: str
    exchange: str | None


def _snapshot_row(
    canonical: str, snap: Mapping[str, Any], crypto: bool, now: datetime
) -> dict[str, Any] | None:
    """A quote from a snapshot (`latestTrade`, `dailyBar`, `prevDailyBar`)."""

    def part(key: str) -> Mapping[str, Any]:
        value = snap.get(key)
        return value if isinstance(value, Mapping) else {}

    trade, daily, prev = part("latestTrade"), part("dailyBar"), part("prevDailyBar")
    last = _num(trade.get("p"))
    if last is None or last <= 0:
        last = _num(daily.get("c"))
    if last is None or last <= 0:
        return None
    traded_at = _parse_time(trade.get("t")) or _parse_time(daily.get("t"))
    tz = ZoneInfo("UTC" if crypto else NEW_YORK)
    trade_day: date | None = traded_at.astimezone(tz).date() if traded_at else None
    daily_at = _parse_time(daily.get("t"))
    daily_day: date | None = daily_at.astimezone(UTC).date() if daily_at else None
    # The daily bar is the latest session's; a trade of a later day (pre-market) is measured
    # against that bar's close, otherwise against the session before it.
    daily_is_older = trade_day is not None and daily_day is not None and daily_day < trade_day
    prev_close = _num(daily.get("c")) if daily_is_older else _num(prev.get("c"))
    same_day = bool(daily) and not daily_is_older
    change = last - prev_close if prev_close is not None else None
    pct = change / prev_close * 100 if change is not None and prev_close else None
    row: dict[str, Any] = {
        "symbol": canonical,
        "last": last,
        "prevClose": prev_close,
        "change": change,
        "changePercent": pct,
        "volume": _int(daily.get("v")) if same_day else None,
        "currency": canonical.rpartition("-")[2] if crypto else "USD",
        "marketState": _market_state(now, trade_day, crypto),
        "time": int(traded_at.timestamp()) if traded_at else None,
    }
    if same_day:
        row["open"] = _num(daily.get("o"))
        row["dayHigh"] = _num(daily.get("h"))
        row["dayLow"] = _num(daily.get("l"))
    return row


def _market_state(now: datetime, trade_day: date | None, crypto: bool) -> str:
    """Alpaca does not tell the market state: it follows from the New York clock, and from the
    latest trade being today's (no trade today: a holiday, or nothing traded yet)."""
    if crypto:
        return "REGULAR"
    local = now.astimezone(ZoneInfo(NEW_YORK))
    if trade_day != local.date():
        return "CLOSED"
    return {0: "PRE", 1: "REGULAR", 2: "POST"}.get(_market_hours(now), "CLOSED")


# -- the provider ------------------------------------------------------------------------


class AlpacaProvider:
    """`MarketDataProvider` over the Alpaca market-data REST API (stdlib HTTP, key pair in
    the `APCA-API-*` headers). Also a `SymbolRouting` provider."""

    def __init__(
        self,
        config: AlpacaConfig,
        *,
        send: Send | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        max_pages: int | None = None,
    ) -> None:
        self._clock = clock
        self._max_pages = max_pages
        self._extended = config.extended_hours
        self._crypto_location = config.crypto_location
        self._feed = effective_feed(config)
        if config.feed is not None and config.feed != self._feed:
            log.warning(
                "ALPACA_FEED=%s needs a plan with SIP data: using %s on the %s plan",
                config.feed,
                self._feed,
                config.plan,
            )
        headers = {
            "APCA-API-KEY-ID": config.key_id.get_secret_value(),
            "APCA-API-SECRET-KEY": config.secret_key.get_secret_value(),
        }
        self._data = JsonHttp(
            config.data_base_url,
            send=send,
            headers=headers,
            on_headers=self._on_headers,
            provider="alpaca",
        )
        self._trading = JsonHttp(
            config.trading_base_url, send=send, headers=headers, provider="alpaca"
        )
        # Requests run on several threads: one assets load at a time.
        self._assets_lock = threading.Lock()
        self._assets_cache: dict[bool, tuple[float, dict[str, _Asset]]] = {}

    # -- transport ----------------------------------------------------------------------

    @staticmethod
    def _on_headers(headers: Mapping[str, str]) -> None:
        try:
            limit = int(headers["x-ratelimit-limit"])
            left = max(0, int(headers["x-ratelimit-remaining"]))
        except (KeyError, ValueError):
            return
        report_usage(minute_used=max(0, limit - left), minute_left=left)

    def _get(self, http: JsonHttp, path: str, params: Mapping[str, str], symbol: str = "") -> Any:
        """GET and map HTTP errors to the provider errors."""
        try:
            return http.get(path, params)
        except HttpRateLimited as exc:
            raise RateLimited(f"{PROVIDER_NAME}: rate limited", exc.retry_after) from None
        except HttpStatusError as exc:
            raise self._error(exc.status, exc.body, symbol) from None

    @staticmethod
    def _error(status: int, body: Any, symbol: str) -> ProviderError:
        message = _message(body, f"HTTP {status}")
        lower = message.lower()
        if status in (401, 403):
            if status == 403 and any(marker in lower for marker in _PLAN_GATED):
                return ProviderUnsupported("recent SIP data on this plan", PROVIDER_NAME)
            return ProviderNotConfigured(
                "Alpaca rejected ALPACA_KEY_ID / ALPACA_SECRET_KEY (invalid, or without "
                "market data access)"
            )
        if status == 404 or (status in (400, 422) and "symbol" in lower):
            return SymbolNotFound(symbol)
        return ProviderError(f"{PROVIDER_NAME}: {message}")

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

    # -- symbols ------------------------------------------------------------------------

    @staticmethod
    def _resolve(symbol: str) -> AlpacaSymbol:
        mapped = to_provider(symbol)
        if mapped is None:
            s = symbol.strip().upper()
            what = (
                "futures"
                if s.endswith("=F")
                else "index symbols"
                if s.startswith("^")
                else "forex pairs"
                if s.endswith("=X")
                else "non-US symbols"
                if split_symbol(s)[1] is not None
                else s
            )
            raise ProviderUnsupported(what, PROVIDER_NAME)
        return mapped

    def billable(self, symbols: list[str]) -> list[str]:
        """The symbols a quote call would send: each once, without those Alpaca cannot serve."""
        return [
            s
            for s in dict.fromkeys(x.strip().upper() for x in symbols)
            if to_provider(s) is not None
        ]

    def answers_locally(self, op: str, symbol: str) -> bool:
        """Unsupported symbols, and events / fundamentals (not offered), cost no request."""
        return op in ("events", "fundamentals", "news") or to_provider(symbol) is None

    # -- history ------------------------------------------------------------------------

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        sym = self._resolve(symbol)
        extended = prepost and self._extended
        synth = _SYNTH.get(interval)
        if interval == "60m" and not sym.crypto and not extended:
            synth = _REGULAR_HOURLY
        source = synth[0] if synth else interval
        timeframe = _NATIVE.get(source)
        if timeframe is None:
            raise ProviderUnsupported(f"{interval} bars", PROVIDER_NAME)
        daily = source in _DAILY
        fetch_start = start
        if start is not None and synth:
            # Buckets are anchored on the first bar of each local day: start at that day's
            # midnight so a mid-session `start` still sees the session open.
            zone = ZoneInfo(sym.timezone)
            local = start.astimezone(zone)
            fetch_start = datetime(local.year, local.month, local.day, tzinfo=zone)
        elif start is not None and daily:
            fetch_start = start - timedelta(days=1)
        rows = self._bars(sym, timeframe, fetch_start, end, "split" if daily else None, free=True)
        if not rows:
            self._ensure_known(sym, symbol)
            return _empty_frame()
        frame = _frame(rows, sym.timezone, daily)
        if daily and not sym.crypto and not frame.empty:
            frame = self._with_adjusted_close(sym, timeframe, fetch_start, end, frame)
        if not sym.crypto and not daily and not extended:
            frame = _regular_hours(frame, ALL_INTERVALS[source].seconds // 60)
        if synth:
            frame = resample_bars(frame, synth[1], synth[2], sym.timezone)
        if frame.empty:
            return _empty_frame()
        mask = pd.Series(True, index=frame.index)
        if start is not None:
            mask &= frame["ts"] >= int(start.timestamp())
        if end is not None:
            mask &= frame["ts"] < int(end.timestamp())
        return frame[mask].sort_values("ts").reset_index(drop=True)

    def _bars_request(
        self, sym: AlpacaSymbol, timeframe: str, adjustment: str | None
    ) -> tuple[str, dict[str, str]]:
        params = {"symbols": sym.symbol, "timeframe": timeframe, "limit": str(PAGE_SIZE)}
        if sym.crypto:
            return f"/v1beta3/crypto/{self._crypto_location}/bars", params
        params["feed"] = self._feed
        if adjustment:
            params["adjustment"] = adjustment
        return "/v2/stocks/bars", params

    def _bars(
        self,
        sym: AlpacaSymbol,
        timeframe: str,
        start: datetime | None,
        end: datetime | None,
        adjustment: str | None,
        *,
        free: bool,
    ) -> list[Any]:
        """Raw bars of `[start, end)`, newest page first (`sort=desc`), so a range cut short
        by the page limit or the budget keeps its newest part. `free`: the first request is
        already paid for by the guard."""
        path, params = self._bars_request(sym, timeframe, adjustment)
        params["sort"] = "desc"
        params["start"] = _iso(start or EARLIEST)
        if end is not None:
            params["end"] = _iso(end)
        limit = MAX_PAGES if self._max_pages is None else min(MAX_PAGES, self._max_pages)
        out: list[Any] = []
        for page in range(limit):
            if (page or not free) and not self._pay_for_page():
                break
            body = self._get(self._data, path, params, sym.symbol)
            if not isinstance(body, Mapping):
                raise ProviderError(f"{PROVIDER_NAME}: unexpected bars payload")
            bars = body.get("bars")
            found = bars.get(sym.symbol) if isinstance(bars, Mapping) else None
            if isinstance(found, list):
                out.extend(found)
            token = body.get("next_page_token")
            if not token or not isinstance(token, str):
                break
            params["page_token"] = token
        else:
            log.info("%s: bars paging stopped after %d pages", PROVIDER_NAME, limit)
        return out

    def _with_adjusted_close(
        self,
        sym: AlpacaSymbol,
        timeframe: str,
        start: datetime | None,
        end: datetime | None,
        frame: pd.DataFrame,
    ) -> pd.DataFrame:
        """`adj_close` of split+dividend adjusted bars; `close` stays split-adjusted only (as
        Yahoo's). A failing request leaves `adj_close` equal to `close`."""
        try:
            rows = self._bars(sym, timeframe, start, end, "all", free=False)
        except (ProviderNotConfigured, ProviderUnsupported):
            raise
        except ProviderError as exc:
            log.warning(
                "%s: adjusted prices unavailable for %s: %s", PROVIDER_NAME, sym.symbol, exc
            )
            return frame
        adjusted = _frame(rows, sym.timezone, True)
        if adjusted.empty:
            return frame
        by_ts = pd.Series(adjusted["close"].to_numpy(), index=adjusted["ts"].to_numpy())
        by_ts = by_ts[~by_ts.index.duplicated(keep="last")]
        mapped = frame["ts"].map(by_ts)
        return frame.assign(adj_close=mapped.fillna(frame["close"]).to_numpy(float))

    def _ensure_known(self, sym: AlpacaSymbol, symbol: str) -> None:
        """No bars at all: `SymbolNotFound` when the cached assets list lacks the symbol
        (loading it when it is not cached); a failing lookup proves nothing."""
        try:
            assets = self._assets(sym.crypto)
        except ProviderError as exc:
            log.debug("%s: cannot tell whether %s exists: %s", PROVIDER_NAME, symbol, exc)
            return
        if sym.symbol not in assets:
            raise SymbolNotFound(symbol)

    # -- assets, symbol info and search --------------------------------------------------

    def _assets(self, crypto: bool) -> dict[str, _Asset]:
        """Active assets by Alpaca symbol, cached for `ASSETS_TTL_S`. A load is a request of
        its own and charged as one."""
        with self._assets_lock:
            cached = self._assets_cache.get(crypto)
            now = time.monotonic()
            if cached is not None and now - cached[0] < ASSETS_TTL_S:
                return cached[1]
            charge_upstream(1)
            body = self._get(
                self._trading,
                "/v2/assets",
                {"status": "active", "asset_class": "crypto" if crypto else "us_equity"},
            )
            if not isinstance(body, list):
                raise ProviderError(f"{PROVIDER_NAME}: unexpected assets payload")
            assets: dict[str, _Asset] = {}
            for row in body:
                if not isinstance(row, Mapping) or not isinstance(row.get("symbol"), str):
                    continue
                if row.get("status", "active") != "active":
                    continue
                exchange = row.get("exchange")
                assets[row["symbol"].upper()] = _Asset(
                    row["symbol"].upper(),
                    str(row.get("name") or row["symbol"]),
                    exchange if isinstance(exchange, str) and exchange else None,
                )
            self._assets_cache[crypto] = (now, assets)
            return assets

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        sym = self._resolve(symbol)
        asset = self._assets(sym.crypto).get(sym.symbol)
        if asset is None:
            raise SymbolNotFound(symbol)
        canonical = symbol.strip().upper()
        return {
            "symbol": canonical,
            "name": asset.name,
            "exchange": asset.exchange,
            "exchangeName": asset.exchange,
            "type": "cryptocurrency" if sym.crypto else "equity",
            "currency": sym.symbol.partition("/")[2] if sym.crypto else "USD",
            "timezone": sym.timezone,
            "session": "0000-2359" if sym.crypto else _REGULAR_SESSION,
            "priceHint": 2,
            "minTick": 0.01,
            "hasIntraday": True,
        }

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        q = query.strip().upper()
        if not q or limit < 1:
            return []
        ranked: list[tuple[tuple[int, int, int, str], str, _Asset, bool]] = []
        for crypto in (False, True):
            try:
                assets = self._assets(crypto)
            except ProviderError:
                if not crypto:
                    raise
                log.warning(
                    "%s: crypto assets unavailable for search", PROVIDER_NAME, exc_info=True
                )
                continue
            for asset in assets.values():
                canonical = from_provider(asset.symbol)
                if canonical is None:
                    continue
                if q in (canonical, asset.symbol):
                    rank = 0
                elif canonical.startswith(q) or asset.symbol.startswith(q):
                    rank = 1
                elif q in asset.name.upper():
                    rank = 2
                else:
                    continue
                ranked.append(
                    ((rank, int(crypto), len(canonical), canonical), canonical, asset, crypto)
                )
        ranked.sort(key=lambda item: item[0])
        return [
            {
                "symbol": canonical,
                "name": asset.name,
                "exchange": asset.exchange,
                "type": "cryptocurrency" if crypto else "equity",
                "typeDisplay": "Crypto" if crypto else "US equity",
            }
            for _, canonical, asset, crypto in ranked[:limit]
        ]

    # -- quotes -------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol. Never `confirmed`: a symbol missing from the answer
        may be unknown or merely without a recent trade. Symbols Alpaca cannot serve are not
        sent; `ProviderUnsupported` only when none can be."""
        wanted: dict[str, AlpacaSymbol] = {}
        unsupported: list[ProviderUnsupported] = []
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            try:
                wanted[raw] = self._resolve(raw)
            except ProviderUnsupported as exc:
                unsupported.append(exc)
        if not wanted:
            if unsupported:
                raise unsupported[0]
            return QuoteList()
        # Several canonical symbols may name one listing (BRK-B and BRK.B): one entry in the
        # request, one row for each of them.
        by_key: dict[tuple[bool, str], list[str]] = {}
        for canonical, mapped in wanted.items():
            by_key.setdefault((mapped.crypto, mapped.symbol), []).append(canonical)
        chunks: list[tuple[bool, list[str]]] = []
        for crypto in (False, True):
            keys = [k[1] for k in by_key if k[0] == crypto]
            chunks += [
                (crypto, keys[i : i + QUOTE_BATCH]) for i in range(0, len(keys), QUOTE_BATCH)
            ]
        # The guard paid for ceil(n / batch) requests; stocks and crypto chunk apart.
        extra = len(chunks) - math.ceil(len(wanted) / QUOTE_BATCH)
        if extra > 0:
            charge_upstream(extra)
        now = self._clock()
        rows: list[dict[str, Any]] = []
        failed: list[str] = []
        first_error: ProviderError | None = None
        for crypto, keys in chunks:
            try:
                snaps = self._snapshots(crypto, keys, charged=True)
            except RateLimited:
                raise
            except ProviderError as exc:
                first_error = first_error or exc
                failed += [c for k in keys for c in by_key[(crypto, k)]]
                continue
            for key in keys:
                snap = snaps.get(key.upper())
                if not isinstance(snap, Mapping):
                    continue
                for canonical in by_key[(crypto, key)]:
                    row = _snapshot_row(canonical, snap, crypto, now)
                    if row is not None:
                        rows.append(row)
        if first_error is not None:
            if not rows:
                raise first_error
            raise PartialQuotes(str(first_error), rows, failed)
        return QuoteList(rows, confirmed=False)

    def _snapshots(self, crypto: bool, keys: list[str], *, charged: bool) -> dict[str, Any]:
        """One snapshots request for `keys` (Alpaca symbols). An invalid symbol makes Alpaca
        refuse the whole request: the batch is then halved until the culprit stands alone,
        which is answered as absent (each further request is charged)."""
        if not charged and not self._pay_for_page():
            raise ProviderError(f"{PROVIDER_NAME}: no budget left to retry quotes")
        if crypto:
            path = f"/v1beta3/crypto/{self._crypto_location}/snapshots"
            params = {"symbols": ",".join(keys)}
        else:
            path, params = "/v2/stocks/snapshots", {"symbols": ",".join(keys), "feed": self._feed}
        try:
            body = self._get(self._data, path, params, keys[0])
        except SymbolNotFound:
            if len(keys) == 1:
                return {}
            half = len(keys) // 2
            first = self._snapshots(crypto, keys[:half], charged=False)
            second = self._snapshots(crypto, keys[half:], charged=False)
            return {**first, **second}
        if not isinstance(body, Mapping):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected snapshots payload")
        wrapped = body.get("snapshots")
        entries = wrapped if len(body) == 1 and isinstance(wrapped, Mapping) else body
        return {str(k).upper(): v for k, v in entries.items()}

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise ProviderUnsupported("extended-hours quotes", PROVIDER_NAME)

    # -- not offered --------------------------------------------------------------------

    def events(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("events", PROVIDER_NAME)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise ProviderUnsupported("news", PROVIDER_NAME)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("fundamentals", PROVIDER_NAME)


def _regular_hours(frame: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """The bars of `frame` (stock, intraday, `minutes` long) that overlap the regular
    session of the New York day they open on."""
    if frame.empty:
        return frame
    local = pd.to_datetime(frame["ts"], unit="s", utc=True).dt.tz_convert(NEW_YORK)
    minute = local.dt.hour * 60 + local.dt.minute
    opens, closes = _session_minutes()
    keep = (minute + minutes > opens) & (minute < closes)
    return frame[keep.to_numpy()].reset_index(drop=True)


# -- live --------------------------------------------------------------------------------

#: Stream error codes that end the connection for good: auth failed, connection limit
#: exceeded, v2 not enabled, insufficient subscription.
_FATAL_STREAM_CODES = {
    402: "authentication failed (check ALPACA_KEY_ID / ALPACA_SECRET_KEY)",
    406: "connection limit exceeded (another stream already uses these keys)",
    408: "the stream is not enabled for this account",
    409: "the subscription does not include this feed",
}


@dataclass
class _Day:
    """The latest daily bar of a symbol (range and volume of the session so far)."""

    high: float | None = None
    low: float | None = None
    volume: float | None = None


class _Channel:
    """One stream connection (stocks or crypto): the wanted symbols, what the server was
    told, and the Alpaca message protocol (connected -> auth -> authenticated -> subscribe)."""

    def __init__(
        self,
        name: str,
        url: str,
        key: tuple[str, str],
        *,
        crypto: bool,
        limit: int | None,
        emit: Callable[[dict[str, Any]], Any],
        connect: ConnectFactory,
        backoff: Backoff | None,
        max_failures: int | None = None,
    ) -> None:
        self.name = name
        self._url = url
        self._key = key
        self.crypto = crypto
        self._limit = limit
        self._emit = emit
        self._connect = connect
        self._backoff = backoff
        self._max_failures = max_failures
        #: Ended for good (rejected credentials, a connection limit): not started again, its
        #: symbols are left to the hub's polling.
        self.dead = False
        #: Alpaca symbol -> canonical, in subscription order.
        self.wanted: dict[str, str] = {}
        #: Alpaca symbols the server is known to stream on this connection.
        self.streamed: set[str] = set()
        self.authed = False
        self.client: StreamClient | None = None
        self.task: asyncio.Task[None] | None = None
        self._days: dict[str, _Day] = {}
        self._sync_lock = asyncio.Lock()
        self._limit_logged = False

    def add(self, pairs: Mapping[str, str]) -> None:
        for alpaca, canonical in pairs.items():
            self.wanted.setdefault(alpaca, canonical)

    def remove(self, alpaca: Sequence[str]) -> None:
        for symbol in alpaca:
            self.wanted.pop(symbol, None)
            self._days.pop(symbol, None)

    def start(self) -> None:
        """Run the connection as a task (once)."""
        if self.task is None:
            self.task = asyncio.create_task(self._run(), name=f"alpaca-stream-{self.name}")

    async def stop(self) -> None:
        task, self.task = self.task, None
        client = self.client
        if client is not None:
            await client.close()
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self.client = None
        self.authed = False
        self.streamed.clear()

    async def _run(self) -> None:
        self.client = StreamClient(
            self._url,
            on_open=self._on_open,
            on_message=self._on_message,
            connect=self._connect,
            backoff=self._backoff,
            max_failures=self._max_failures,
        )
        await self.client.run()

    async def _on_open(self, client: StreamClient) -> None:
        # Auth waits for the server's "connected" message.
        self.authed = False
        self.streamed.clear()

    async def sync(self) -> None:
        """Make the server's subscription match the first `limit` wanted symbols. Symbols
        past the limit stay unstreamed (the hub polls them) and move up as others go."""
        client = self.client
        if client is None or not self.authed:
            return
        async with self._sync_lock:
            target = list(self.wanted)[: self._limit]
            add = [s for s in target if s not in self.streamed]
            drop = [s for s in self.streamed if s not in target]
            try:
                if drop:
                    await client.send({"action": "unsubscribe", "trades": drop, "dailyBars": drop})
                    self.streamed.difference_update(drop)
                if add:
                    await client.send({"action": "subscribe", "trades": add, "dailyBars": add})
                    self.streamed.update(add)
            except StreamError:
                log.debug("alpaca stream %s: subscription deferred to the reconnect", self.name)
            except Exception:
                log.debug("alpaca stream %s: subscription send failed", self.name, exc_info=True)

    async def _on_message(self, message: Any) -> None:
        for item in message if isinstance(message, list) else [message]:
            if isinstance(item, Mapping):
                await self._on_item(item)

    async def _on_item(self, item: Mapping[str, Any]) -> None:
        kind = item.get("T")
        if kind == "t":
            await self._on_trade(item)
        elif kind == "d":
            self._on_daily_bar(item)
        elif kind == "success":
            text = item.get("msg")
            if text == "connected" and self.client is not None:
                key_id, secret = self._key
                await self.client.send({"action": "auth", "key": key_id, "secret": secret})
            elif text == "authenticated":
                self.authed = True
                await self.sync()
        elif kind == "subscription":
            # The server's own list of what it streams.
            trades = item.get("trades")
            if isinstance(trades, list):
                self.streamed = {str(s) for s in trades}
        elif kind == "error":
            self._on_error(item)

    def _on_error(self, item: Mapping[str, Any]) -> None:
        code = _int(item.get("code"))
        text = str(item.get("msg") or "")
        if code in _FATAL_STREAM_CODES:
            raise StreamFatal(f"Alpaca stream {self.name}: {_FATAL_STREAM_CODES[code]}")
        if code == 405:
            if not self._limit_logged:
                self._limit_logged = True
                log.warning(
                    "Alpaca stream %s: symbol limit reached, the other symbols are polled",
                    self.name,
                )
            return
        log.warning("Alpaca stream %s: error %s %s", self.name, code, text)

    def _on_daily_bar(self, item: Mapping[str, Any]) -> None:
        symbol = item.get("S")
        if isinstance(symbol, str) and symbol in self.wanted:
            self._days[symbol] = _Day(_num(item.get("h")), _num(item.get("l")), _num(item.get("v")))

    async def _on_trade(self, item: Mapping[str, Any]) -> None:
        symbol = item.get("S")
        canonical = self.wanted.get(symbol) if isinstance(symbol, str) else None
        price = _num(item.get("p"))
        if canonical is None or price is None or price <= 0:
            return
        moment = _parse_time(item.get("t"))
        day = self._days.get(str(symbol))
        tick: dict[str, Any] = {
            "id": canonical,
            "price": price,
            "market_hours": 1 if self.crypto or moment is None else _market_hours(moment),
        }
        if moment is not None:
            tick["time"] = int(moment.timestamp() * 1000)
        if day is not None:
            tick["day_volume"] = day.volume
            tick["day_high"] = max(day.high, price) if day.high is not None else None
            tick["day_low"] = min(day.low, price) if day.low is not None else None
        result = self._emit(tick)
        if result is not None:
            await result


class AlpacaLiveSource:
    """`LiveSource` over the Alpaca streams: `subscribe` / `unsubscribe` record interest,
    `listen` runs one reconnecting connection per feed that has symbols (stocks; crypto only
    once a crypto symbol is subscribed) and hands trade ticks in the hub's message shape.
    `listen` ends with an error when no connection is left to stream: Alpaca rejected the
    credentials or the connection (limit, subscription) on every one of them, or the stream
    could not be reached `max_failures` times in a row (see `StreamClient`), so the hub shows
    it down and backs off while its poll fallback serves the symbols. One connection failing
    for good while the other works only stops that one (its symbols are polled). `close` drops
    all state: the hub subscribes again before the next `listen`."""

    def __init__(
        self,
        config: AlpacaConfig,
        *,
        stream_url: str = STREAM_URL,
        connect: ConnectFactory = websockets_connect,
        backoff_factory: Callable[[], Backoff] | None = None,
        max_failures: int | None = MAX_FAILURES,
    ) -> None:
        self._max_failures = max_failures
        self._key = (config.key_id.get_secret_value(), config.secret_key.get_secret_value())
        self._stream_url = stream_url.rstrip("/")
        self._feed = effective_feed(config)
        self._limit = effective_profile(config).stream_symbols
        self._crypto_location = config.crypto_location
        self._connect = connect
        self._backoff_factory = backoff_factory
        self._handler: MessageHandler | None = None
        self._channels: dict[str, _Channel] = {}
        self._listening = False
        self._wake = asyncio.Event()

    def _channel(self, crypto: bool) -> _Channel:
        name = "crypto" if crypto else "stocks"
        channel = self._channels.get(name)
        if channel is None:
            url = (
                f"{self._stream_url}/v1beta3/crypto/{self._crypto_location}"
                if crypto
                else f"{self._stream_url}/v2/{self._feed}"
            )
            channel = _Channel(
                name,
                url,
                self._key,
                crypto=crypto,
                limit=None if crypto else self._limit,
                emit=self._emit,
                connect=self._connect,
                backoff=self._backoff_factory() if self._backoff_factory else None,
                max_failures=self._max_failures,
            )
            self._channels[name] = channel
        return channel

    async def _emit(self, tick: dict[str, Any]) -> None:
        handler = self._handler
        if handler is not None:
            await handler(tick)

    @staticmethod
    def _split(symbols: list[str]) -> tuple[dict[str, str], dict[str, str]]:
        """(stock, crypto) maps Alpaca symbol -> canonical; unsupported symbols are dropped."""
        stocks: dict[str, str] = {}
        crypto: dict[str, str] = {}
        for raw in symbols:
            mapped = to_provider(raw)
            if mapped is not None:
                (crypto if mapped.crypto else stocks)[mapped.symbol] = raw.strip().upper()
        return stocks, crypto

    async def subscribe(self, symbols: list[str]) -> None:
        stocks, crypto = self._split(symbols)
        for is_crypto, pairs in ((False, stocks), (True, crypto)):
            if not pairs:
                continue
            channel = self._channel(is_crypto)
            channel.add(pairs)
            await channel.sync()
        self._wake.set()

    async def unsubscribe(self, symbols: list[str]) -> None:
        stocks, crypto = self._split(symbols)
        for is_crypto, pairs in ((False, stocks), (True, crypto)):
            channel = self._channels.get("crypto" if is_crypto else "stocks")
            if channel is not None and pairs:
                channel.remove(list(pairs))
                await channel.sync()

    async def listen(self, handler: MessageHandler) -> None:
        self._handler = handler
        self._listening = True
        wake = asyncio.ensure_future(self._wake.wait())
        try:
            while self._listening:
                for channel in self._channels.values():
                    if channel.wanted and not channel.dead:
                        channel.start()
                tasks = [c.task for c in self._channels.values() if c.task is not None]
                done, _ = await asyncio.wait([wake, *tasks], return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    if task is wake:
                        self._wake.clear()
                        wake = asyncio.ensure_future(self._wake.wait())
                        continue
                    await self._on_task_done(task)
        finally:
            self._listening = False
            wake.cancel()
            await asyncio.gather(wake, return_exceptions=True)
            await self._stop_channels()

    async def _on_task_done(self, task: asyncio.Future[Any]) -> None:
        """A connection's task ended. Without an error (closed, cancelled) it is started again
        on the next pass while symbols are wanted. A `StreamFatal` marks that connection dead
        (the hub polls its symbols); an outage (`StreamUnavailable`) restarts it. Either one
        raises when no other connection is left running, so the hub sees the stream as down."""
        channel = next((c for c in self._channels.values() if c.task is task), None)
        error = None if task.cancelled() else task.exception()
        if channel is None:
            if error is not None and not isinstance(error, StreamError):
                raise error
            return
        if error is None:
            channel.task = None
            return
        if not isinstance(error, StreamError):
            raise error
        await channel.stop()  # a failed task is done: this only resets the connection's state
        if isinstance(error, StreamFatal):
            channel.dead = True
        elif not isinstance(error, StreamUnavailable):
            raise error
        others = [c for c in self._channels.values() if c is not channel]
        if not any(c.task is not None and not c.dead for c in others):
            raise ProviderError(str(error)) from None
        if channel.dead:
            log.warning("%s; its symbols are polled instead", error)
        else:
            log.warning("%s; trying again", error)

    async def _stop_channels(self) -> None:
        for channel in list(self._channels.values()):
            await channel.stop()

    async def close(self) -> None:
        """Stop `listen`, close the connections and forget every subscription."""
        self._listening = False
        self._wake.set()
        await self._stop_channels()
        self._channels.clear()
        self._wake.clear()
