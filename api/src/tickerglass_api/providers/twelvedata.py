"""Twelve Data (twelvedata.com) as a `MarketDataProvider`: a metered REST API where every
request costs credits against a per-minute and a daily allowance that depend on the plan.

Verified behaviour (recorded on a Basic account, see docs/providers.md and
tests/fixtures/twelvedata/) that shapes this module:

- Refused calls are charged: an unknown symbol, a plan-gated one and every failing entry of a
  batch cost a credit each, and a request over the per-minute allowance is charged in full.
  So nothing is sent that is known to be refused (`TwelveDataProvider._window_check`,
  `GuardedProvider` quote chunking), and unknown symbols are remembered by the services.
- `/symbol_search` is free; `/time_series`, `/quote`, `/profile`, `/dividends`, `/splits`
  and `/earnings` cost one credit per symbol (per request for the events).
- Quote time is `last_quote_at`; the `timestamp` field is the session open.
- Plan-gated symbols answer 404 ("available starting with") or 403 ("not available with
  your plan"): mapped to `ProviderUnsupported`, not `SymbolNotFound`.

Canonical symbols are Yahoo-style; `to_provider` / `from_provider` map them.
"""

import logging
import math
import re
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import pandas as pd
from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from .base import (
    BAR_COLUMNS,
    FUNDAMENTALS_INFO_KEYS,
    Capabilities,
    CostModel,
    LocalRateLimited,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    Usage,
    charge_upstream,
    report_usage,
)
from .exchanges import EXCHANGES, US_MICS, Exchange, by_mic, by_name, split_symbol
from .http import HttpRateLimited, HttpStatusError, JsonHttp, Send
from .resample import resample_bars

log = logging.getLogger(__name__)

PROVIDER_NAME = "Twelve Data"
BASE_URL = "https://api.twelvedata.com"
#: Rows per `/time_series` page (the API maximum; one credit however many rows).
PAGE_SIZE = 5000
#: Pages one `history` call may fetch (each after the first costs a credit more). The app
#: lowers it to what the per-minute burst can pay for (`TwelveDataProvider(max_pages=)`).
MAX_PAGES = 12
#: Seconds into a new calendar minute during which the credits left in the previous one
#: still count: the API's clock may run a little behind ours.
MINUTE_MARGIN_S = 2
#: Symbols per `/quote` request (the API maximum).
QUOTE_BATCH = 120
#: Rows asked for from `/earnings`.
EARNINGS_ROWS = 100
#: Requests one `events` call makes (dividends, splits, earnings), a credit each.
EVENT_REQUESTS = 3

# -- plans -------------------------------------------------------------------------------


@dataclass(frozen=True)
class PlanProfile:
    """What a Twelve Data plan allows and how the app should pace itself on it."""

    credits_per_min: int
    #: Credits per UTC day, None without a cap.
    daily_credits: int | None
    international: bool
    #: Dividends, splits and earnings (one credit each on every plan).
    events: bool
    #: Company profile (`/profile`, one credit).
    fundamentals_info: bool
    fundamentals_statements: bool
    #: Pre/post-market data.
    extended: bool
    streaming: bool
    #: Seconds a quote is served from cache, and the polling interval per symbol.
    quote_ttl_s: float
    poll_interval_s: float
    poll_closed_interval_s: float
    #: Bar tail refresh TTLs while the market is open.
    tail_ttl_intraday_s: float
    tail_ttl_daily_s: float


_BASIC = PlanProfile(
    credits_per_min=8,
    daily_credits=800,
    international=False,
    events=True,
    fundamentals_info=True,
    fundamentals_statements=False,
    extended=False,
    streaming=False,
    quote_ttl_s=300,
    poll_interval_s=300,
    poll_closed_interval_s=3600,
    tail_ttl_intraday_s=300,
    tail_ttl_daily_s=3600,
)
_GROW = replace(
    _BASIC,
    credits_per_min=55,
    daily_credits=None,
    international=True,
    quote_ttl_s=60,
    poll_interval_s=60,
    poll_closed_interval_s=600,
    tail_ttl_intraday_s=60,
    tail_ttl_daily_s=1800,
)
_PRO = replace(
    _GROW,
    credits_per_min=610,
    extended=True,
    quote_ttl_s=15,
    poll_interval_s=15,
    poll_closed_interval_s=120,
    tail_ttl_intraday_s=30,
    tail_ttl_daily_s=300,
)
PLAN_PROFILES: dict[str, PlanProfile] = {
    "basic": _BASIC,
    "grow": _GROW,
    "pro": _PRO,
    "ultra": replace(_PRO, credits_per_min=2584),
    "enterprise": replace(_PRO, credits_per_min=2584),
}


class TwelveDataConfig(BaseSettings):
    """`TWELVEDATA_*` settings. The overrides default to None: the plan's value applies."""

    model_config = SettingsConfigDict(
        env_prefix="TWELVEDATA_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    api_key: SecretStr = Field(title="API key")
    plan: Literal["basic", "grow", "pro", "ultra", "enterprise"] = Field(
        default="basic", title="Plan"
    )
    credits_per_min: int | None = Field(default=None, title="Credits per minute", ge=1)
    #: 0 removes the daily cap.
    daily_credits: int | None = Field(default=None, title="Credits per day (0: no cap)", ge=0)
    extended_hours: bool | None = Field(default=None, title="Pre/post-market data")
    events: bool | None = Field(default=None, title="Dividends, splits and earnings")
    fundamentals: bool | None = Field(default=None, title="Company profile")
    international: bool | None = Field(default=None, title="Non-US exchanges")
    poll_interval_s: float | None = Field(default=None, title="Quote poll interval (s)", gt=0)
    base_url: str = Field(default=BASE_URL, title="API base URL")


def effective_profile(config: BaseSettings | None) -> PlanProfile:
    """The plan's profile with the user's overrides applied; `None` (not configured yet)
    gives the Basic defaults."""
    if not isinstance(config, TwelveDataConfig):
        return _BASIC
    profile = PLAN_PROFILES[config.plan]
    changes: dict[str, Any] = {}
    if config.credits_per_min is not None:
        changes["credits_per_min"] = config.credits_per_min
    if config.daily_credits is not None:
        changes["daily_credits"] = config.daily_credits or None
    if config.extended_hours is not None:
        changes["extended"] = config.extended_hours
    if config.events is not None:
        changes["events"] = config.events
    if config.fundamentals is not None:
        changes["fundamentals_info"] = config.fundamentals
    if config.international is not None:
        changes["international"] = config.international
    if config.poll_interval_s is not None:
        changes["poll_interval_s"] = config.poll_interval_s
        changes["quote_ttl_s"] = config.poll_interval_s
    return replace(profile, **changes)


#: Canonical interval names served (the plan does not matter; 5d is not offered).
INTERVALS = frozenset({"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1d", "1wk", "1mo", "3mo"})


def capabilities_for(profile: PlanProfile) -> Capabilities:
    markets = {"us", "fx", "crypto"} | ({"intl", "index"} if profile.international else set())
    return Capabilities(
        intervals=INTERVALS,
        extended_history=profile.extended,
        extended_quotes=profile.extended,
        adjusted_close=False,
        search=True,
        events=frozenset({"dividends", "splits", "earnings"}) if profile.events else frozenset(),
        news=False,
        fundamentals_info=profile.fundamentals_info,
        fundamentals_statements=profile.fundamentals_statements,
        streaming=profile.streaming,
        markets=frozenset(markets),
    )


def costs_for(profile: PlanProfile) -> CostModel:
    """Credits per operation as the guard charges them (symbol lookups are free)."""
    return CostModel(
        history=1,
        symbol_info=0,
        search=0,
        quote_batch=QUOTE_BATCH,
        quote_per_request=0,
        quote_per_symbol=1,
        events=EVENT_REQUESTS if profile.events else 0,
        news=0,
        fundamentals=1,
    )


def setting_defaults_for(profile: PlanProfile) -> dict[str, Any]:
    """Defaults for the global settings: the plan's request budget, and TTLs long enough
    that cached data stands in for credits."""
    out: dict[str, Any] = {
        "upstream_rate_per_min": float(profile.credits_per_min),
        "upstream_burst": profile.credits_per_min,
        "quote_ttl_s": profile.quote_ttl_s,
        "quote_closed_ttl_s": 86400.0,
        "live_poll_interval_s": profile.poll_interval_s,
        "live_poll_closed_interval_s": profile.poll_closed_interval_s,
        "bars_tail_ttl_intraday_s": profile.tail_ttl_intraday_s,
        "bars_tail_ttl_daily_s": profile.tail_ttl_daily_s,
        "search_ttl_s": 7 * 86400.0,
        "events_ttl_s": 86400.0,
        "fundamentals_ttl_s": 7 * 86400.0,
        "cache_negative_ttl_s": 6 * 3600.0,
        "quote_negative_ttl_s": 1800.0,
        "symbol_info_ttl_s": 7 * 86400.0,
    }
    if profile.daily_credits is not None:
        out["upstream_daily_limit"] = profile.daily_credits
    return out


# -- symbols -----------------------------------------------------------------------------

#: Yahoo index symbol -> (Twelve Data symbol, IANA time zone). Indices are served from the
#: plans that allow non-US data; other indices are unsupported.
_INDICES: dict[str, tuple[str, str]] = {
    "^GSPC": ("SPX", "America/New_York"),
    "^IXIC": ("IXIC", "America/New_York"),
    "^DJI": ("DJI", "America/New_York"),
    "^RUT": ("RUT", "America/New_York"),
    "^NDX": ("NDX", "America/New_York"),
    "^VIX": ("VIX", "America/New_York"),
}
_INDEX_BY_TD = {td: yahoo for yahoo, (td, _) in _INDICES.items()}
_FIAT = frozenset(
    [
        "USD",
        "EUR",
        "GBP",
        "JPY",
        "CHF",
        "CAD",
        "AUD",
        "NZD",
        "SEK",
        "NOK",
        "DKK",
        "PLN",
        "CZK",
        "HUF",
        "TRY",
        "MXN",
        "ZAR",
        "BRL",
        "CNY",
        "HKD",
        "SGD",
        "KRW",
        "INR",
        "RUB",
        "ILS",
        "THB",
        "IDR",
        "MYR",
        "PHP",
        "TWD",
        "AED",
        "SAR",
    ]
)
_CRYPTO_QUOTES = _FIAT | {"USDT", "USDC", "BTC", "ETH"}
_FX_PAIR = re.compile(r"([A-Z]{3})([A-Z]{3})=X")
_FX_USD = re.compile(r"([A-Z]{3})=X")  # Yahoo: "JPY=X" is USD/JPY
_CRYPTO_PAIR = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3,4})")
#: Nasdaq and NYSE market tiers Twelve Data reports besides the plain MICs.
_US_MIC_TIERS = US_MICS | {"XNGS", "XNMS", "XNCM", "XASE"}
_US_NAMES = frozenset({"NASDAQ", "NYSE", "NYSE ARCA", "NYSE AMERICAN", "AMEX", "CBOE"})


@dataclass(frozen=True)
class TdSymbol:
    """A canonical symbol as Twelve Data names it."""

    symbol: str
    #: The non-US listing; None for US equities, indices, FX and crypto.
    exchange: Exchange | None
    market: Literal["us", "intl", "fx", "crypto", "index"]
    #: Time zone to express `start_date` / `end_date` in until the API names the real one.
    timezone: str

    @property
    def batch_key(self) -> str:
        """The symbol as written in a comma list (`/quote`); the answer is keyed by it."""
        return (
            f"{self.symbol}:{_exchange_param(self.exchange)[1]}" if self.exchange else self.symbol
        )

    def params(self) -> dict[str, str]:
        """Request parameters naming the instrument."""
        out = {"symbol": self.symbol}
        if self.exchange is not None:
            key, value = _exchange_param(self.exchange)
            out[key] = value
        return out


# Exchange codes that several venues share (Euronext): those are told apart by MIC.
_SHARED_CODES = {
    e.td_code
    for e in EXCHANGES.values()
    if sum(o.td_code == e.td_code for o in EXCHANGES.values()) > 1
}


def _exchange_param(exchange: Exchange) -> tuple[str, str]:
    if exchange.td_code in _SHARED_CODES:
        return "mic_code", exchange.mic
    return "exchange", exchange.td_code


def to_provider(symbol: str) -> TdSymbol | None:
    """Twelve Data's name for a canonical symbol, or None when it has none (futures,
    indices outside the small table, other `=X` forms)."""
    s = symbol.strip().upper()
    if not s or s.endswith("=F"):
        return None
    if s.startswith("^"):
        known = _INDICES.get(s)
        return TdSymbol(known[0], None, "index", known[1]) if known else None
    if s.endswith("=X"):
        pair, usd = _FX_PAIR.fullmatch(s), _FX_USD.fullmatch(s)
        if pair:
            return TdSymbol(f"{pair[1]}/{pair[2]}", None, "fx", "UTC")
        return TdSymbol(f"USD/{usd[1]}", None, "fx", "UTC") if usd else None
    crypto = _CRYPTO_PAIR.fullmatch(s)
    if crypto and crypto[2] in _CRYPTO_QUOTES:
        return TdSymbol(f"{crypto[1]}/{crypto[2]}", None, "crypto", "UTC")
    base, exchange = split_symbol(s)
    if exchange is not None:
        return TdSymbol(base.replace("-", "."), exchange, "intl", exchange.timezone)
    # Class shares: Yahoo "BRK-B", Twelve Data "BRK.B".
    return TdSymbol(s.replace("-", "."), None, "us", "America/New_York")


def from_provider(
    symbol: str, *, mic: str | None = None, exchange: str | None = None, kind: str | None = None
) -> str | None:
    """The canonical symbol of a Twelve Data listing (`mic` / `exchange` / `kind` as in a
    `/symbol_search` row), or None when the app has no name for it."""
    s = symbol.strip().upper()
    if not s:
        return None
    kind_l = (kind or "").lower()
    if "/" in s:
        base, _, quote = s.partition("/")
        if not base or not quote:
            return None
        crypto = "digital" in kind_l or (not kind_l and base not in _FIAT)
        if crypto:
            return f"{base}-{quote}" if quote in _CRYPTO_QUOTES else None
        if base in _FIAT and quote in _FIAT:
            return f"{quote}=X" if base == "USD" else f"{base}{quote}=X"
        return None
    if "index" in kind_l:
        return _INDEX_BY_TD.get(s)
    listing = by_mic(mic) if mic else None
    if listing is None and exchange:
        listing = by_name(exchange)
    plain = s.replace(".", "-")
    if (mic and mic.upper() in _US_MIC_TIERS) or (exchange or "").upper() in _US_NAMES:
        return plain
    if listing is None:
        return plain if not mic and not exchange else None
    return plain + listing.yahoo_suffix


# -- the provider ------------------------------------------------------------------------

_TYPES = {
    "common stock": "equity",
    "preferred stock": "equity",
    "depositary receipt": "equity",
    "unit": "equity",
    "reit": "equity",
    "right": "equity",
    "warrant": "equity",
    "etf": "etf",
    "mutual fund": "mutualfund",
    "index": "index",
    "physical currency": "currency",
    "digital currency": "cryptocurrency",
}
_FUNDAMENTALS_TYPES = {"common stock": "EQUITY", "etf": "ETF", "mutual fund": "MUTUALFUND"}
#: Markets whose instruments have no dividends, splits, earnings or company profile.
_NO_COMPANY_DATA = frozenset({"fx", "crypto", "index"})
_PLAN_GATED = ("not available with your plan", "available starting with")


class _NoData(ProviderError):
    """The range asked for holds no data (not an error for the caller)."""


def _seconds_to_next_minute(now: datetime) -> int:
    return 61 - now.second


def _seconds_to_midnight(now: datetime) -> int:
    midnight = datetime(now.year, now.month, now.day, tzinfo=UTC) + timedelta(days=1)
    return max(1, int((midnight - now).total_seconds()))


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def _empty_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=BAR_COLUMNS)


def _local_midnight(day: str, tz: str) -> int | None:
    """Unix seconds of exchange-local midnight of an ISO date; None when unparsable."""
    try:
        ts = pd.Timestamp(day[:10]).tz_localize(tz, nonexistent="shift_forward")
    except (TypeError, ValueError):
        return None
    return int(ts.timestamp())


def _frame(values: Sequence[Mapping[str, Any]], tz: str) -> pd.DataFrame:
    """Bars from a `/time_series` page: `datetime` is the bar open in `tz` (a date for
    daily and longer bars, which are then stamped at local midnight, as every provider
    does); numbers are strings."""
    if not values:
        return _empty_frame()
    raw = pd.DataFrame(list(values))
    for column in ("datetime", "open", "high", "low", "close"):
        if column not in raw:
            raise ProviderError(f"{PROVIDER_NAME}: time series row lacks {column!r}")
    local = pd.to_datetime(raw["datetime"], errors="coerce")
    stamp = local.dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
    ohlc = {c: pd.to_numeric(raw[c], errors="coerce") for c in ("open", "high", "low", "close")}
    volume = pd.to_numeric(raw["volume"], errors="coerce") if "volume" in raw else None
    ok = stamp.notna() & pd.concat(ohlc, axis=1).notna().all(axis=1)
    if not ok.any():
        return _empty_frame()
    utc = stamp[ok].dt.tz_convert("UTC").dt.tz_localize(None).dt.as_unit("s")
    out = pd.DataFrame(
        {
            "ts": utc.to_numpy().astype("int64"),
            "open": ohlc["open"][ok].to_numpy(float),
            "high": ohlc["high"][ok].to_numpy(float),
            "low": ohlc["low"][ok].to_numpy(float),
            "close": ohlc["close"][ok].to_numpy(float),
        }
    )
    out["adj_close"] = out["close"]
    out["volume"] = volume[ok].fillna(0).to_numpy(float) if volume is not None else 0.0
    return out[BAR_COLUMNS]


class TwelveDataProvider:
    """`MarketDataProvider` over the Twelve Data REST API (stdlib HTTP, key in the
    `Authorization` header). Also a `MeteredProvider` (`usage`)."""

    def __init__(
        self,
        config: TwelveDataConfig,
        *,
        send: Send | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        max_pages: int | None = None,
    ) -> None:
        self._profile = effective_profile(config)
        self._clock = clock
        self._plan = config.plan
        self._max_pages = max_pages
        self._plan_checked = False
        # What the user pinned is never overridden by what the API reports.
        self._pin_minute = config.credits_per_min is not None
        self._pin_daily = config.daily_credits is not None
        self._minute_limit = self._profile.credits_per_min
        # Credits the API said are left in a UTC minute (it counts in calendar minutes);
        # requests run on several threads, so every read-modify-write holds the lock.
        self._window: tuple[int, int] | None = None
        self._lock = threading.Lock()
        self._http = JsonHttp(
            config.base_url,
            send=send,
            headers={"Authorization": f"apikey {config.api_key.get_secret_value()}"},
            on_headers=self._on_headers,
        )

    # -- transport ----------------------------------------------------------------------

    def _minute(self) -> int:
        return int(self._clock().timestamp() // 60)

    def _on_headers(self, headers: Mapping[str, str]) -> None:
        try:
            used = int(headers["api-credits-used"])
            left = max(0, int(headers["api-credits-left"]))
        except (KeyError, ValueError):
            return
        minute = self._minute()
        with self._lock:
            window = self._window
            # Requests still in flight are already reserved here but not yet in `left`.
            kept = min(left, window[1]) if window is not None and window[0] == minute else left
            self._window = (minute, kept)
            # An over-limit refusal (charged in full) says nothing about the limit itself.
            learn = not self._pin_minute and not (left == 0 and used > self._minute_limit)
            if learn:
                self._minute_limit = used + left
        if learn:
            report_usage(minute_used=used, minute_left=left)
        else:
            report_usage(minute_left=left)

    def _live_window(self, now: datetime) -> tuple[int, int] | None:
        """The credits left in the minute `now` falls in (caller holds the lock). For the
        first seconds of a new minute the previous minute's count still applies."""
        window = self._window
        if window is None:
            return None
        minute = int(now.timestamp() // 60)
        if window[0] == minute:
            return window
        if window[0] == minute - 1 and now.timestamp() % 60 < MINUTE_MARGIN_S:
            return window
        return None

    def _window_check(self, credits: int) -> None:
        """Refuse locally what would be charged and refused upstream: a request costing
        more than the credits left in the current minute. Otherwise reserve `credits`."""
        if credits <= 0:
            return
        now = self._clock()
        with self._lock:
            window = self._live_window(now)
            if window is None:
                return
            if credits > window[1]:
                in_margin = window[0] != int(now.timestamp() // 60)
                wait = (
                    max(1, math.ceil(MINUTE_MARGIN_S - now.timestamp() % 60))
                    if in_margin
                    else _seconds_to_next_minute(now)
                )
                raise LocalRateLimited(
                    f"{PROVIDER_NAME}: {window[1]} credits left this minute, {credits} needed",
                    retry_after=wait,
                    credits=credits,
                )
            self._window = (window[0], window[1] - credits)

    def _window_release(self, credits: int) -> None:
        """Hand back credits reserved by `_window_check` for a request not sent."""
        with self._lock:
            if self._window is not None:
                self._window = (self._window[0], self._window[1] + credits)

    def _get(self, path: str, params: Mapping[str, str], credits: int = 1) -> Any:
        """GET and unwrap errors (HTTP ones and `status: error` bodies)."""
        self._window_check(credits)
        try:
            body = self._http.get(path, params)
        except HttpRateLimited as exc:
            raise self._rate_limited(_message(exc.body, str(exc))) from None
        except HttpStatusError as exc:
            raise self._error(exc.status, exc.body, params.get("symbol", "")) from None
        if isinstance(body, dict) and body.get("status") == "error":
            raise self._error(_int(body.get("code")) or 0, body, params.get("symbol", ""))
        return body

    def _rate_limited(self, message: str) -> RateLimited:
        now = self._clock()
        lower = message.lower()
        if "for the day" in lower or "daily" in lower:
            return RateLimited(
                f"{PROVIDER_NAME}: daily credits used up", _seconds_to_midnight(now), daily=True
            )
        return RateLimited(
            f"{PROVIDER_NAME}: per-minute credits used up", _seconds_to_next_minute(now)
        )

    def _error(self, status: int, body: Any, symbol: str) -> ProviderError:
        """Map an error answer to the provider errors; `ProviderUnsupported` for what the
        plan does not include, `SymbolNotFound` for an unknown symbol."""
        message = _message(body, f"HTTP {status}")
        lower = message.lower()
        code = _int(body.get("code")) if isinstance(body, dict) else None
        status = code or status
        if status == 429:
            return self._rate_limited(message)
        if status == 401:
            return ProviderNotConfigured(
                "Twelve Data rejected TWELVEDATA_API_KEY (invalid or not set)"
            )
        if any(marker in lower for marker in _PLAN_GATED):
            return ProviderUnsupported(
                "symbols outside the current Twelve Data plan", PROVIDER_NAME
            )
        if "no data is available" in lower or "no data found" in lower:
            return _NoData(message)
        if status == 404 or ("symbol" in lower and ("not found" in lower or "invalid" in lower)):
            return SymbolNotFound(symbol)
        return ProviderError(f"{PROVIDER_NAME}: {message}")

    # -- symbols ------------------------------------------------------------------------

    def _resolve(self, symbol: str) -> TdSymbol:
        mapped = to_provider(symbol)
        if mapped is None:
            s = symbol.strip().upper()
            what = "futures" if s.endswith("=F") else "index symbols" if s.startswith("^") else s
            raise ProviderUnsupported(what, PROVIDER_NAME)
        if mapped.market in ("intl", "index") and not self._profile.international:
            raise ProviderUnsupported(
                "index symbols" if mapped.market == "index" else "international symbols",
                PROVIDER_NAME,
            )
        return mapped

    # -- history ------------------------------------------------------------------------

    _NATIVE = {
        "1m": "1min",
        "5m": "5min",
        "15m": "15min",
        "30m": "30min",
        "60m": "1h",
        "1d": "1day",
        "1wk": "1week",
        "1mo": "1month",
    }
    # Intervals built from a finer one: (source, resample rule, factor, source span).
    _SYNTH: dict[str, tuple[str, Literal["epoch", "session", "quarter"], int, timedelta]] = {
        "2m": ("1m", "epoch", 2, timedelta(minutes=2)),
        "90m": ("30m", "session", 90, timedelta(minutes=90)),
        "3mo": ("1mo", "quarter", 3, timedelta(days=93)),
    }

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        sym = self._resolve(symbol)
        synth = self._SYNTH.get(interval)
        source = synth[0] if synth else interval
        if source not in self._NATIVE:
            raise ProviderUnsupported(f"{interval} bars", PROVIDER_NAME)
        fetch_start = start
        if start is not None and synth:
            if synth[1] == "session":
                # Buckets are anchored on the first bar of each local day: start at that
                # day's midnight so a mid-session `start` still sees the session open.
                zone = ZoneInfo(sym.timezone)
                local = start.astimezone(zone)
                fetch_start = datetime(local.year, local.month, local.day, tzinfo=zone)
            else:
                fetch_start = start - synth[3]
        extended = (
            prepost
            and self._profile.extended
            and sym.market == "us"
            and source in ("1m", "5m", "15m", "30m")
        )
        frame, tz = self._series(sym, self._NATIVE[source], fetch_start, end, extended)
        if synth:
            frame = resample_bars(frame, synth[1], synth[2], tz)
        if frame.empty:
            return _empty_frame()
        ts = frame["ts"]
        mask = pd.Series(True, index=frame.index)
        if start is not None:
            mask &= ts >= int(start.timestamp())
        if end is not None:
            mask &= ts < int(end.timestamp())
        return frame[mask].sort_values("ts").reset_index(drop=True)

    def _series(
        self,
        sym: TdSymbol,
        td_interval: str,
        start: datetime | None,
        end: datetime | None,
        extended: bool,
    ) -> tuple[pd.DataFrame, str]:
        """Pages of `/time_series` newest first, walking back while a page is full and the
        oldest row is still after `start`. Returns the bars and the exchange time zone."""
        daily = td_interval in ("1day", "1week", "1month")
        params = {
            **sym.params(),
            "interval": td_interval,
            "outputsize": str(PAGE_SIZE),
            "order": "desc",
        }
        if extended:
            params["prepost"] = "true"
        if start is not None:
            params["start_date"] = _api_time(
                start - (timedelta(days=1) if daily else timedelta(0)), sym.timezone, daily
            )
        if end is not None:
            params["end_date"] = _api_time(
                end + (timedelta(days=1) if daily else timedelta(0)), sym.timezone, daily
            )
        tz = sym.timezone
        pages: list[pd.DataFrame] = []
        oldest: str | None = None
        limit = MAX_PAGES if self._max_pages is None else min(MAX_PAGES, self._max_pages)
        for page in range(limit):
            if page and not self._pay_for_page():
                break  # out of credits: serve the newer pages already fetched
            try:
                body = self._get("/time_series", params, credits=0 if page else 1)
            except _NoData:
                break
            values = body.get("values") if isinstance(body, dict) else None
            if not isinstance(values, list):
                raise ProviderError(f"{PROVIDER_NAME}: unexpected time series payload")
            meta = body.get("meta")
            if page == 0 and isinstance(meta, dict) and meta.get("exchange_timezone"):
                tz = _valid_tz(str(meta["exchange_timezone"]), tz)
            if not values:
                break
            frame = _frame(values, tz)
            pages.append(frame)
            last = str(values[-1].get("datetime", "")) if isinstance(values[-1], dict) else ""
            if len(values) < PAGE_SIZE or not last or last == oldest or frame.empty:
                break
            oldest = last
            if start is not None and int(frame["ts"].min()) <= int(start.timestamp()):
                break
            params["end_date"] = last
        else:
            if pages:
                log.info("%s: time series paging stopped after %d pages", PROVIDER_NAME, limit)
        if not pages:
            return _empty_frame(), tz
        out = pd.concat(pages, ignore_index=True)
        out = out.drop_duplicates("ts", keep="first").sort_values("ts").reset_index(drop=True)
        return out, tz

    def _pay_for_page(self) -> bool:
        """Reserve and charge the credit of a further page. False when the minute's credits
        or the guard's budget cannot pay for it (nothing is sent, and the pages already
        fetched are worth more than an error)."""
        try:
            self._window_check(1)
        except RateLimited as exc:
            log.info("%s: no credits for a further page: %s", PROVIDER_NAME, exc)
            return False
        try:
            charge_upstream(1)  # a further page is a further credit
        except ProviderError as exc:
            self._window_release(1)
            log.info("%s: guard refused a further page: %s", PROVIDER_NAME, exc)
            return False
        return True

    # -- symbol info and search ---------------------------------------------------------

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        sym = self._resolve(symbol)
        rows = self._lookup(sym.symbol, 30)
        row = self._pick(rows, sym)
        if row is None:
            raise SymbolNotFound(symbol)
        listing = by_mic(str(row.get("mic_code") or "")) or by_name(str(row.get("exchange") or ""))
        kind = str(row.get("instrument_type") or "")
        market = sym.market
        if market in ("fx", "crypto"):
            tz, session = "UTC", "0000-2359"
        elif market == "index":
            tz, session = sym.timezone, "0930-1600"
        elif listing is not None:
            tz, session = listing.timezone, listing.session
        else:
            tz = _valid_tz(str(row.get("exchange_timezone") or ""), sym.timezone)
            session = "0930-1600"
        hint = 4 if market == "fx" else 2
        return {
            "symbol": symbol.strip().upper(),
            "name": str(row.get("instrument_name") or symbol),
            "exchange": row.get("exchange") or None,
            "exchangeName": row.get("exchange") or None,
            "type": _type_of(kind),
            "currency": row.get("currency") or None,
            "timezone": tz,
            "session": session,
            "priceHint": hint,
            "minTick": 10**-hint,
            "hasIntraday": True,
        }

    def _lookup(self, query: str, size: int) -> list[dict[str, Any]]:
        body = self._get("/symbol_search", {"symbol": query, "outputsize": str(size)}, credits=0)
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected symbol search payload")
        return [r for r in data if isinstance(r, dict)]

    @staticmethod
    def _pick(rows: list[dict[str, Any]], sym: TdSymbol) -> dict[str, Any] | None:
        """The listing `sym` names. The ranking of the search is unreliable (BRK.B comes
        seventh), so match the symbol exactly, on the requested exchange or among the US
        ones, and by type for FX, crypto and indices."""
        exact = [r for r in rows if str(r.get("symbol", "")).upper() == sym.symbol.upper()]
        if sym.market == "intl" and sym.exchange is not None:
            for r in exact:
                found = by_mic(str(r.get("mic_code") or "")) or by_name(
                    str(r.get("exchange") or "")
                )
                if found is not None and found.mic == sym.exchange.mic:
                    return r
            return None
        if sym.market in ("fx", "crypto", "index"):
            want = {"fx": "physical", "crypto": "digital", "index": "index"}[sym.market]
            return next(
                (r for r in exact if want in str(r.get("instrument_type", "")).lower()), None
            )
        for r in exact:
            if _is_us(r) and str(r.get("instrument_type", "")).lower() != "depositary receipt":
                return r
        return None

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        rows = self._lookup(query, min(50, max(10, limit * 3)))
        out: list[dict[str, Any]] = []
        seen: set[str] = set()
        for r in rows:
            kind = str(r.get("instrument_type") or "")
            canonical = from_provider(
                str(r.get("symbol") or ""),
                mic=str(r.get("mic_code") or "") or None,
                exchange=str(r.get("exchange") or "") or None,
                kind=kind,
            )
            if canonical is None or canonical in seen:
                continue
            mapped = to_provider(canonical)
            if mapped is None or (
                mapped.market in ("intl", "index") and not self._profile.international
            ):
                continue  # not servable on this plan
            seen.add(canonical)
            out.append(
                {
                    "symbol": canonical,
                    "name": str(r.get("instrument_name") or canonical),
                    "exchange": r.get("exchange") or None,
                    "type": _type_of(kind),
                    "typeDisplay": kind or None,
                }
            )
            if len(out) >= limit:
                break
        return out

    # -- symbol routing (see `base.SymbolRouting`) ---------------------------------------

    def billable(self, symbols: list[str]) -> list[str]:
        """The symbols a quote call would send: each once, without those this plan or
        Twelve Data cannot serve (answered locally, never worth a credit)."""
        out: list[str] = []
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            try:
                self._resolve(raw)
            except ProviderUnsupported:
                continue
            out.append(raw)
        return out

    def answers_locally(self, op: str, symbol: str) -> bool:
        """Whether `op` for `symbol` is answered without a request: an unsupported symbol,
        or events and fundamentals of instruments that have none (FX, crypto, indices)."""
        try:
            sym = self._resolve(symbol)
        except ProviderUnsupported:
            return True
        return op in ("events", "fundamentals") and sym.market in _NO_COMPANY_DATA

    # -- quotes -------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol, `QuoteList.confirmed` when every symbol got a
        definite answer (a row, "not found", or "not on this plan"); the services then
        remember the missing ones instead of asking again. Symbols the plan cannot serve
        are not sent; `ProviderUnsupported` only when none can be."""
        rows, confirmed = self._quote_rows(symbols, extended=False)
        return QuoteList(rows, confirmed=confirmed)

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        if not self._profile.extended:
            raise ProviderUnsupported("extended-hours quotes", PROVIDER_NAME)
        rows, _ = self._quote_rows(symbols, extended=True)
        return rows

    def _quote_rows(
        self, symbols: list[str], *, extended: bool
    ) -> tuple[list[dict[str, Any]], bool]:
        wanted: dict[str, TdSymbol] = {}  # canonical -> mapped, request order
        unsupported: list[ProviderUnsupported] = []
        confirmed = True
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            try:
                wanted[raw] = self._resolve(raw)
            except ProviderUnsupported as exc:
                unsupported.append(exc)  # free to know, never worth a credit
        if not wanted:
            if unsupported:
                raise unsupported[0]
            return [], True
        # Several canonical symbols may name one listing (USDJPY=X and JPY=X): one entry
        # in the request, one row for each of them.
        by_key: dict[str, list[str]] = {}
        for canonical, mapped in wanted.items():
            by_key.setdefault(mapped.batch_key, []).append(canonical)
        keys = list(by_key)
        rows: list[dict[str, Any]] = []
        for i in range(0, len(keys), QUOTE_BATCH):
            chunk = keys[i : i + QUOTE_BATCH]
            found, answered = self._quote_chunk(chunk, by_key, extended)
            rows.extend(found)
            confirmed = confirmed and answered
        return rows, confirmed

    def _quote_chunk(
        self, keys: list[str], canonical: Mapping[str, list[str]], extended: bool
    ) -> tuple[list[dict[str, Any]], bool]:
        params = {"symbol": ",".join(keys)}
        if extended:
            params["prepost"] = "true"
        single = len(keys) == 1
        try:
            body = self._get("/quote", params, credits=len(keys))
        except (SymbolNotFound, ProviderUnsupported) as exc:
            if single:
                return [], True  # a definite answer for the one symbol
            raise ProviderError(f"{PROVIDER_NAME}: whole quote request refused: {exc}") from None
        if not isinstance(body, dict):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected quote payload")
        entries: dict[str, Any] = {keys[0]: body} if single else body
        lowered = {str(k).upper(): v for k, v in entries.items()}
        rows: list[dict[str, Any]] = []
        answered = True
        for key in keys:
            entry = lowered.get(key.upper())
            if not isinstance(entry, dict):
                answered = False  # no word about this symbol
                continue
            if entry.get("status") == "error":
                error = self._error(_int(entry.get("code")) or 0, entry, key)
                if isinstance(error, (SymbolNotFound, ProviderUnsupported)):
                    continue  # definite: unknown, or not on this plan
                if isinstance(error, RateLimited):
                    raise error
                answered = False
                continue
            made = [
                _extended_row(name, entry) if extended else _quote_row(name, entry)
                for name in canonical[key]
            ]
            if None in made:
                answered = False
            rows.extend(row for row in made if row is not None)
        return rows, answered

    # -- events, fundamentals -----------------------------------------------------------

    def events(self, symbol: str) -> dict[str, Any]:
        if not self._profile.events:
            raise ProviderUnsupported("events", PROVIDER_NAME)
        sym = self._resolve(symbol)
        if sym.market in _NO_COMPANY_DATA:
            return {"dividends": [], "splits": [], "earnings": []}
        base = sym.params()
        # All three requests are paid for (and refused locally if the minute cannot) up
        # front, so a later one is never the one that fails for lack of credits.
        self._window_check(EVENT_REQUESTS)

        def fetch(path: str, extra: Mapping[str, str], *, first: bool = False) -> Any:
            try:
                return self._get(path, {**base, **extra}, credits=0)
            except _NoData:
                return {}
            except RateLimited:
                raise  # the upstream refused: the guard must hear of it
            except ProviderError as exc:
                if first:
                    raise
                # What came before is worth more than nothing.
                log.warning("%s: %s of %s failed, left out: %s", PROVIDER_NAME, path, symbol, exc)
                return {}

        dividends = fetch("/dividends", {"range": "full"}, first=True)
        splits = fetch("/splits", {"range": "full"})
        earnings = fetch("/earnings", {"outputsize": str(EARNINGS_ROWS)})
        tz = sym.timezone
        for body in (dividends, splits, earnings):
            meta = body.get("meta") if isinstance(body, dict) else None
            if isinstance(meta, dict) and meta.get("exchange_timezone"):
                tz = _valid_tz(str(meta["exchange_timezone"]), tz)
                break
        return {
            "dividends": _dividends(_items(dividends, "dividends"), tz),
            "splits": _splits(_items(splits, "splits"), tz),
            "earnings": _earnings(_items(earnings, "earnings"), tz),
        }

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise ProviderUnsupported("news", PROVIDER_NAME)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        """Company profile only (`/profile`, one credit): no statements, no ratios."""
        if not self._profile.fundamentals_info:
            raise ProviderUnsupported("fundamentals", PROVIDER_NAME)
        sym = self._resolve(symbol)
        if sym.market in _NO_COMPANY_DATA:
            return {"info": {}}
        body = self._get("/profile", sym.params())
        if not isinstance(body, dict) or not body.get("symbol"):
            raise SymbolNotFound(symbol)
        kind = str(body.get("type") or "").lower()
        employees = _int(body.get("employees"))
        info: dict[str, Any] = {
            "longName": body.get("name"),
            "quoteType": _FUNDAMENTALS_TYPES.get(kind, kind.upper() or None),
            "currency": body.get("currency"),
            "exchange": body.get("exchange"),
            "sector": body.get("sector"),
            "industry": body.get("industry"),
            "country": body.get("country"),
            "website": body.get("website"),
            "fullTimeEmployees": employees,
            "longBusinessSummary": body.get("description"),
        }
        return {"info": {k: v for k, v in info.items() if k in FUNDAMENTALS_INFO_KEYS and v}}

    # -- usage --------------------------------------------------------------------------

    def usage(self) -> Usage:
        """Credits as the API counts them (`/api_usage`, one credit, itself included).
        Limits the user pinned are left out so they stay in force."""
        body = self._get("/api_usage", {})
        if not isinstance(body, dict):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected usage payload")
        category = str(body.get("plan_category") or "").strip().lower()
        if category and category != self._plan and not self._plan_checked:
            self._plan_checked = True
            log.warning(
                "%s reports plan %r but TWELVEDATA_PLAN is %r: limits follow what the API "
                "reports unless pinned by TWELVEDATA_CREDITS_PER_MIN / _DAILY_CREDITS",
                PROVIDER_NAME,
                category,
                self._plan,
            )
        # A daily limit the API leaves out or sets to 0 or null means no cap (Usage: 0).
        daily_limit = (
            None
            if self._pin_daily or "plan_daily_limit" not in body
            else (_int(body.get("plan_daily_limit")) or 0)
        )
        return Usage(
            minute_limit=None if self._pin_minute else _int(body.get("plan_limit")),
            minute_used=_int(body.get("current_usage")),
            daily_limit=daily_limit,
            daily_used=_int(body.get("daily_usage")),
        )


# -- helpers -----------------------------------------------------------------------------


def _message(body: Any, default: str) -> str:
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return str(body["message"])
    return default


def _valid_tz(name: str, fallback: str) -> str:
    try:
        ZoneInfo(name)
    except (KeyError, ValueError, OSError):
        return fallback
    return name


def _api_time(moment: datetime, tz: str, daily: bool) -> str:
    local = moment.astimezone(ZoneInfo(tz))
    return local.strftime("%Y-%m-%d" if daily else "%Y-%m-%d %H:%M:%S")


def _type_of(kind: str) -> str | None:
    key = kind.strip().lower()
    return _TYPES.get(key) or (key.replace(" ", "") or None)


def _is_us(row: Mapping[str, Any]) -> bool:
    mic = str(row.get("mic_code") or "").upper()
    return mic in _US_MIC_TIERS or str(row.get("exchange") or "").upper() in _US_NAMES


def _quote_row(canonical: str, q: Mapping[str, Any]) -> dict[str, Any] | None:
    last = _num(q.get("close"))
    if last is None:
        return None
    # `timestamp` is the session open; the last trade is `last_quote_at`.
    when = _int(q.get("last_quote_at")) or _int(q.get("timestamp"))
    currency = q.get("currency")
    return {
        "symbol": canonical,
        "last": last,
        "prevClose": _num(q.get("previous_close")),
        "change": _num(q.get("change")),
        "changePercent": _num(q.get("percent_change")),
        "volume": _int(q.get("volume")),
        "currency": currency if isinstance(currency, str) else None,
        "marketState": "REGULAR" if q.get("is_market_open") else "CLOSED",
        "time": when,
    }


def _extended_row(canonical: str, q: Mapping[str, Any]) -> dict[str, Any] | None:
    """Pre/post-market fields of a `/quote?prepost=true` answer. Which of the two the
    `extended_*` fields belong to follows from their time against the session open."""
    regular = _num(q.get("close"))
    if regular is None:
        return None
    when = _int(q.get("last_quote_at")) or _int(q.get("timestamp"))
    opened = _int(q.get("timestamp"))
    price = _num(q.get("extended_price"))
    stamp = _int(q.get("extended_timestamp"))
    change = _num(q.get("extended_change"))
    pct = _num(q.get("extended_percent_change"))
    is_open = bool(q.get("is_market_open"))
    pre = post = False
    if price is not None and stamp is not None and not is_open:
        pre = opened is not None and stamp < opened
        post = not pre
    empty = {"Price": None, "Time": None, "Change": None, "ChangePercent": None}

    def session(prefix: str, on: bool) -> dict[str, Any]:
        if not on:
            return {f"{prefix}{k}": v for k, v in empty.items()}
        return {
            f"{prefix}Price": price,
            f"{prefix}Time": stamp,
            f"{prefix}Change": change,
            f"{prefix}ChangePercent": pct,
        }

    return {
        "symbol": canonical,
        "marketState": "REGULAR" if is_open else "PRE" if pre else "POST" if post else "CLOSED",
        "regularMarketPrice": regular,
        "regularMarketTime": when,
        **session("preMarket", pre),
        **session("postMarket", post),
    }


def _items(body: Any, key: str) -> list[Mapping[str, Any]]:
    items = body.get(key) if isinstance(body, dict) else None
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _dividends(items: list[Mapping[str, Any]], tz: str) -> list[dict[str, Any]]:
    out = []
    for i in items:
        t = _local_midnight(str(i.get("ex_date") or ""), tz)
        amount = _num(i.get("amount"))
        if t is not None and amount is not None:
            out.append({"t": t, "amount": amount})
    return sorted(out, key=lambda e: e["t"])


def _splits(items: list[Mapping[str, Any]], tz: str) -> list[dict[str, Any]]:
    out = []
    for i in items:
        t = _local_midnight(str(i.get("date") or ""), tz)
        to, frm = _num(i.get("to_factor")), _num(i.get("from_factor"))
        # Yahoo's ratio for a 4-for-1 split is 4.0; Twelve Data's `ratio` is its inverse
        # (0.25) and `from_factor` / `to_factor` are 4 / 1.
        ratio = frm / to if to and frm else None
        if ratio is None:
            inverse = _num(i.get("ratio"))
            ratio = 1 / inverse if inverse else None
        if t is not None and ratio is not None:
            out.append({"t": t, "ratio": ratio})
    return sorted(out, key=lambda e: e["t"])


def _earnings(items: list[Mapping[str, Any]], tz: str) -> list[dict[str, Any]]:
    out = []
    for i in items:
        t = _local_midnight(str(i.get("date") or ""), tz)
        if t is None:
            continue
        out.append(
            {
                "t": t,
                "epsEstimate": _num(i.get("eps_estimate")),
                "epsActual": _num(i.get("eps_actual")),
                "surprisePercent": _num(i.get("surprise_prc")),
            }
        )
    return sorted(out, key=lambda e: e["t"])
