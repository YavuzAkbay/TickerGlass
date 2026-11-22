"""Massive (massive.com, formerly Polygon.io) as a `MarketDataProvider`: a REST API whose
plan decides which data and how many calls per minute a key gets (docs/design/more-providers.md
section 4). Every fact below comes from documentation, not from a live account: no key was
available when this module was written, and the fixtures in tests/fixtures/massive/ are
hand-built from the documented response shapes.

How the plans shape the module:

- `basic` (free): end-of-day data, two years back, 5 calls per minute, no snapshots. So only
  `1d, 1wk, 1mo, 3mo` bars are offered, and quotes cost one call per symbol (the last two
  daily bars: price and previous close in one request). The other plans serve minute bars and
  the batch snapshot (15-minute delayed on `starter` and `developer`) with no call limit.
- Prices are split-adjusted only (`adjusted=true`), never dividend-adjusted: `adj_close` equals
  `close` and `Capabilities.adjusted_close` is false, as for Twelve Data.
- Bars are requested newest first (`sort=desc`) and `next_url` pages are followed while the
  guard's budget pays for them, so a truncated history loses its oldest bars, not its newest.
- The key travels in the `Authorization: Bearer` header only. `next_url` is followed only
  when it names the origin of `base_url`, and any `apiKey` it carries is dropped.
- Streaming is not offered (Massive's WebSocket is paid and per asset class; the hub polls).
  Dividends, splits, news and financial statements are not offered either.

Canonical symbols are Yahoo-style; `to_provider` / `from_provider` map them. Stocks and ETFs
are plain (`BRK-B` is `BRK.B`), crypto is `X:BTCUSD` and forex `C:EURUSD`. Indices
(`I:SPX`, a separate paid asset class), futures and listings outside the US are unsupported.

Unverified (marked so because they were guessed from documentation or memory; the first live
call must confirm them, and each degrades to a clear `ProviderError` rather than wrong data):

- aggregates of a ticker that does not exist answer 200 with no `results` (not 404): an empty
  first page then costs one `/v3/reference/tickers/{T}` call to tell "unknown" from "no bars";
- daily, weekly and monthly bars carry `t` at midnight New York time of the bar's first day
  (the code reads the calendar day of `t` + 12 hours, which also holds for UTC midnight);
  a weekly bar starting on a Sunday is moved to the Monday after it;
- native `{n}/minute` multipliers 1, 5, 15 and 30 align to the clock (9:30 is a bar edge); 60m
  and 90m bars are therefore built from 30m ones with `resample.py`, 2m from 1m;
- minute aggregates include pre/post-market bars, which `prepost=False` filters out locally;
- the plan history depths (basic 2, starter 5, developer 10 years; advanced unbounded);
- the plan-refusal answer is 403 with `status: NOT_AUTHORIZED`, a bad key is 401, a missing
  ticker 404 `NOT_FOUND`, an over-limit call 429 (a 200 body with status `DELAYED` is data);
- `/v2/snapshot/locale/{us|global}/markets/{stocks|crypto|forex}/tickers` answers
  `tickers: [{ticker, day, min, prevDay, lastTrade, ...}]`, omitting symbols it does not know;
  a plan without crypto/forex data refuses those with 403 (-> `ProviderUnsupported`);
- the free key serves crypto and forex end-of-day data too (capabilities declare the markets
  on every plan; a refusal is mapped as above);
- crypto and forex tickers use `X:` / `C:` prefixes; forex daily bars are stamped on the UTC
  day of `t`.
"""

import logging
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import SplitResult, parse_qsl, quote, urlsplit
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from ..settings import Settings
from .base import (
    BAR_COLUMNS,
    FUNDAMENTALS_INFO_KEYS,
    Capabilities,
    CostModel,
    MarketDataProvider,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    charge_upstream,
    report_usage,
)
from .exchanges import by_mic
from .http import HttpRateLimited, HttpStatusError, JsonHttp, Send, require_https
from .resample import resample_bars

log = logging.getLogger(__name__)

PROVIDER_NAME = "Massive"
BASE_URL = "https://api.massive.com"
#: Rows per aggregates page (the API maximum).
PAGE_SIZE = 50000
#: Pages one `history` call may fetch (each after the first is a call more).
MAX_PAGES = 20
#: Symbols per snapshot request (the API names no limit; this keeps the URL short).
QUOTE_BATCH = 100
#: Search rows asked for, at least (the results are re-ranked locally).
SEARCH_MIN_ROWS = 10
SEARCH_MAX_ROWS = 100
#: Calendar days the single-symbol daily quote looks back for its two bars (holidays).
QUOTE_LOOKBACK_DAYS = 14

NEW_YORK = "America/New_York"

# -- plans -------------------------------------------------------------------------------


@dataclass(frozen=True)
class PlanProfile:
    """What a Massive plan allows and how the app should pace itself on it."""

    #: API calls per minute, None when unlimited (the global request budget then applies).
    calls_per_min: int | None
    #: Years of history served, None without a bound.
    history_years: int | None
    #: Minute and hour aggregates (the basic plan is end-of-day only).
    intraday: bool
    #: Batch snapshot of many tickers in one call.
    snapshot: bool
    #: Minutes the data is delayed (informational; 0 for real-time or end-of-day).
    delay_min: int
    #: Seconds a quote is served from cache, and the polling interval per symbol.
    quote_ttl_s: float
    poll_interval_s: float
    poll_closed_interval_s: float
    #: Bar tail refresh TTLs while the market is open.
    tail_ttl_intraday_s: float
    tail_ttl_daily_s: float


_BASIC = PlanProfile(
    calls_per_min=5,
    history_years=2,
    intraday=False,
    snapshot=False,
    delay_min=0,
    quote_ttl_s=3600,
    poll_interval_s=3600,
    poll_closed_interval_s=6 * 3600,
    tail_ttl_intraday_s=3600,
    tail_ttl_daily_s=3600,
)
_STARTER = replace(
    _BASIC,
    calls_per_min=None,
    history_years=5,
    intraday=True,
    snapshot=True,
    delay_min=15,
    quote_ttl_s=60,
    poll_interval_s=60,
    poll_closed_interval_s=600,
    tail_ttl_intraday_s=60,
    tail_ttl_daily_s=1800,
)
_DEVELOPER = replace(_STARTER, history_years=10)
_ADVANCED = replace(
    _DEVELOPER,
    history_years=None,
    delay_min=0,
    quote_ttl_s=15,
    poll_interval_s=15,
    poll_closed_interval_s=120,
    tail_ttl_intraday_s=30,
    tail_ttl_daily_s=300,
)
PLAN_PROFILES: dict[str, PlanProfile] = {
    "basic": _BASIC,
    "starter": _STARTER,
    "developer": _DEVELOPER,
    "advanced": _ADVANCED,
}


class MassiveConfig(BaseSettings):
    """`MASSIVE_*` settings."""

    model_config = SettingsConfigDict(
        env_prefix="MASSIVE_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    api_key: SecretStr = Field(title="API key")
    plan: Literal["basic", "starter", "developer", "advanced"] = Field(
        default="basic", title="Plan"
    )
    #: `https://api.polygon.io` still works.
    base_url: str = Field(default=BASE_URL, title="API base URL")

    @field_validator("base_url")
    @classmethod
    def _https_only(cls, value: str) -> str:
        """The key travels in a header to this URL: https, or http for a local host."""
        return require_https(value, "MASSIVE_BASE_URL")


def effective_profile(config: BaseSettings | None) -> PlanProfile:
    """The configured plan's profile; `None` (not configured yet) gives the basic one."""
    if not isinstance(config, MassiveConfig):
        return _BASIC
    return PLAN_PROFILES[config.plan]


_INTRADAY_INTERVALS = frozenset({"1m", "2m", "5m", "15m", "30m", "60m", "90m"})
_DAILY_INTERVALS = frozenset({"1d", "1wk", "1mo", "3mo"})


def capabilities_for(profile: PlanProfile) -> Capabilities:
    return Capabilities(
        intervals=_INTRADAY_INTERVALS | _DAILY_INTERVALS if profile.intraday else _DAILY_INTERVALS,
        extended_history=profile.intraday,
        extended_quotes=False,
        adjusted_close=False,
        search=True,
        events=frozenset(),
        news=False,
        fundamentals_info=True,
        fundamentals_statements=False,
        streaming=False,
        markets=frozenset({"us", "fx", "crypto"}),
    )


def costs_for(profile: PlanProfile) -> CostModel:
    """Calls per operation as the guard charges them. Without a snapshot (basic) every
    symbol of a quote call is a call of its own: it is priced per symbol (so the guard
    splits a long list into chunks no larger than its burst, like Twelve Data), not per
    request."""
    per_symbol = not profile.snapshot
    return CostModel(
        history=1,
        symbol_info=1,
        search=1,
        quote_batch=QUOTE_BATCH,
        quote_per_request=0 if per_symbol else 1,
        quote_per_symbol=1 if per_symbol else 0,
        events=0,
        news=0,
        fundamentals=1,
    )


def setting_defaults_for(profile: PlanProfile) -> dict[str, Any]:
    """Defaults for the global settings: the free plan's call budget (the paid plans have
    none, so the global defaults stay), and TTLs long enough that the cache stands in for
    calls."""
    out: dict[str, Any] = {
        "quote_ttl_s": profile.quote_ttl_s,
        "quote_closed_ttl_s": 86400.0,
        "live_poll_interval_s": profile.poll_interval_s,
        "live_poll_closed_interval_s": profile.poll_closed_interval_s,
        "bars_tail_ttl_intraday_s": profile.tail_ttl_intraday_s,
        "bars_tail_ttl_daily_s": profile.tail_ttl_daily_s,
        "search_ttl_s": 7 * 86400.0,
        "fundamentals_ttl_s": 7 * 86400.0,
        "cache_negative_ttl_s": 6 * 3600.0,
        "quote_negative_ttl_s": 1800.0,
        "symbol_info_ttl_s": 7 * 86400.0,
    }
    if profile.calls_per_min is not None:
        out["upstream_rate_per_min"] = float(profile.calls_per_min)
        out["upstream_burst"] = profile.calls_per_min
    return out


# -- registry hooks (see `registry.ProviderSpec`) -----------------------------------------


def make_provider(_: Settings, config: BaseSettings | None) -> MarketDataProvider:
    assert isinstance(config, MassiveConfig)
    return MassiveProvider(config)


def spec_capabilities(config: BaseSettings | None) -> Capabilities:
    return capabilities_for(effective_profile(config))


def spec_costs(config: BaseSettings | None) -> CostModel:
    return costs_for(effective_profile(config))


def spec_setting_defaults(config: BaseSettings | None) -> dict[str, Any]:
    return setting_defaults_for(effective_profile(config))


def spec_plan(config: BaseSettings | None) -> str | None:
    return config.plan if isinstance(config, MassiveConfig) else "basic"


# -- symbols -----------------------------------------------------------------------------

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
        "ILS",
        "THB",
    ]
)
_CRYPTO_QUOTES = _FIAT | {"USDT", "USDC", "BTC", "ETH"}
_CRYPTO_QUOTES_LONGEST_FIRST = sorted(_CRYPTO_QUOTES, key=lambda q: (-len(q), q))
_FX_PAIR = re.compile(r"([A-Z]{3})([A-Z]{3})=X")
_FX_USD = re.compile(r"([A-Z]{3})=X")  # Yahoo: "JPY=X" is USD/JPY
_CRYPTO_PAIR = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3,4})")
#: What Yahoo-style US symbols look like (class shares use "-": BRK-B).
_US_SYMBOL = re.compile(r"[A-Z0-9]+(?:-[A-Z0-9]+)?")

Market = Literal["us", "fx", "crypto"]


@dataclass(frozen=True)
class MassiveSymbol:
    """A canonical symbol as Massive names it."""

    ticker: str
    market: Market

    @property
    def timezone(self) -> str:
        return NEW_YORK if self.market == "us" else "UTC"


def to_provider(symbol: str) -> MassiveSymbol | None:
    """Massive's name for a canonical symbol, or None when it has none (futures, indices,
    non-US listings, other `=X` forms)."""
    s = symbol.strip().upper()
    if not s:
        return None
    if s.endswith("=X"):
        pair, usd = _FX_PAIR.fullmatch(s), _FX_USD.fullmatch(s)
        if pair:
            return MassiveSymbol(f"C:{pair[1]}{pair[2]}", "fx")
        return MassiveSymbol(f"C:USD{usd[1]}", "fx") if usd else None
    crypto = _CRYPTO_PAIR.fullmatch(s)
    if crypto and crypto[2] in _CRYPTO_QUOTES:
        return MassiveSymbol(f"X:{crypto[1]}{crypto[2]}", "crypto")
    if _US_SYMBOL.fullmatch(s):
        return MassiveSymbol(s.replace("-", "."), "us")
    return None  # "=F" futures, "^" indices, a dotted suffix (a non-US listing), odd text


def from_provider(
    ticker: str, *, market: str | None = None, locale: str | None = None
) -> str | None:
    """The canonical symbol of a Massive ticker (`market` / `locale` as in a
    `/v3/reference/tickers` row), or None when the app has no name for it."""
    s = ticker.strip().upper()
    if not s:
        return None
    kind = (market or "").lower()
    if s.startswith("X:") or kind == "crypto":
        body = s.removeprefix("X:")
        for quote_currency in _CRYPTO_QUOTES_LONGEST_FIRST:
            if body.endswith(quote_currency) and len(body) > len(quote_currency):
                return f"{body[: -len(quote_currency)]}-{quote_currency}"
        return None
    if s.startswith("C:") or kind == "fx":
        pair = re.fullmatch(r"([A-Z]{3})([A-Z]{3})", s.removeprefix("C:"))
        if not pair or pair[1] not in _FIAT or pair[2] not in _FIAT:
            return None
        return f"{pair[2]}=X" if pair[1] == "USD" else f"{pair[1]}{pair[2]}=X"
    if ":" in s or (kind and kind != "stocks") or (locale and locale.lower() != "us"):
        return None  # indices ("I:SPX"), OTC, other locales
    plain = s.replace(".", "-")
    return plain if _US_SYMBOL.fullmatch(plain) else None


# -- the provider ------------------------------------------------------------------------

#: Which `type` codes of a reference ticker are which canonical type.
_TYPES = {
    "ETF": "etf",
    "ETN": "etf",
    "ETS": "etf",
    "ETV": "etf",
    "FUND": "mutualfund",
    "IX": "index",
}
_QUOTE_TYPES = {"ETF": "ETF", "ETN": "ETF", "ETS": "ETF", "ETV": "ETF", "FUND": "MUTUALFUND"}
_SNAPSHOT_PATHS: dict[str, str] = {
    "us": "/v2/snapshot/locale/us/markets/stocks/tickers",
    "crypto": "/v2/snapshot/locale/global/markets/crypto/tickers",
    "fx": "/v2/snapshot/locale/global/markets/forex/tickers",
}
#: Body `status` values (besides OK and DELAYED, which are data) that are errors.
_BODY_ERRORS = ("NOT_AUTHORIZED", "NOT_FOUND", "ERROR")
_DAILY_SPANS = frozenset({"day", "week", "month"})
#: Calendar days a daily-or-longer request starts before `start`: a weekly or monthly bar
#: is stamped at its first day, which may precede `start` (trimmed after the fetch).
_SPAN_MARGIN = {"day": timedelta(days=1), "week": timedelta(days=7), "month": timedelta(days=31)}
#: Days a plan-limited request starts inside the plan's history horizon (the exact depth of
#: a plan is unverified).
_HORIZON_SAFETY = timedelta(days=3)
_REGULAR_OPEN_MIN = 9 * 60 + 30
_REGULAR_CLOSE_MIN = 16 * 60
_EARLIEST = datetime(2000, 1, 1, tzinfo=UTC)


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _pos(v: Any) -> float | None:
    """A strictly positive number (the snapshot fills absent values with 0), else None."""
    n = _num(v)
    return n if n is not None and n > 0 else None


def _int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def _epoch_s(v: Any) -> int | None:
    """Unix seconds of a timestamp in seconds, milliseconds, microseconds or nanoseconds
    (the snapshot mixes units across asset classes)."""
    n = _pos(v)
    if n is None:
        return None
    for floor, divisor in ((1e17, 1e9), (1e14, 1e6), (1e11, 1e3)):
        if n >= floor:
            return int(n / divisor)
    return int(n)


_DEFAULT_PORTS = {"http": 80, "https": 443}


def _origin(parts: SplitResult) -> tuple[str, str, int] | None:
    """(scheme, host, port) of a URL with the default port filled in, None when it has no
    usable host or port."""
    scheme = parts.scheme.lower()
    try:
        port = parts.port
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if scheme not in _DEFAULT_PORTS or not host:
        return None
    return scheme, host, port if port is not None else _DEFAULT_PORTS[scheme]


def _obj(v: Any) -> Mapping[str, Any]:
    return v if isinstance(v, Mapping) else {}


def _empty_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=BAR_COLUMNS)


def _frame(results: Sequence[Any], tz: str, daily: bool, weekly: bool = False) -> pd.DataFrame:
    """Bars from an aggregates page: `t` is the window start in unix milliseconds. Daily
    and longer bars are stamped at exchange-local midnight of their first day, as every
    provider does (the calendar day of `t` + 12 hours, so a `t` at either the local or the
    UTC midnight lands on the right day). A weekly bar that starts on a Sunday (unverified:
    the week may be counted from Sunday) is stamped on the Monday after it, as Yahoo's are."""
    rows = [r for r in results if isinstance(r, Mapping)]
    if not rows:
        return _empty_frame()
    raw = pd.DataFrame(rows)
    for column in ("t", "o", "h", "l", "c"):
        if column not in raw:
            raise ProviderError(f"{PROVIDER_NAME}: aggregates row lacks {column!r}")
    t = pd.to_numeric(raw["t"], errors="coerce")
    ohlc = {c: pd.to_numeric(raw[k], errors="coerce") for c, k in _OHLC.items()}
    ok = t.notna() & pd.concat(ohlc, axis=1).notna().all(axis=1)
    if not ok.any():
        return _empty_frame()
    millis = t[ok].to_numpy("int64")
    if daily:
        days = pd.to_datetime(millis + 12 * 3600 * 1000, unit="ms").normalize()
        if weekly:
            days = days + pd.to_timedelta((days.dayofweek == 6).astype("int64"), unit="D")
        stamp = days.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
        utc_days = stamp.tz_convert("UTC").tz_localize(None).as_unit("s")
        seconds = np.asarray(utc_days).astype("int64")
        valid = np.asarray(stamp.notna())
        keep = ok.copy()
        keep[ok] = valid
        ok, seconds = keep, seconds[valid]
        if not ok.any():
            return _empty_frame()
    else:
        seconds = millis // 1000
    volume = pd.to_numeric(raw["v"], errors="coerce") if "v" in raw else None
    out = pd.DataFrame(
        {
            "ts": np.asarray(seconds, dtype="int64"),
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


def _regular_only(frame: pd.DataFrame, tz: str) -> pd.DataFrame:
    """Bars that open inside the regular session (9:30 to 16:00 local)."""
    if frame.empty:
        return frame
    local = pd.to_datetime(frame["ts"], unit="s", utc=True).dt.tz_convert(tz)
    minutes = local.dt.hour * 60 + local.dt.minute
    keep = (minutes >= _REGULAR_OPEN_MIN) & (minutes < _REGULAR_CLOSE_MIN)
    return frame[keep.to_numpy()].reset_index(drop=True)


def _market_state(market: str, now: datetime) -> str:
    """REGULAR or CLOSED by the clock (weekday session hours; holidays are not known).
    Crypto and forex count as always open."""
    if market != "us":
        return "REGULAR"
    local = now.astimezone(ZoneInfo(NEW_YORK))
    if local.weekday() >= 5:
        return "CLOSED"
    minutes = local.hour * 60 + local.minute
    return "REGULAR" if _REGULAR_OPEN_MIN <= minutes < _REGULAR_CLOSE_MIN else "CLOSED"


def _type_of(market: str, code: str) -> str | None:
    if market == "crypto":
        return "cryptocurrency"
    if market == "fx":
        return "currency"
    return _TYPES.get(code.upper(), "equity" if code else None)


def _currency(row: Mapping[str, Any]) -> str | None:
    for key in ("currency_symbol", "currency_name"):
        value = row.get(key)
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z]{3}", value):
            return value.upper()
    return None


def _date(moment: datetime, tz: str) -> str:
    return moment.astimezone(ZoneInfo(tz)).strftime("%Y-%m-%d")


def _short(text: str) -> str:
    return text if len(text) <= 200 else text[:200] + "..."


def _status_error(status: int, message: str, symbol: str) -> ProviderError:
    """Map an error answer (HTTP status or body status) to the provider errors."""
    lower = message.lower()
    if status == 401 or (status == 403 and ("api key" in lower or "apikey" in lower)):
        return ProviderNotConfigured("Massive rejected MASSIVE_API_KEY (invalid or not set)")
    if status == 403:
        return ProviderUnsupported("data outside the current Massive plan", PROVIDER_NAME)
    if status == 404:
        return SymbolNotFound(symbol)
    return ProviderError(f"{PROVIDER_NAME}: {_short(message)}")


def _body_message(body: Any, default: str) -> str:
    if isinstance(body, dict):
        for key in ("message", "error"):
            if isinstance(body.get(key), str):
                return str(body[key])
    return default


class MassiveProvider:
    """`MarketDataProvider` over the Massive REST API (stdlib HTTP, key in the
    `Authorization` header)."""

    def __init__(
        self,
        config: MassiveConfig,
        *,
        send: Send | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._profile = effective_profile(config)
        self._caps = capabilities_for(self._profile)
        self._costs = costs_for(self._profile)
        self._clock = clock
        self._base = urlsplit(config.base_url.rstrip("/"))
        # Tickers known to exist (they returned bars or a reference row): an empty page of
        # one of them is a quiet range, not an unknown symbol.
        self._known: set[str] = set()
        self._http = JsonHttp(
            config.base_url,
            send=send,
            headers={"Authorization": f"Bearer {config.api_key.get_secret_value()}"},
            provider="massive",
        )

    # -- transport ----------------------------------------------------------------------

    def _get(self, path: str, params: Mapping[str, str], symbol: str = "") -> Any:
        """GET and unwrap errors (HTTP ones and error `status` bodies)."""
        try:
            body = self._http.get(path, params)
        except HttpRateLimited as exc:
            raise RateLimited(
                f"{PROVIDER_NAME}: request limit of the plan reached", exc.retry_after
            ) from None
        except HttpStatusError as exc:
            raise _status_error(
                exc.status, _body_message(exc.body, f"HTTP {exc.status}"), symbol
            ) from None
        if isinstance(body, dict):
            status = str(body.get("status") or "").upper()
            if status in _BODY_ERRORS:
                code = {"NOT_AUTHORIZED": 403, "NOT_FOUND": 404}.get(status, 0)
                raise _status_error(code, _body_message(body, status), symbol)
        return body

    def _follow(self, url: str) -> tuple[str, dict[str, str]]:
        """Path and parameters of a `next_url`; refused unless it names the origin of
        `base_url` (the request carries the key). An `apiKey` it holds is dropped."""
        parts = urlsplit(url)
        origin = _origin(parts)
        if origin is None or origin != _origin(self._base) or parts.username or parts.password:
            # (the message names the host only: a link may carry credentials)
            raise ProviderError(
                f"{PROVIDER_NAME}: next_url points to {parts.hostname or 'another origin'}, "
                f"not {self._base.hostname}; not followed"
            )
        path, prefix = parts.path, self._base.path.rstrip("/")
        if prefix:
            if not path.startswith(prefix + "/"):
                raise ProviderError(f"{PROVIDER_NAME}: next_url is outside {prefix}; not followed")
            path = path[len(prefix) :]
        params = {
            k: v for k, v in parse_qsl(parts.query, keep_blank_values=True) if k.lower() != "apikey"
        }
        return path, params

    # -- symbols ------------------------------------------------------------------------

    @staticmethod
    def _resolve(symbol: str) -> MassiveSymbol:
        mapped = to_provider(symbol)
        if mapped is None:
            s = symbol.strip().upper()
            if s.endswith("=F"):
                what = "futures"
            elif s.startswith("^"):
                what = "index symbols"
            elif "." in s:
                what = "non-US listings"
            else:
                what = s or "empty symbols"
            raise ProviderUnsupported(what, PROVIDER_NAME)
        return mapped

    @staticmethod
    def _path_ticker(ticker: str) -> str:
        return quote(ticker, safe=":.")

    # -- history ------------------------------------------------------------------------

    _NATIVE: dict[str, tuple[int, str]] = {
        "1m": (1, "minute"),
        "5m": (5, "minute"),
        "15m": (15, "minute"),
        "30m": (30, "minute"),
        "1d": (1, "day"),
        "1wk": (1, "week"),
        "1mo": (1, "month"),
    }
    # Intervals built from a finer one: (source, resample rule, factor, source span).
    _SYNTH: dict[str, tuple[str, Literal["epoch", "session", "quarter"], int, timedelta]] = {
        "2m": ("1m", "epoch", 2, timedelta(minutes=2)),
        "60m": ("30m", "session", 60, timedelta(minutes=60)),
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
        if interval not in self._caps.intervals or source not in self._NATIVE:
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
        frame = self._series(sym, source, fetch_start, end, symbol)
        if sym.market == "us" and not prepost and self._NATIVE[source][1] == "minute":
            frame = _regular_only(frame, sym.timezone)
        if synth:
            frame = resample_bars(frame, synth[1], synth[2], sym.timezone)
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
        sym: MassiveSymbol,
        source: str,
        start: datetime | None,
        end: datetime | None,
        canonical: str,
    ) -> pd.DataFrame:
        """Aggregates of one window, newest page first through `next_url`."""
        multiplier, span = self._NATIVE[source]
        daily = span in _DAILY_SPANS
        now = self._clock()
        low, high = _EARLIEST if start is None else start, end
        if daily:
            low = low - _SPAN_MARGIN[span]  # before the clip: the request never starts earlier
        years = self._profile.history_years
        if years is not None:
            # A few days inside the horizon: asking for older data may be refused outright.
            floor = now - timedelta(days=365.25 * years) + _HORIZON_SAFETY
            if high is not None and high <= floor:
                return _empty_frame()  # wholly before what the plan serves: nothing to ask
            low = max(low, floor)
        high = now + timedelta(days=1) if high is None else high
        if daily:
            from_, to = _date(low, sym.timezone), _date(high, sym.timezone)
        else:
            from_, to = str(int(low.timestamp() * 1000)), str(int(high.timestamp() * 1000))
        path = (
            f"/v2/aggs/ticker/{self._path_ticker(sym.ticker)}/range/{multiplier}/{span}"
            f"/{from_}/{to}"
        )
        params = {"adjusted": "true", "sort": "desc", "limit": str(PAGE_SIZE)}
        pages: list[pd.DataFrame] = []
        body = self._get(path, params, canonical)
        for page in range(MAX_PAGES):
            results = body.get("results") if isinstance(body, dict) else None
            if results is not None and not isinstance(results, list):
                raise ProviderError(f"{PROVIDER_NAME}: unexpected aggregates payload")
            if results:
                pages.append(_frame(results, sym.timezone, daily, span == "week"))
            next_url = body.get("next_url") if isinstance(body, dict) else None
            if not isinstance(next_url, str) or not next_url or not results:
                break
            if page + 1 >= MAX_PAGES:
                log.info("%s: aggregates paging stopped after %d pages", PROVIDER_NAME, MAX_PAGES)
                break
            try:
                next_path, next_params = self._follow(next_url)
            except ProviderError as exc:
                log.warning("%s: aggregates paging stopped: %s", PROVIDER_NAME, exc)
                break  # a refused link: serve the newer pages already fetched
            if not self._pay_for_page():
                break  # out of calls: serve the newer pages already fetched
            try:
                body = self._get(next_path, next_params, canonical)
            except ProviderError as exc:
                # An older page failed (rate limit, outage): the newer bars fetched stand.
                log.warning("%s: aggregates page %d failed: %s", PROVIDER_NAME, page + 2, exc)
                if isinstance(exc, RateLimited):
                    report_usage(minute_left=0)  # the guard must not send the next call at once
                break
        pages = [p for p in pages if not p.empty]
        if not pages:
            self._check_exists(sym, canonical)
            return _empty_frame()
        self._known.add(sym.ticker)
        out = pd.concat(pages, ignore_index=True)
        return out.drop_duplicates("ts", keep="first").sort_values("ts").reset_index(drop=True)

    @staticmethod
    def _pay_for_page() -> bool:
        """Charge the call of a further page. False when the guard's budget cannot pay for
        it (nothing is sent, and the pages already fetched are worth more than an error)."""
        try:
            charge_upstream(1)
        except ProviderError as exc:
            log.info("%s: guard refused a further page: %s", PROVIDER_NAME, exc)
            return False
        return True

    def _check_exists(self, sym: MassiveSymbol, canonical: str) -> None:
        """An aggregates answer without rows does not say whether the ticker exists: ask
        the reference data once (a call), and raise `SymbolNotFound` when it does not. When
        the call cannot be paid for, the empty answer stands."""
        if sym.ticker in self._known:
            return
        try:
            charge_upstream(1)
        except ProviderError as exc:  # RateLimited, or an open breaker (UpstreamUnavailable)
            log.info("%s: no budget to check %s: %s", PROVIDER_NAME, sym.ticker, exc)
            return
        self._details(sym, canonical)

    # -- symbol info and search ---------------------------------------------------------

    def _details(self, sym: MassiveSymbol, canonical: str) -> Mapping[str, Any]:
        """The `/v3/reference/tickers/{T}` row; `SymbolNotFound` when there is none."""
        body = self._get(f"/v3/reference/tickers/{self._path_ticker(sym.ticker)}", {}, canonical)
        row = body.get("results") if isinstance(body, dict) else None
        if not isinstance(row, dict) or not row.get("ticker"):
            raise SymbolNotFound(canonical)
        self._known.add(sym.ticker)
        return row

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        sym = self._resolve(symbol)
        row = self._details(sym, symbol)
        if sym.market == "us":
            listing = by_mic(str(row.get("primary_exchange") or ""))
            tz, session = (
                (listing.timezone, listing.session) if listing else (NEW_YORK, "0930-1600")
            )
        else:
            tz, session = "UTC", "0000-2359"
        hint = 4 if sym.market == "fx" else 2
        exchange = row.get("primary_exchange") or None
        return {
            "symbol": symbol.strip().upper(),
            "name": str(row.get("name") or symbol),
            "exchange": exchange,
            "exchangeName": exchange,
            "type": _type_of(sym.market, str(row.get("type") or "")),
            "currency": _currency(row),
            "timezone": tz,
            "session": session,
            "priceHint": hint,
            "minTick": 10**-hint,
            "hasIntraday": self._profile.intraday,
        }

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        rows_wanted = min(SEARCH_MAX_ROWS, max(SEARCH_MIN_ROWS, limit * 3))
        body = self._get(
            "/v3/reference/tickers",
            {"search": query, "active": "true", "limit": str(rows_wanted)},
        )
        results = body.get("results") if isinstance(body, dict) else None
        if results is None:
            return []  # no match: the answer then holds no `results`
        if not isinstance(results, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected ticker search payload")
        needle = query.strip().upper()
        found: list[tuple[int, str, dict[str, Any]]] = []
        seen: set[str] = set()
        for r in results:
            if not isinstance(r, dict):
                continue
            canonical = from_provider(
                str(r.get("ticker") or ""),
                market=str(r.get("market") or "") or None,
                locale=str(r.get("locale") or "") or None,
            )
            if canonical is None or canonical in seen:
                continue
            seen.add(canonical)
            market = to_provider(canonical)
            kind = str(r.get("type") or "")
            rank = 0 if canonical == needle else 1 if canonical.startswith(needle) else 2
            found.append(
                (
                    rank,
                    canonical,
                    {
                        "symbol": canonical,
                        "name": str(r.get("name") or canonical),
                        "exchange": r.get("primary_exchange") or None,
                        "type": _type_of(market.market if market else "us", kind),
                        "typeDisplay": kind or str(r.get("market") or "") or None,
                    },
                )
            )
        found.sort(key=lambda item: item[0])  # stable: the API's order within a rank
        return [row for _, _, row in found[:limit]]

    # -- symbol routing (see `base.SymbolRouting`) ---------------------------------------

    def billable(self, symbols: list[str]) -> list[str]:
        """The symbols a quote call would send: each once, without those Massive cannot
        serve (answered locally, never worth a call)."""
        out: list[str] = []
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            if to_provider(raw) is not None:
                out.append(raw)
        return out

    def answers_locally(self, op: str, symbol: str) -> bool:
        """Whether `op` for `symbol` is answered without a request: an unsupported symbol,
        or fundamentals of crypto and forex (no company data)."""
        sym = to_provider(symbol)
        if sym is None:
            return True
        return op in ("events", "fundamentals") and sym.market != "us"

    # -- quotes -------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol. With a snapshot (paid plans) one call per
        `QUOTE_BATCH` symbols of a market; without (basic) one call per symbol for the last
        two daily bars, so a quote is the previous session's close. Symbols Massive cannot
        serve are not sent; `ProviderUnsupported` only when none can be."""
        wanted: dict[str, MassiveSymbol] = {}
        unsupported: list[ProviderUnsupported] = []
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            try:
                wanted[raw] = self._resolve(raw)
            except ProviderUnsupported as exc:
                unsupported.append(exc)  # free to know, never worth a call
        if not wanted:
            if unsupported:
                raise unsupported[0]
            return QuoteList()
        now = self._clock()
        rows: list[dict[str, Any]] = []
        refused: ProviderUnsupported | None = None
        answered = False
        if self._profile.snapshot:
            groups = self._groups(wanted)
            requests = sum(math.ceil(len(g) / QUOTE_BATCH) for g in groups.values())
            # The guard charged for one market's worth of batches; mixed markets cost more.
            charge_upstream(requests - self._costs.quotes(len(wanted)))
            for market, by_ticker in groups.items():
                tickers = list(by_ticker)
                for i in range(0, len(tickers), QUOTE_BATCH):
                    chunk = {t: by_ticker[t] for t in tickers[i : i + QUOTE_BATCH]}
                    try:
                        rows.extend(self._snapshot_chunk(market, chunk, now))
                    except ProviderUnsupported as exc:
                        refused = exc  # e.g. no crypto data on this key: the rest still count
                        continue
                    answered = True
        else:
            for canonical, sym in wanted.items():
                try:
                    row = self._daily_quote(canonical, sym, now)
                except ProviderUnsupported as exc:
                    refused = exc
                    continue
                except RateLimited as exc:
                    if not rows:
                        raise  # nothing to serve: the caller learns of the limit
                    # Out of calls midway: serve the rows already priced (the rest is
                    # unknown, not absent: the list is not confirmed).
                    log.info("%s: quotes cut short by a rate limit: %s", PROVIDER_NAME, exc)
                    report_usage(minute_left=0)  # the guard must not send the next call at once
                    return QuoteList(rows, confirmed=False)
                answered = True
                if row is not None:
                    rows.append(row)
        if not answered and refused is not None:
            raise refused
        return QuoteList(rows)

    @staticmethod
    def _groups(wanted: Mapping[str, MassiveSymbol]) -> dict[str, dict[str, list[str]]]:
        """Market -> Massive ticker -> canonical symbols (several may name one ticker:
        USDJPY=X and JPY=X)."""
        out: dict[str, dict[str, list[str]]] = {}
        for canonical, sym in wanted.items():
            out.setdefault(sym.market, {}).setdefault(sym.ticker, []).append(canonical)
        return out

    def _snapshot_chunk(
        self, market: str, chunk: Mapping[str, list[str]], now: datetime
    ) -> list[dict[str, Any]]:
        body = self._get(_SNAPSHOT_PATHS[market], {"tickers": ",".join(chunk)})
        entries = body.get("tickers") if isinstance(body, dict) else None
        if entries is None:
            return []
        if not isinstance(entries, list):
            raise ProviderError(f"{PROVIDER_NAME}: unexpected snapshot payload")
        by_ticker = {k.upper(): v for k, v in chunk.items()}
        rows: list[dict[str, Any]] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            for canonical in by_ticker.get(str(entry.get("ticker") or "").upper(), []):
                row = _snapshot_row(canonical, entry, market, now)
                if row is not None:
                    rows.append(row)
        return rows

    def _daily_quote(
        self, canonical: str, sym: MassiveSymbol, now: datetime
    ) -> dict[str, Any] | None:
        """Quote from the last two daily bars (end-of-day plans have no snapshot)."""
        low = now - timedelta(days=QUOTE_LOOKBACK_DAYS)
        path = (
            f"/v2/aggs/ticker/{self._path_ticker(sym.ticker)}/range/1/day"
            f"/{_date(low, sym.timezone)}/{_date(now + timedelta(days=1), sym.timezone)}"
        )
        try:
            body = self._get(path, {"adjusted": "true", "sort": "desc", "limit": "2"}, canonical)
        except SymbolNotFound:
            return None
        results = body.get("results") if isinstance(body, dict) else None
        if not isinstance(results, list) or not results or not isinstance(results[0], dict):
            return None
        bar = results[0]
        last = _num(bar.get("c"))
        if last is None:
            return None
        prev = results[1] if len(results) > 1 and isinstance(results[1], dict) else {}
        prev_close = _num(prev.get("c"))
        row: dict[str, Any] = {
            "symbol": canonical,
            "last": last,
            "prevClose": prev_close,
            "volume": _int(bar.get("v")),
            "currency": "USD" if sym.market == "us" else None,
            "marketState": "CLOSED",
            "time": _epoch_s(bar.get("t")),
        }
        row.update(_change(last, prev_close))
        for key, field in (("open", "o"), ("dayHigh", "h"), ("dayLow", "l")):
            value = _pos(bar.get(field))
            if value is not None:
                row[key] = value
        return row

    # -- events, news, fundamentals -----------------------------------------------------

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise ProviderUnsupported("extended-hours quotes", PROVIDER_NAME)

    def events(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("events", PROVIDER_NAME)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise ProviderUnsupported("news", PROVIDER_NAME)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        """Company reference data only (`/v3/reference/tickers/{T}`, one call): no
        statements, no ratios."""
        sym = self._resolve(symbol)
        if sym.market != "us":
            return {"info": {}}
        row = self._details(sym, symbol)
        code = str(row.get("type") or "").upper()
        sic = row.get("sic_description")
        info: dict[str, Any] = {
            "longName": row.get("name"),
            "quoteType": _QUOTE_TYPES.get(code, "EQUITY" if code else None),
            "currency": _currency(row),
            "exchange": row.get("primary_exchange"),
            "marketCap": _pos(row.get("market_cap")),
            "sharesOutstanding": _pos(row.get("weighted_shares_outstanding"))
            or _pos(row.get("share_class_shares_outstanding")),
            "industry": sic.title() if isinstance(sic, str) else None,
            "website": row.get("homepage_url"),
            "fullTimeEmployees": _int(row.get("total_employees")),
            "longBusinessSummary": row.get("description"),
        }
        return {
            "info": {
                k: v
                for k, v in info.items()
                if k in FUNDAMENTALS_INFO_KEYS and v is not None and v != ""
            }
        }


# -- quote rows --------------------------------------------------------------------------


def _change(last: float, prev_close: float | None) -> dict[str, float | None]:
    if prev_close is None or prev_close == 0:
        return {"change": None, "changePercent": None}
    change = last - prev_close
    return {"change": round(change, 6), "changePercent": round(change / prev_close * 100, 6)}


def _snapshot_row(
    canonical: str, t: Mapping[str, Any], market: str, now: datetime
) -> dict[str, Any] | None:
    """A quote from a snapshot entry. The price is the last trade, else the last minute
    bar, else the day's close (the snapshot holds 0 for what has not happened yet), else
    the previous close."""
    trade, minute = _obj(t.get("lastTrade")), _obj(t.get("min"))
    day, prev = _obj(t.get("day")), _obj(t.get("prevDay"))
    prev_close = _pos(prev.get("c"))
    last: float | None = None
    when: int | None = None
    for price, stamp in (
        (trade.get("p"), trade.get("t")),
        (minute.get("c"), minute.get("t")),
        (day.get("c"), t.get("updated")),
    ):
        last = _pos(price)
        if last is not None:
            when = _epoch_s(stamp)
            break
    if last is None:
        last, when = prev_close, _epoch_s(prev.get("t"))
    if last is None:
        return None
    row: dict[str, Any] = {
        "symbol": canonical,
        "last": last,
        "prevClose": prev_close,
        "volume": _int(day.get("v")) if _pos(day.get("v")) is not None else None,
        "currency": "USD" if market == "us" else None,
        "marketState": _market_state(market, now),
        "time": when,
    }
    row.update(_change(last, prev_close))
    if row["change"] is None:
        row["change"] = _num(t.get("todaysChange"))
        row["changePercent"] = _num(t.get("todaysChangePerc"))
    for key, field in (("open", "o"), ("dayHigh", "h"), ("dayLow", "l")):
        value = _pos(day.get(field))
        if value is not None:
            row[key] = value
    return row
