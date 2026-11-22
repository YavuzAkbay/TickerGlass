"""Tiingo (tiingo.com) as a `MarketDataProvider` plus an opt-in `LiveSource`: US stocks and ETFs
(end-of-day history, IEX intraday bars and quotes) and crypto, over keyed REST (`api.tiingo.com`)
and the IEX WebSocket. Design: docs/design/more-providers.md section 3.

Limits that shape it. The free Starter plan allows 50 requests per hour, 1 000 per day and
500 unique symbols per month (Power: 10 000 / 100 000 and a higher symbol count). The guard
paces the first two (`PlanProfile`, `setting_defaults_for`). The monthly unique-symbol cap
cannot be enforced here (Tiingo counts the symbols a key ever asked for): when it is hit,
Tiingo's own error text is raised as a plain `ProviderError` (symbols already fetched stay
served from the cache). Because requests are so scarce, every operation is one request:
a history call fetches its whole range at once and a quote batch is one request for up to
`QUOTE_BATCH` symbols (that is what makes Tiingo usable on the free plan).

How it maps onto the app:

- Canonical symbols are Yahoo-style. Stocks keep their name (Tiingo spells class shares with a
  dash like Yahoo: `BRK-B`); crypto maps `BTC-USD` <-> `btcusd`. Indices, FX, futures, suffixed
  (non-US) symbols and crypto pairs outside USD / USDT / USDC / EUR / BTC are unsupported and
  answered locally (`billable` / `answers_locally`), never sent.
- Daily history: `/tiingo/daily/<t>/prices`, always fetched up to today so that `close` is
  split-adjusted the way Yahoo's is (raw prices divided by the splits after each bar, from the
  `splitFactor` column) and `adj_close` is Tiingo's `adjClose` (split and dividend adjusted).
  Weekly, monthly and quarterly bars are built from those daily bars (Monday-, month- and
  quarter-start stamps at exchange-local midnight), which takes no `resampleFreq` value
  beyond what is documented and costs the same one request.
- Intraday history: `/iex/<t>/prices` (stocks) and `/tiingo/crypto/prices` with the one
  documented `resampleFreq=5min`; 15m, 30m, 60m and 90m are built from the 5-minute bars
  (`resample.py`: 15m / 30m on the clock grid, 60m / 90m anchored at the session open). 1m and
  2m cannot be built from 5-minute bars and are not offered. Stock bars are cut to the regular
  session (`extended_history` is false: what the IEX endpoint holds outside it is unknown).
  A call without `start` looks back `INTRADAY_DEFAULT_SPAN` (the response size is bounded).
- Quotes: stocks in one `/iex/?tickers=a,b` request using `tngoLast` (`last` is null without an
  IEX agreement since 2025-02), crypto in one `/tiingo/crypto/prices` request (last two daily
  bars). Quotes never claim `confirmed`: Tiingo answers with the symbols it has.
- Search is `/tiingo/utilities/search` (stocks and funds); symbol_info is the daily meta
  endpoint (`/tiingo/daily/<t>`, `/tiingo/crypto`).
- Live (`TIINGO_STREAM=true` only): `TiingoLiveSource` streams IEX last trades of the stocks
  subscribed; crypto and everything else is polled by the hub. Messages of tickers nobody asked
  for are dropped as they arrive.

Unverified (built from the documented shapes, never run against the real API):

- Bar and quote time stamps: IEX `date` being the bar's open as an ISO string with an offset or
  `Z`; daily `date` being `...T00:00:00.000Z` of the trading date; crypto `date` with `+00:00`;
  quote `timestamp` / `lastSaleTimestamp` as ISO strings.
- `startDate` without `endDate` running to the latest bar (stocks), a `startDate` after the last
  bar answering `[]`, an unknown stock answering 404 `{"detail": "Not found."}` on the daily
  endpoints, and `/iex/?tickers=` simply omitting unknown tickers.
- The `splitFactor` column being the split ratio on the ex-date (2 for a 2-for-1), so that raw
  prices before it are divided by it.
- 5-minute IEX bars stamping the bar open and reaching back far enough for the 60-day window the
  bar service asks for (the depth of IEX history is not documented).
- `/tiingo/crypto` (meta) answering `[{"ticker", "baseCurrency", "quoteCurrency", "name"}]`, and
  `/tiingo/crypto/prices` answering `[{"ticker", "priceData": [...]}]`.
- `/tiingo/utilities/search` rows (`ticker`, `name`, `assetType`, `isActive`, `countryCode`).
- Error texts: the per-hour / per-day / monthly-symbol wording the classification in
  `_limit_kind` keys on, and which status code each limit answers with.
- The Power plan's limits (10 000 per hour, 100 000 per day, 5 000 symbols per month).
- Stream: `wss://api.tiingo.com/iex`; the subscribe form
  `{"eventName": "subscribe", "authorization": key, "eventData": {"thresholdLevel": 6,
  "tickers": [...]}}`; an update re-sending the full ticker list with the `subscriptionId` of the
  `messageType: "I"` answer (a server that accumulates instead of replacing only streams more
  than asked, which the client-side filter drops; whether `eventName: "unsubscribe"` with the
  `subscriptionId` and the tickers to drop exists could not be confirmed (VERIFY: the Tiingo
  documentation page needs a browser), so removals re-send the shorter list); trade rows
  `["T", date, nanoseconds, ticker, bidSize, bidPrice, midPrice, askPrice, askSize, lastPrice,
  lastSize, ...]`; `messageType: "E"` with `response.code` 401 / 403 for a rejected key.
"""

import asyncio
import logging
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import pandas as pd
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from ..live import LiveSource, MessageHandler
from ..settings import Settings
from .base import (
    BAR_COLUMNS,
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
    websockets_connect,
)

log = logging.getLogger(__name__)

PROVIDER_NAME = "Tiingo"
BASE_URL = "https://api.tiingo.com"
STREAM_URL = "wss://api.tiingo.com/iex"
#: Symbols per quote request (one request however many: bounded by the URL length).
QUOTE_BATCH = 200
#: `thresholdLevel` of the stream subscription (6: last trades).
THRESHOLD_LEVEL = 6
#: Start of a daily history call without `start`.
EARLIEST_DAILY = date(1962, 1, 2)
#: Look-back of an intraday call without `start`.
INTRADAY_DEFAULT_SPAN = timedelta(days=60)
#: Longest text of an upstream error kept in a message.
MAX_ERROR_CHARS = 300
NEW_YORK = "America/New_York"
_XNYS = by_mic("XNYS")
_REGULAR_SESSION = _XNYS.session if _XNYS is not None else "0930-1600"

# -- plans -------------------------------------------------------------------------------


@dataclass(frozen=True)
class PlanProfile:
    """What a Tiingo plan allows and how the app should pace itself on it."""

    requests_per_hour: int
    burst: int
    requests_per_day: int
    #: Unique symbols per month (informational: the guard cannot enforce it).
    symbols_per_month: int
    #: Seconds a quote is served from cache, and the polling interval per symbol.
    quote_ttl_s: float
    quote_closed_ttl_s: float
    poll_interval_s: float
    poll_closed_interval_s: float
    #: Bar tail refresh TTLs while the market is open.
    tail_ttl_intraday_s: float
    tail_ttl_daily_s: float


_STARTER = PlanProfile(
    requests_per_hour=50,
    burst=10,
    requests_per_day=1000,
    symbols_per_month=500,
    quote_ttl_s=120,
    quote_closed_ttl_s=3600,
    poll_interval_s=120,
    poll_closed_interval_s=1800,
    tail_ttl_intraday_s=300,
    tail_ttl_daily_s=3600,
)
PLAN_PROFILES: dict[str, PlanProfile] = {
    "starter": _STARTER,
    "power": replace(
        _STARTER,
        requests_per_hour=10_000,
        burst=100,
        requests_per_day=100_000,
        symbols_per_month=5000,
        quote_ttl_s=15,
        quote_closed_ttl_s=600,
        poll_interval_s=15,
        poll_closed_interval_s=120,
        tail_ttl_intraday_s=30,
        tail_ttl_daily_s=300,
    ),
}


class TiingoConfig(BaseSettings):
    """`TIINGO_*` settings. `stream` opts in to the IEX WebSocket (off by default: it is heavy
    and the free plan's request budget does not need it)."""

    model_config = SettingsConfigDict(
        env_prefix="TIINGO_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    api_key: SecretStr = Field(title="API key")
    plan: Literal["starter", "power"] = Field(default="starter", title="Plan")
    base_url: str = Field(default=BASE_URL, title="API base URL")
    stream: bool = Field(default=False, title="Live IEX stream")

    @field_validator("base_url")
    @classmethod
    def _https_only(cls, value: str) -> str:
        # The API key travels in the request headers.
        return require_https(value, "TIINGO_BASE_URL")


def effective_profile(config: BaseSettings | None) -> PlanProfile:
    """The configured plan's profile; `None` (not configured yet) gives the starter one."""
    if not isinstance(config, TiingoConfig):
        return _STARTER
    return PLAN_PROFILES[config.plan]


#: Intraday intervals served: the documented 5-minute bars and what is built from them.
_INTRADAY: dict[str, tuple[Literal["epoch", "session"], int] | None] = {
    "5m": None,
    "15m": ("epoch", 15),
    "30m": ("epoch", 30),
    "60m": ("session", 60),
    "90m": ("session", 90),
}
#: Daily and longer intervals, all built from daily bars; the value is the months of a bar
#: (0 for the daily and weekly ones).
_DAILY: dict[str, int] = {"1d": 0, "1wk": 0, "1mo": 1, "3mo": 3}
#: Canonical interval names served (1m, 2m and 5d are not offered).
INTERVALS = frozenset(_INTRADAY) | frozenset(_DAILY)


def capabilities_for(config: BaseSettings | None) -> Capabilities:
    return Capabilities(
        intervals=INTERVALS,
        extended_history=False,
        extended_quotes=False,
        adjusted_close=True,
        search=True,
        events=frozenset(),
        news=False,
        fundamentals_info=False,
        fundamentals_statements=False,
        streaming=isinstance(config, TiingoConfig) and config.stream,
        markets=frozenset({"us", "crypto"}),
    )


def costs_for(_: BaseSettings | None = None) -> CostModel:
    """Requests per operation as the guard charges them: one each, a quote batch included."""
    return CostModel(
        history=1,
        symbol_info=1,
        search=1,
        quote_batch=QUOTE_BATCH,
        quote_per_request=1,
        quote_per_symbol=0,
        events=0,
        news=0,
        fundamentals=0,
    )


def setting_defaults_for(config: BaseSettings | None) -> dict[str, Any]:
    """Defaults for the global settings: the plan's request budget, and TTLs long enough that
    the cache stands in for requests."""
    profile = effective_profile(config)
    return {
        "upstream_rate_per_min": profile.requests_per_hour / 60,
        "upstream_burst": profile.burst,
        "upstream_daily_limit": profile.requests_per_day,
        "quote_ttl_s": profile.quote_ttl_s,
        "quote_closed_ttl_s": profile.quote_closed_ttl_s,
        "live_poll_interval_s": profile.poll_interval_s,
        "live_poll_closed_interval_s": profile.poll_closed_interval_s,
        "bars_tail_ttl_intraday_s": profile.tail_ttl_intraday_s,
        "bars_tail_ttl_daily_s": profile.tail_ttl_daily_s,
        "search_ttl_s": 7 * 86400.0,
        "symbol_info_ttl_s": 7 * 86400.0,
        "cache_negative_ttl_s": 6 * 3600.0,
        "quote_negative_ttl_s": 1800.0,
    }


def plan_of(config: BaseSettings | None) -> str | None:
    return config.plan if isinstance(config, TiingoConfig) else "starter"


# -- registry hooks (see `registry.ProviderSpec`) -----------------------------------------


def make_provider(_: Settings, config: BaseSettings | None) -> MarketDataProvider:
    assert isinstance(config, TiingoConfig)
    return TiingoProvider(config)


def make_live(_: MarketDataProvider, config: BaseSettings | None) -> LiveSource | None:
    """The IEX stream, only when `TIINGO_STREAM` asks for it (None: the hub polls)."""
    assert isinstance(config, TiingoConfig)
    return TiingoLiveSource(config) if config.stream else None


def spec_capabilities(config: BaseSettings | None) -> Capabilities:
    return capabilities_for(config)


def spec_costs(config: BaseSettings | None) -> CostModel:
    return costs_for(config)


def spec_setting_defaults(config: BaseSettings | None) -> dict[str, Any]:
    return setting_defaults_for(config)


def spec_plan(config: BaseSettings | None) -> str | None:
    return plan_of(config)


# -- symbols -----------------------------------------------------------------------------

_CRYPTO_QUOTES = frozenset({"USD", "USDT", "USDC", "EUR", "BTC"})
_CRYPTO_PAIR = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3,4})")
_STOCK = re.compile(r"[A-Z0-9]{1,6}(?:[-.][A-Z]{1,2})?")


@dataclass(frozen=True)
class TiingoSymbol:
    """A canonical symbol as Tiingo names it."""

    #: `aapl`, `brk-b`, `btcusd` (Tiingo reads any case; it answers in lower case).
    ticker: str
    crypto: bool
    #: Quote currency of a crypto pair, else USD.
    currency: str = "USD"

    @property
    def timezone(self) -> str:
        return "UTC" if self.crypto else NEW_YORK


def to_provider(symbol: str) -> TiingoSymbol | None:
    """Tiingo's name for a canonical symbol, or None when it has none (indices, FX, futures,
    non-US listings, crypto pairs outside USD / USDT / USDC / EUR / BTC)."""
    s = symbol.strip().upper()
    if not s or s.startswith("^") or s.endswith(("=X", "=F")):
        return None
    pair = _CRYPTO_PAIR.fullmatch(s)
    if pair and pair[2] in _CRYPTO_QUOTES:
        return TiingoSymbol(f"{pair[1]}{pair[2]}".lower(), True, pair[2])
    if split_symbol(s)[1] is not None:  # a suffix naming another exchange: VOD.L
        return None
    if not _STOCK.fullmatch(s):
        return None
    return TiingoSymbol(s.replace(".", "-").lower(), False)


def crypto_symbol(base: str, quote: str) -> str | None:
    """The canonical symbol of a Tiingo crypto pair (`btc`, `usd` -> `BTC-USD`)."""
    b, q = base.strip().upper(), quote.strip().upper()
    return f"{b}-{q}" if b and q in _CRYPTO_QUOTES else None


# -- helpers -----------------------------------------------------------------------------


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
    """A UTC datetime from an ISO 8601 stamp (`2026-10-27T15:59:58.123456-04:00`)."""
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _text(body: Any, default: str) -> str:
    """The error text of an answer body (Tiingo sends `{"detail": "..."}`), shortened."""
    found = ""
    if isinstance(body, Mapping):
        for key in ("detail", "message", "error"):
            if isinstance(body.get(key), str) and body[key].strip():
                found = body[key].strip()
                break
    return (found or default)[:MAX_ERROR_CHARS]


_MONTHLY_ALLOWANCE = re.compile(r"\b(?:this|per|each|every|a)\s+month\b|\bmonthly\b|\bbandwidth\b")


def _limit_kind(text: str) -> Literal["month", "hour", "day"] | None:
    """Which allowance an error text says is used up. Tiingo words them like "You have run over
    your 500 symbol look up for this month", "... over the allowed 50 requests per hour" and
    "... per day" (unverified wording)."""
    lower = text.lower()
    # Not any mention of "month" (a 400 about a bad date parameter may name one).
    if _MONTHLY_ALLOWANCE.search(lower):
        return "month"
    if "per hour" in lower or "hourly" in lower:
        return "hour"
    if "per day" in lower or "daily" in lower:
        return "day"
    return None


def _seconds_until_next_hour(now: datetime) -> int:
    return max(60, 3600 - (now.minute * 60 + now.second))


def _seconds_until_midnight_utc(now: datetime) -> int:
    nxt = datetime(now.year, now.month, now.day, tzinfo=UTC) + timedelta(days=1)
    return max(60, int((nxt - now).total_seconds()))


def _day(moment: datetime, zone: ZoneInfo) -> str:
    return moment.astimezone(zone).date().isoformat()


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


def _market_state(now: datetime, trade_day: date | None) -> str:
    """Tiingo does not tell the market state: it follows from the New York clock, and from the
    latest trade being today's (no trade today: a holiday, or nothing traded yet)."""
    local = now.astimezone(ZoneInfo(NEW_YORK))
    if trade_day != local.date():
        return "CLOSED"
    return {0: "PRE", 1: "REGULAR", 2: "POST"}.get(_market_hours(now), "CLOSED")


def _frame(rows: Sequence[Any], tz: str, *, daily: bool, split_adjust: bool) -> pd.DataFrame:
    """Bars from a prices answer (`date`, `open`, `high`, `low`, `close`, `volume`, and for
    stocks `adjClose`, `splitFactor`). Intraday `date` is the bar open; daily dates are
    stamped at exchange-local midnight of the trading date. `split_adjust` divides the raw
    prices by the splits that came after each bar (and multiplies the volume), as Yahoo's
    `close` is; it needs every bar up to today."""
    bars = [r for r in rows if isinstance(r, Mapping)]
    if not bars:
        return _empty_frame()
    raw = pd.DataFrame(bars)
    for needed in ("date", "open", "high", "low", "close"):
        if needed not in raw:
            raise ProviderError(f"{PROVIDER_NAME}: bar lacks {needed!r}")
    stamp = pd.to_datetime(raw["date"], utc=True, errors="coerce")
    names = ("open", "high", "low", "close")
    ohlc = {n: pd.to_numeric(raw[n], errors="coerce") for n in names}
    # A bar with a missing or non-positive price is a bad row (it would poison the charts).
    ok = stamp.notna() & pd.concat(ohlc, axis=1).gt(0).all(axis=1)
    if not ok.any():
        return _empty_frame()
    order = stamp[ok].sort_values(kind="stable").index
    stamp = stamp[order].reset_index(drop=True)
    raw = raw.loc[order].reset_index(drop=True)
    prices = {n: ohlc[n][order].reset_index(drop=True) for n in names}

    def column(name: str) -> pd.Series | None:
        return pd.to_numeric(raw[name], errors="coerce") if name in raw else None

    volume = column("volume")
    volumes = volume.fillna(0) if volume is not None else pd.Series(0.0, index=raw.index)
    if split_adjust:
        ratio = column("splitFactor")
        if ratio is not None:
            ratio = ratio.where(ratio > 0, 1.0).fillna(1.0)
            # Product of the split factors of the bars after each one.
            after = ratio[::-1].cumprod()[::-1].shift(-1).fillna(1.0)
            prices = {n: p / after for n, p in prices.items()}
            volumes = volumes * after
    when = stamp
    if daily:
        day = when.dt.tz_localize(None).dt.normalize()
        when = day.dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
        when = when.dt.tz_convert("UTC")
    secs = when.dt.tz_localize(None).dt.as_unit("s")
    out = pd.DataFrame(
        {
            "ts": secs.to_numpy().astype("int64"),
            "open": prices["open"].to_numpy(float),
            "high": prices["high"].to_numpy(float),
            "low": prices["low"].to_numpy(float),
            "close": prices["close"].to_numpy(float),
        }
    )
    adjusted = column("adjClose")
    out["adj_close"] = (
        adjusted.fillna(out["close"]).to_numpy(float) if adjusted is not None else out["close"]
    )
    out["volume"] = volumes.to_numpy(float)
    return out[BAR_COLUMNS]


def _weekly(frame: pd.DataFrame, tz: str) -> pd.DataFrame:
    """Weekly bars (Monday to Sunday, stamped at the exchange-local midnight of the Monday)
    from daily ones."""
    if frame.empty:
        return frame
    local = pd.to_datetime(frame["ts"], unit="s", utc=True).dt.tz_convert(tz)
    days = local.dt.tz_localize(None).dt.normalize()
    monday = days - pd.to_timedelta(local.dt.weekday, unit="D")
    start = monday.dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
    secs = start.dt.tz_convert("UTC").dt.tz_localize(None).dt.as_unit("s")
    out = (
        frame.assign(start=secs.to_numpy().astype("int64"))
        .groupby("start", sort=True)
        .agg(
            {
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "adj_close": "last",
                "volume": "sum",
            }
        )
    )
    out.insert(0, "ts", out.index.to_numpy(dtype="int64"))
    return out.reset_index(drop=True)[BAR_COLUMNS]


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


def _stock_row(canonical: str, item: Mapping[str, Any], now: datetime) -> dict[str, Any] | None:
    """A quote from an `/iex/` row. `tngoLast` is Tiingo's own last price; `last` is null
    without an IEX agreement and only a fallback."""
    last = _num(item.get("tngoLast"))
    if last is None or last <= 0:
        last = _num(item.get("last"))
    if last is None or last <= 0:
        return None
    traded = (
        _parse_time(item.get("lastSaleTimestamp"))
        or _parse_time(item.get("quoteTimestamp"))
        or _parse_time(item.get("timestamp"))
    )
    trade_day = traded.astimezone(ZoneInfo(NEW_YORK)).date() if traded else None
    prev = _num(item.get("prevClose"))
    change = last - prev if prev is not None else None
    row: dict[str, Any] = {
        "symbol": canonical,
        "last": last,
        "prevClose": prev,
        "change": change,
        "changePercent": change / prev * 100 if change is not None and prev else None,
        "volume": _int(item.get("volume")),
        "currency": "USD",
        "marketState": _market_state(now, trade_day),
        "time": int(traded.timestamp()) if traded else None,
    }
    for key, field in (("open", "open"), ("dayHigh", "high"), ("dayLow", "low")):
        value = _num(item.get(field))
        if value is not None:
            row[key] = value
    return row


def _crypto_row(
    canonical: str, currency: str, bars: Sequence[Any], now: datetime
) -> dict[str, Any] | None:
    """A quote from the last two daily bars of `/tiingo/crypto/prices`."""
    rows = [
        b
        for b in bars
        if isinstance(b, Mapping) and (close := _num(b.get("close"))) is not None and close > 0
    ]
    if not rows:
        return None
    rows.sort(key=lambda b: str(b.get("date", "")))
    latest = rows[-1]
    last = _num(latest.get("close"))
    assert last is not None
    prev = _num(rows[-2].get("close")) if len(rows) > 1 else None
    change = last - prev if prev is not None else None
    row: dict[str, Any] = {
        "symbol": canonical,
        "last": last,
        "prevClose": prev,
        "change": change,
        "changePercent": change / prev * 100 if change is not None and prev else None,
        "volume": _int(latest.get("volume")),
        "currency": currency,
        "marketState": "REGULAR",
        "time": int(now.timestamp()),
    }
    for key, field in (("open", "open"), ("dayHigh", "high"), ("dayLow", "low")):
        value = _num(latest.get(field))
        if value is not None:
            row[key] = value
    return row


# -- the provider ------------------------------------------------------------------------


class TiingoProvider:
    """`MarketDataProvider` over the Tiingo REST API (stdlib HTTP, key in the `Authorization:
    Token` header). Also a `SymbolRouting` provider."""

    def __init__(
        self,
        config: TiingoConfig,
        *,
        send: Send | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._clock = clock
        self._http = JsonHttp(
            config.base_url,
            send=send,
            headers={
                "Authorization": f"Token {config.api_key.get_secret_value()}",
                "Content-Type": "application/json",
            },
            provider="tiingo",
        )

    # -- transport ----------------------------------------------------------------------

    def _get(self, path: str, params: Mapping[str, str], symbol: str = "") -> Any:
        """GET and map HTTP errors to the provider errors."""
        try:
            return self._http.get(path, params)
        except HttpRateLimited as exc:
            raise self._rate_limited(exc) from None
        except HttpStatusError as exc:
            raise self._error(exc.status, exc.body, symbol) from None

    def _rate_limited(self, exc: HttpRateLimited) -> ProviderError:
        text = _text(exc.body, "")
        kind = _limit_kind(text)
        now = self._clock()
        if kind == "month":
            return self._monthly(text)
        if kind == "hour":
            return RateLimited(
                f"{PROVIDER_NAME}: {text}", max(exc.retry_after, _seconds_until_next_hour(now))
            )
        if kind == "day":
            return RateLimited(
                f"{PROVIDER_NAME}: {text}", _seconds_until_midnight_utc(now), daily=True
            )
        return RateLimited(f"{PROVIDER_NAME}: rate limited", exc.retry_after)

    @staticmethod
    def _monthly(text: str) -> ProviderError:
        # Not a rate limit: retrying will not help for weeks, and symbols fetched before
        # stay served from the cache. Tiingo's own words say which allowance ran out.
        return ProviderError(f"{PROVIDER_NAME}: monthly allowance used up: {text}")

    def _error(self, status: int, body: Any, symbol: str) -> ProviderError:
        text = _text(body, f"HTTP {status}")
        kind = _limit_kind(text) if status in (400, 403) else None
        if kind == "month":
            return self._monthly(text)
        if kind == "hour":
            return RateLimited(f"{PROVIDER_NAME}: {text}", _seconds_until_next_hour(self._clock()))
        if kind == "day":
            return RateLimited(
                f"{PROVIDER_NAME}: {text}",
                _seconds_until_midnight_utc(self._clock()),
                daily=True,
            )
        lower = text.lower()
        if status == 401 or (status == 403 and ("token" in lower or "credential" in lower)):
            return ProviderNotConfigured(
                "Tiingo rejected TIINGO_API_KEY (invalid, or without access to this data)"
            )
        if status == 403:
            return ProviderUnsupported("this request on the configured plan", PROVIDER_NAME)
        if status == 404:
            return SymbolNotFound(symbol)
        return ProviderError(f"{PROVIDER_NAME}: {text}")

    # -- symbols ------------------------------------------------------------------------

    @staticmethod
    def _resolve(symbol: str) -> TiingoSymbol:
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
        """The symbols a quote call would send: each once, without those Tiingo cannot serve."""
        return [
            s
            for s in dict.fromkeys(x.strip().upper() for x in symbols)
            if to_provider(s) is not None
        ]

    def answers_locally(self, op: str, symbol: str) -> bool:
        """Unsupported symbols, and events / fundamentals / news (not offered), cost no
        request."""
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
        if interval in _DAILY:
            frame = self._daily(sym, interval, symbol, start, end)
        elif interval in _INTRADAY:
            frame = self._intraday(sym, interval, symbol, start, end)
        else:
            raise ProviderUnsupported(f"{interval} bars", PROVIDER_NAME)
        if frame.empty:
            return _empty_frame()
        mask = pd.Series(True, index=frame.index)
        if start is not None:
            mask &= frame["ts"] >= int(start.timestamp())
        if end is not None:
            mask &= frame["ts"] < int(end.timestamp())
        return frame[mask].sort_values("ts").reset_index(drop=True)

    def _bars(self, sym: TiingoSymbol, path: str, params: dict[str, str], symbol: str) -> list[Any]:
        """The bars of a prices request (stocks answer a list of bars, crypto a list of
        `{"ticker", "priceData"}`)."""
        body = self._get(path, params, symbol)
        if not isinstance(body, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected prices payload")
        if not sym.crypto:
            return body
        for entry in body:
            if isinstance(entry, Mapping) and str(entry.get("ticker", "")).lower() == sym.ticker:
                data = entry.get("priceData")
                return data if isinstance(data, list) else []
        return []

    def _daily(
        self,
        sym: TiingoSymbol,
        interval: str,
        symbol: str,
        start: datetime | None,
        end: datetime | None,
    ) -> pd.DataFrame:
        """Daily, weekly, monthly or quarterly bars, all from one daily request. Stocks are
        fetched up to today so that the splits after every bar are known."""
        zone = ZoneInfo(sym.timezone)
        months = _DAILY[interval]
        first = EARLIEST_DAILY
        if start is not None:
            first = start.astimezone(zone).date()
            if interval == "1wk":  # whole weeks: start at the Monday
                first -= timedelta(days=first.weekday())
            elif months:
                first = date(first.year, first.month - (first.month - 1) % months, 1)
        if end is not None and start is not None and end <= start:
            return _empty_frame()
        params = {"startDate": first.isoformat()}
        if sym.crypto:
            params["tickers"] = sym.ticker
            params["resampleFreq"] = "1day"
            if end is not None:
                params["endDate"] = _day(end - timedelta(seconds=1), zone)
            path = "/tiingo/crypto/prices"
        else:
            path = f"/tiingo/daily/{sym.ticker}/prices"
        rows = self._bars(sym, path, params, symbol)
        frame = _frame(rows, sym.timezone, daily=True, split_adjust=not sym.crypto)
        if frame.empty:
            return frame
        if end is not None:  # the bars of a period that ends after `end` stop at `end`
            frame = frame[frame["ts"] < int(end.timestamp())].reset_index(drop=True)
        if interval == "1wk":
            return _weekly(frame, sym.timezone)
        if months:
            return resample_bars(frame, "quarter", months, sym.timezone)
        return frame

    def _intraday(
        self,
        sym: TiingoSymbol,
        interval: str,
        symbol: str,
        start: datetime | None,
        end: datetime | None,
    ) -> pd.DataFrame:
        """5-minute bars (the one documented `resampleFreq`), resampled to `interval`."""
        zone = ZoneInfo(sym.timezone)
        begin = start if start is not None else (end or self._clock()) - INTRADAY_DEFAULT_SPAN
        if end is not None and end <= begin:
            return _empty_frame()
        params = {"startDate": _day(begin, zone), "resampleFreq": "5min"}
        if end is not None:
            params["endDate"] = _day(end - timedelta(seconds=1), zone)
        if sym.crypto:
            params["tickers"] = sym.ticker
            path = "/tiingo/crypto/prices"
        else:
            params["columns"] = "open,high,low,close,volume"
            path = f"/iex/{sym.ticker}/prices"
        rows = self._bars(sym, path, params, symbol)
        frame = _frame(rows, sym.timezone, daily=False, split_adjust=False)
        if not sym.crypto:
            frame = _regular_hours(frame, 5)
        synth = _INTRADAY[interval]
        if synth is not None and not frame.empty:
            frame = resample_bars(frame, synth[0], synth[1], sym.timezone)
        return frame

    # -- symbol info and search ---------------------------------------------------------

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        sym = self._resolve(symbol)
        canonical = symbol.strip().upper()
        if sym.crypto:
            body = self._get("/tiingo/crypto", {"tickers": sym.ticker}, symbol)
            listed = body if isinstance(body, list) else []
            meta = next(
                (
                    m
                    for m in listed
                    if isinstance(m, Mapping) and str(m.get("ticker", "")).lower() == sym.ticker
                ),
                None,
            )
            if meta is None:
                raise SymbolNotFound(symbol)
            name = meta.get("name")
            return {
                "symbol": canonical,
                "name": str(name) if name else canonical,
                "exchange": None,
                "exchangeName": None,
                "type": "cryptocurrency",
                "currency": sym.currency,
                "timezone": "UTC",
                "session": "0000-2359",
                "priceHint": 2,
                "minTick": 0.01,
                "hasIntraday": True,
            }
        body = self._get(f"/tiingo/daily/{sym.ticker}", {}, symbol)
        if not isinstance(body, Mapping):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected meta payload")
        exchange = body.get("exchangeCode")
        exchange = exchange if isinstance(exchange, str) and exchange else None
        return {
            "symbol": canonical,
            "name": str(body.get("name") or canonical),
            "exchange": exchange,
            "exchangeName": exchange,
            "type": "equity",
            "currency": "USD",
            "timezone": NEW_YORK,
            "session": _REGULAR_SESSION,
            "priceHint": 2,
            "minTick": 0.01,
            "hasIntraday": True,
        }

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        q = query.strip()
        if not q or limit < 1:
            return []
        body = self._get("/tiingo/utilities/search", {"query": q})
        if not isinstance(body, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected search payload")
        out: list[dict[str, Any]] = []
        for row in body:
            if not isinstance(row, Mapping) or not isinstance(row.get("ticker"), str):
                continue
            symbol = str(row["ticker"]).strip().upper()
            mapped = to_provider(symbol)
            if mapped is None or mapped.crypto or row.get("isActive") is False:
                continue
            country = row.get("countryCode")
            if isinstance(country, str) and country and country.upper() != "US":
                continue  # a listing Tiingo knows but this provider cannot serve
            kind = str(row.get("assetType") or "Stock")
            out.append(
                {
                    "symbol": symbol.replace(".", "-"),
                    "name": str(row.get("name") or symbol),
                    "exchange": None,
                    "type": {"stock": "equity", "etf": "etf", "mutual fund": "mutualfund"}.get(
                        kind.lower()
                    ),
                    "typeDisplay": kind,
                }
            )
            if len(out) >= limit:
                break
        return out

    # -- quotes -------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol. Never `confirmed`: Tiingo answers with the symbols
        it has, and a symbol missing may be unknown or merely without a recent trade. Symbols
        Tiingo cannot serve are not sent; `ProviderUnsupported` only when none can be."""
        wanted: dict[str, TiingoSymbol] = {}
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
            by_key.setdefault((mapped.crypto, mapped.ticker), []).append(canonical)
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
                found = (
                    self._crypto_quotes(keys, by_key, now)
                    if crypto
                    else self._stock_quotes(keys, by_key, now)
                )
            except RateLimited:
                raise
            except ProviderError as exc:
                first_error = first_error or exc
                failed += [c for k in keys for c in by_key[(crypto, k)]]
                continue
            rows += found
        if first_error is not None:
            if not rows:
                raise first_error
            raise PartialQuotes(str(first_error), rows, failed)
        return QuoteList(rows, confirmed=False)

    def _stock_quotes(
        self, keys: list[str], by_key: Mapping[tuple[bool, str], list[str]], now: datetime
    ) -> list[dict[str, Any]]:
        body = self._get("/iex/", {"tickers": ",".join(keys)}, keys[0])
        if not isinstance(body, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected quotes payload")
        rows: list[dict[str, Any]] = []
        for item in body:
            if not isinstance(item, Mapping):
                continue
            for canonical in by_key.get((False, str(item.get("ticker", "")).lower()), []):
                row = _stock_row(canonical, item, now)
                if row is not None:
                    rows.append(row)
        return rows

    def _crypto_quotes(
        self, keys: list[str], by_key: Mapping[tuple[bool, str], list[str]], now: datetime
    ) -> list[dict[str, Any]]:
        # `/top` is deprecated: the last two daily bars give the price and the previous close.
        since = (now - timedelta(days=2)).astimezone(UTC).date().isoformat()
        body = self._get(
            "/tiingo/crypto/prices",
            {"tickers": ",".join(keys), "startDate": since, "resampleFreq": "1day"},
            keys[0],
        )
        if not isinstance(body, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected crypto quotes payload")
        rows: list[dict[str, Any]] = []
        for item in body:
            if not isinstance(item, Mapping):
                continue
            data = item.get("priceData")
            for canonical in by_key.get((True, str(item.get("ticker", "")).lower()), []):
                # The currency of the pair asked for (the answer's `quoteCurrency` is optional).
                mapped = to_provider(canonical)
                quote = mapped.currency if mapped is not None else "USD"
                row = _crypto_row(canonical, quote, data if isinstance(data, list) else [], now)
                if row is not None:
                    rows.append(row)
        return rows

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise ProviderUnsupported("extended-hours quotes", PROVIDER_NAME)

    # -- not offered --------------------------------------------------------------------

    def events(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("events", PROVIDER_NAME)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise ProviderUnsupported("news", PROVIDER_NAME)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("fundamentals", PROVIDER_NAME)


# -- live --------------------------------------------------------------------------------

#: Index of the fields of an IEX `data` row (`messageType` "A"): the update type ("T" last
#: trade, "Q" top of book, "B" break), the ISO date, nanoseconds since the epoch, the ticker,
#: and further on the last price.
_TYPE, _DATE, _NANOS, _TICKER, _LAST_PRICE = 0, 1, 2, 3, 9
_MIN_ROW = _LAST_PRICE + 1
#: `response.code` values of an "E" message that end the connection for good.
_FATAL_CODES = frozenset({401, 403})


class TiingoLiveSource:
    """`LiveSource` over the Tiingo IEX stream: `subscribe` / `unsubscribe` record interest in
    stock symbols (crypto and unsupported symbols stay with the hub's polling), `listen` runs one
    reconnecting connection while there are symbols and hands last-trade ticks in the hub's
    message shape. A rejected key, or `max_failures` failed connections in a row (the stream is
    down, see `StreamClient`), ends `listen` with an error so the hub shows it down and backs off
    while it polls. `close` drops all state: the hub subscribes again before the next `listen`."""

    def __init__(
        self,
        config: TiingoConfig,
        *,
        stream_url: str = STREAM_URL,
        connect: ConnectFactory = websockets_connect,
        backoff_factory: Callable[[], Backoff] | None = None,
        max_failures: int | None = MAX_FAILURES,
    ) -> None:
        self._max_failures = max_failures
        self._key = config.api_key.get_secret_value()
        self._stream_url = stream_url
        self._connect = connect
        self._backoff_factory = backoff_factory
        self._handler: MessageHandler | None = None
        #: Tiingo ticker (lower case) -> canonical symbol, in subscription order.
        self._wanted: dict[str, str] = {}
        self._client: StreamClient | None = None
        #: `subscriptionId` of the server's answer to the subscribe (sent back as it came),
        #: used to update the subscription.
        self._sub_id: int | str | None = None
        self._listening = False
        self._wake = asyncio.Event()

    @staticmethod
    def _split(symbols: list[str]) -> dict[str, str]:
        """Tiingo ticker -> canonical for the stock symbols (the only ones streamed)."""
        out: dict[str, str] = {}
        for raw in symbols:
            mapped = to_provider(raw)
            if mapped is not None and not mapped.crypto:
                out[mapped.ticker] = raw.strip().upper()
        return out

    def _subscription(self) -> dict[str, Any]:
        data: dict[str, Any] = {"thresholdLevel": THRESHOLD_LEVEL, "tickers": list(self._wanted)}
        if self._sub_id is not None:
            data["subscriptionId"] = self._sub_id
        return {"eventName": "subscribe", "authorization": self._key, "eventData": data}

    async def _push(self) -> None:
        """Tell a connected server the whole wanted list (a reconnect sends it from `_on_open`)."""
        client = self._client
        if client is None or not client.connected or not self._wanted:
            return
        try:
            await client.send(self._subscription())
        except StreamError:
            log.debug("tiingo stream: subscription deferred to the reconnect")
        except Exception:
            log.debug("tiingo stream: subscription send failed", exc_info=True)

    async def subscribe(self, symbols: list[str]) -> None:
        added = {k: v for k, v in self._split(symbols).items() if k not in self._wanted}
        if added:
            self._wanted.update(added)
            await self._push()
        self._wake.set()

    async def unsubscribe(self, symbols: list[str]) -> None:
        dropped = [k for k in self._split(symbols) if k in self._wanted]
        for ticker in dropped:
            del self._wanted[ticker]
        if not dropped:
            return
        client = self._client
        if not self._wanted:
            if client is not None:  # nothing left to stream: hang up until asked again
                await client.close()
        else:
            await self._push()

    async def listen(self, handler: MessageHandler) -> None:
        self._handler = handler
        self._listening = True
        try:
            while self._listening:
                if not self._wanted:
                    await self._wake.wait()
                    self._wake.clear()
                    continue
                client = StreamClient(
                    self._stream_url,
                    on_open=self._on_open,
                    on_message=self._on_message,
                    connect=self._connect,
                    backoff=self._backoff_factory() if self._backoff_factory else None,
                    max_failures=self._max_failures,
                )
                self._client = client
                try:
                    await client.run()
                except StreamError as exc:  # rejected key (fatal) or the stream being down
                    raise ProviderError(str(exc)) from None
                finally:
                    self._client = None
        finally:
            self._listening = False  # the client's own `run` closes its socket on the way out

    async def close(self) -> None:
        """Stop `listen`, close the connection and forget every subscription."""
        self._listening = False
        self._wake.set()
        client = self._client
        if client is not None:
            await client.close()
        self._wanted.clear()
        self._sub_id = None
        self._wake.clear()

    async def _on_open(self, client: StreamClient) -> None:
        self._sub_id = None
        if self._wanted:
            await client.send(self._subscription())

    async def _on_message(self, message: Any) -> None:
        # Hot path: most frames are heartbeats or ticks of the subscribed tickers, so
        # everything else is dropped after the cheapest possible look.
        if not isinstance(message, dict):
            return
        kind = message.get("messageType")
        if kind == "A":
            data = message.get("data")
            if isinstance(data, list) and len(data) >= _MIN_ROW and data[_TYPE] == "T":
                ticker = data[_TICKER]
                canonical = self._wanted.get(ticker.lower()) if isinstance(ticker, str) else None
                if canonical is not None:
                    await self._emit_trade(canonical, data)
        elif kind == "I":
            data = message.get("data")
            found = data.get("subscriptionId") if isinstance(data, dict) else None
            if isinstance(found, int | str) and not isinstance(found, bool):
                self._sub_id = found
        elif kind == "E":
            self._on_error(message)

    @staticmethod
    def _on_error(message: Mapping[str, Any]) -> None:
        response = message.get("response")
        code = _int(response.get("code")) if isinstance(response, Mapping) else None
        text = _text(response, "no message")
        if code in _FATAL_CODES:
            raise StreamFatal(f"Tiingo stream rejected TIINGO_API_KEY ({code}): {text}")
        log.warning("Tiingo stream: error %s: %s", code, text)

    async def _emit_trade(self, canonical: str, data: list[Any]) -> None:
        price = _num(data[_LAST_PRICE])
        if price is None or price <= 0:
            return
        nanos = data[_NANOS]
        if isinstance(nanos, int) and not isinstance(nanos, bool) and nanos > 10**17:
            millis = nanos // 1_000_000
            moment = datetime.fromtimestamp(millis / 1000, UTC)
        else:
            parsed = _parse_time(data[_DATE])
            moment = parsed if parsed is not None else datetime.now(UTC)
            millis = int(moment.timestamp() * 1000)
        handler = self._handler
        if handler is not None:
            await handler(
                {
                    "id": canonical,
                    "price": price,
                    "time": millis,
                    "market_hours": _market_hours(moment),
                }
            )
