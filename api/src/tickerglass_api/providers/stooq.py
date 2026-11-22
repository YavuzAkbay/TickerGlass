"""Stooq (stooq.com) as a `MarketDataProvider`: unofficial, free, daily-and-longer history for
US, UK, German and Japanese stocks, some indices, FX and crypto, served as CSV.

Terms and shape (docs/design/more-providers.md section 5): since about March 2026 every request
carries an `apikey` query parameter, obtained by hand from a captcha page
(`https://stooq.com/q/d/?s=aapl.us&get_apikey`). The key is in the URL, so it is redacted
(`apikey=***`) from every message this module raises or logs, and never reaches a metrics
label (`JsonHttp(provider="stooq")` counts by the fixed id only; its own errors name host and
path, never the query).

The body is judged before it is parsed, because Stooq answers 200 to everything:

- "Exceeded the daily hits limit" -> `RateLimited(daily=True)`;
- an HTML page instead of CSV (missing or expired key) -> `ProviderNotConfigured`;
- "No data" -> an empty frame (`SymbolNotFound` when the whole history is empty, which is how an
  unknown symbol answers; `history` of a range without bars probes once, see `_confirm`).

Only 1d, 1wk and 1mo are served. `adj_close` equals `close`: Stooq is believed to adjust for
splits but not dividends. There is no search, no news, no events, no fundamentals.

Unverified (guesses; the first live call must confirm them, the code degrades to clear errors):

- the `apikey` query parameter name on `/q/d/l/` and `/q/l/`, and that `/q/l/` takes one at all
  (when it does not answer CSV, `quotes` falls back to the last two daily bars per symbol);
- the quote CSV: header `Symbol,Date,Time,Open,High,Low,Close,Volume`, `N/D` cells for unknown
  symbols, symbols echoed upper case, and its `Date` / `Time` being Europe/Warsaw time;
- the empty `h=` for the documented valueless `h` flag, and `+` between symbols in `s=`;
- the exact text of the limit and key-missing answers (matched loosely, case-insensitively);
- that "No data" is the whole body for an unknown symbol and for an empty range alike;
- that the daily limit resets at 00:00 UTC (it is the guard's day; Stooq may differ);
- weekly and monthly bars being dated on the period's last trading day (they are stamped on
  that week's Monday / the 1st of the month), and `Volume` being absent for some indices
  (then 0);
- the symbol names of `class shares` (`brk-b.us`), the index table (`^ndq`, `^ndx`, `^ftm`,
  `^dax`, `^nkx`, `^hsi`), `usdjpy` for Yahoo's `JPY=X`, and crypto pairs `btcusd`/`btceur`/
  `btcgbp`;
- that UK prices are in pence (currency `GBp`) and the free daily/hit quota (the defaults of
  10 per minute, burst 5, 300 per day are conservative guesses).
"""

import csv
import io
import logging
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo

import pandas as pd
from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .base import (
    BAR_COLUMNS,
    Budget,
    Capabilities,
    CostModel,
    ProviderError,
    ProviderNotConfigured,
    ProviderUnsupported,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    charge_upstream,
)
from .exchanges import Exchange, by_mic, split_symbol
from .http import HttpRateLimited, HttpStatusError, JsonHttp, Send, require_https

log = logging.getLogger(__name__)

PROVIDER_ID = "stooq"
PROVIDER_NAME = "Stooq"
BASE_URL = "https://stooq.com"
KEY_URL = "https://stooq.com/q/d/?s=aapl.us&get_apikey"
#: Symbols per quote request (kept well under URL length limits).
QUOTE_BATCH = 50
#: Calendar days of daily bars the quote fallback reads (covers holidays and weekends).
FALLBACK_DAYS = 10
#: How long a failed `/q/l/` (key refused, unexpected header) is not tried again; quotes
#: come from daily bars meanwhile.
QUOTE_ENDPOINT_RETRY = timedelta(hours=6)
#: Stooq's own clock, which stamps the quote rows (unverified).
QUOTE_TZ = "Europe/Warsaw"
#: Request budget: unknown quota, so conservative (per minute, burst, per day).
BUDGET = Budget(rate_per_min=10, burst=5, daily=300)

#: Canonical interval -> Stooq `i=` value.
_INTERVALS = {"1d": "d", "1wk": "w", "1mo": "m"}
INTERVALS = frozenset(_INTERVALS)
#: Stooq `i=` value -> pandas period whose start stamps the bar (weeks run Monday to Sunday).
_PERIOD_FREQ = {"w": "W", "m": "M"}

_KEY_MISSING = (
    f"{PROVIDER_NAME} key missing or expired: get a new one at {KEY_URL} "
    "and set STOOQ_API_KEY to the key in the CSV download link on that page"
)
_NOT_CSV = f"{PROVIDER_NAME}: the answer is not the expected CSV"


class StooqConfig(BaseSettings):
    """`STOOQ_*` settings."""

    model_config = SettingsConfigDict(
        env_prefix="STOOQ_", env_file=".env", extra="ignore", env_ignore_empty=True
    )

    api_key: SecretStr = Field(title="API key")
    base_url: str = Field(default=BASE_URL, title="Base URL")

    @field_validator("base_url")
    @classmethod
    def _https_only(cls, value: str) -> str:
        """The key travels in the query of requests to this URL: https, or http for a local
        host."""
        return require_https(value, "STOOQ_BASE_URL")


def capabilities() -> Capabilities:
    return Capabilities(
        intervals=INTERVALS,
        extended_history=False,
        extended_quotes=False,
        adjusted_close=False,
        search=False,
        events=frozenset(),
        news=False,
        fundamentals_info=False,
        fundamentals_statements=False,
        streaming=False,
        markets=frozenset({"us", "intl", "fx", "crypto", "index"}),
    )


def costs() -> CostModel:
    """One request per history or quote batch, plus one for a `symbol_info` existence probe;
    nothing else is served."""
    return CostModel(
        history=1,
        symbol_info=1,
        search=0,
        quote_batch=QUOTE_BATCH,
        quote_per_request=1,
        quote_per_symbol=0,
        events=0,
        news=0,
        fundamentals=0,
    )


def setting_defaults() -> dict[str, Any]:
    """The conservative budget, and TTLs long enough that the cache stands in for requests."""
    return {
        "upstream_rate_per_min": float(BUDGET.rate_per_min),
        "upstream_burst": BUDGET.burst,
        "upstream_daily_limit": BUDGET.daily,
        "quote_ttl_s": 300.0,
        "quote_closed_ttl_s": 86400.0,
        "live_poll_interval_s": 300.0,
        "live_poll_closed_interval_s": 3600.0,
        "bars_tail_ttl_intraday_s": 3600.0,
        "bars_tail_ttl_daily_s": 3600.0,
        "search_ttl_s": 7 * 86400.0,
        "symbol_info_ttl_s": 7 * 86400.0,
        "cache_negative_ttl_s": 6 * 3600.0,
        "quote_negative_ttl_s": 1800.0,
    }


# -- symbols -----------------------------------------------------------------------------

Market = Literal["us", "intl", "fx", "crypto", "index"]


@dataclass(frozen=True)
class StooqSymbol:
    """A canonical symbol as Stooq names it."""

    #: Lower-case Stooq symbol (`aapl.us`).
    symbol: str
    market: Market
    #: IANA time zone daily bars are dated in.
    timezone: str
    #: Regular session "HHMM-HHMM" in `timezone`.
    session: str
    currency: str | None
    type: str


#: Yahoo index -> (Stooq symbol, exchange MIC whose zone and session apply).
_INDICES: dict[str, tuple[str, str]] = {
    "^GSPC": ("^spx", "XNYS"),
    "^DJI": ("^dji", "XNYS"),
    "^IXIC": ("^ndq", "XNYS"),
    "^NDX": ("^ndx", "XNYS"),
    "^FTSE": ("^ftm", "XLON"),
    "^GDAXI": ("^dax", "XETR"),
    "^N225": ("^nkx", "XTKS"),
    "^HSI": ("^hsi", "XHKG"),
}
_INDEX_BY_STOOQ = {stooq: yahoo for yahoo, (stooq, _) in _INDICES.items()}
#: Exchange MIC -> Stooq market suffix and the currency prices are quoted in.
_MARKETS: dict[str, tuple[str, str]] = {
    "XNYS": ("us", "USD"),
    "XLON": ("uk", "GBp"),
    "XETR": ("de", "EUR"),
    "XTKS": ("jp", "JPY"),
}
_MIC_BY_SUFFIX = {suffix: mic for mic, (suffix, _) in _MARKETS.items()}
_FIAT = frozenset(
    {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK"}
    | {"PLN", "CZK", "HUF", "TRY", "MXN", "ZAR", "BRL", "CNY", "HKD", "SGD"}
)
_CRYPTO_QUOTES = frozenset({"USD", "EUR", "GBP"})
#: Quote currencies of a `BASE-QUOTE` symbol that Stooq has no crypto pair for (other fiat,
#: stablecoins, BTC and ETH): such a symbol is a crypto pair, never a US ticker.
_UNSERVED_QUOTES = (_FIAT - _CRYPTO_QUOTES) | {"USDT", "USDC", "BTC", "ETH"}
_FX_PAIR = re.compile(r"([A-Z]{3})([A-Z]{3})=X")
_FX_USD = re.compile(r"([A-Z]{3})=X")  # Yahoo: "JPY=X" is USD/JPY
_CRYPTO_PAIR = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3})")
_PAIR_SHAPE = re.compile(r"([A-Z0-9]{2,10})-([A-Z]{3,4})")
#: A bare six-letter fiat pair ("EURUSD"): the canonical name is "EURUSD=X".
_BARE_FX = re.compile(r"([A-Z]{3})([A-Z]{3})")
_TICKER = re.compile(r"[A-Z0-9][A-Z0-9-]{0,14}")


def _exchange(mic: str) -> Exchange:
    found = by_mic(mic)
    assert found is not None, mic  # the tables above only name MICs of exchanges.py
    return found


def to_provider(symbol: str) -> StooqSymbol | None:
    """Stooq's name for a canonical symbol, or None when it has none (futures, indices
    outside the small table, listings on exchanges Stooq is not asked about)."""
    s = symbol.strip().upper()
    if not s or s.endswith("=F"):
        return None
    if s.startswith("^"):
        known = _INDICES.get(s)
        if known is None:
            return None
        ex = _exchange(known[1])
        return StooqSymbol(known[0], "index", ex.timezone, ex.session, None, "index")
    if s.endswith("=X"):
        pair, usd = _FX_PAIR.fullmatch(s), _FX_USD.fullmatch(s)
        if pair and pair[1] != pair[2]:
            code, quote = f"{pair[1]}{pair[2]}", pair[2]
        elif usd and usd[1] != "USD":
            code, quote = f"USD{usd[1]}", usd[1]
        else:
            return None
        return StooqSymbol(code.lower(), "fx", "UTC", "0000-2359", quote, "currency")
    crypto = _CRYPTO_PAIR.fullmatch(s)
    if crypto and crypto[2] in _CRYPTO_QUOTES:
        return StooqSymbol(
            f"{crypto[1]}{crypto[2]}".lower(),
            "crypto",
            "UTC",
            "0000-2359",
            crypto[2],
            "cryptocurrency",
        )
    shape = _PAIR_SHAPE.fullmatch(s)
    if shape and shape[2] in _UNSERVED_QUOTES:
        return None  # BTC-USDT, ETH-BTC, BTC-JPY...: not served, and not a US ticker either
    bare = _BARE_FX.fullmatch(s)
    if bare and bare[1] in _FIAT and bare[2] in _FIAT:
        return None  # "EURUSD" without "=X": not a ticker
    base, exchange = split_symbol(s)
    if exchange is not None:
        market = _MARKETS.get(exchange.mic)
        if market is None or not _TICKER.fullmatch(base):
            return None
        return StooqSymbol(
            f"{base.lower()}.{market[0]}",
            "intl",
            exchange.timezone,
            exchange.session,
            market[1],
            "equity",
        )
    if "." in s or not _TICKER.fullmatch(s):
        return None  # an unknown suffix: not a US ticker (class shares are written BRK-B)
    us = _exchange("XNYS")
    return StooqSymbol(f"{s.lower()}.us", "us", us.timezone, us.session, "USD", "equity")


def from_provider(symbol: str) -> str | None:
    """The canonical symbol of a Stooq symbol, or None when the app has no name for it."""
    s = symbol.strip().lower()
    if not s:
        return None
    if s.startswith("^"):
        return _INDEX_BY_STOOQ.get(s)
    base, dot, suffix = s.rpartition(".")
    if dot:
        mic = _MIC_BY_SUFFIX.get(suffix)
        if mic is None or not base:
            return None
        return base.upper() + _exchange(mic).yahoo_suffix
    if len(s) == 6 and s[:3].upper() in _FIAT and s[3:].upper() in _FIAT:
        base_ccy, quote_ccy = s[:3].upper(), s[3:].upper()
        return f"{quote_ccy}=X" if base_ccy == "USD" else f"{base_ccy}{quote_ccy}=X"
    if len(s) > 3 and s[-3:].upper() in _CRYPTO_QUOTES:
        return f"{s[:-3].upper()}-{s[-3:].upper()}"
    return None


# -- helpers -----------------------------------------------------------------------------

_APIKEY = re.compile(r"(?i)(apikey=)[^&\s\"'<>]*")
_LIMIT_TEXT = "exceeded the daily hits limit"


def redact(text: str, secret: str = "") -> str:
    """`text` with the `apikey=` parameter of any URL in it, and the key itself, hidden."""
    out = _APIKEY.sub(r"\1***", text)
    return out.replace(secret, "***") if len(secret) >= 4 else out


class _NoData(ProviderError):
    """Stooq's "No data" answer: an unknown symbol, or a range without bars."""


def _seconds_to_midnight(now: datetime) -> int:
    midnight = datetime(now.year, now.month, now.day, tzinfo=UTC) + timedelta(days=1)
    return max(1, int((midnight - now).total_seconds()))


def _looks_html(text: str) -> bool:
    """Markup instead of CSV. Stooq's error pages are not always whole documents (its 404 page
    starts with `<meta>`), and no CSV starts with `<`."""
    head = text[:2048].lstrip().lower()
    return head.startswith("<") or "<html" in head or "<body" in head


def _body_outcome(text: str) -> str | None:
    """How a 200 answer counts in `tickerglass_provider_requests_total` when its body is an
    error (Stooq answers 200 to everything): the daily limit is `rate_limited`, a page instead
    of CSV (a missing or expired key) is `error`; None for data and "No data"."""
    if _LIMIT_TEXT in text.lower():
        return "rate_limited"
    return "error" if _looks_html(text) else None


def _empty_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=BAR_COLUMNS)


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _bars(text: str, tz: str, code: str = "d") -> pd.DataFrame:
    """Bars from a `/q/d/l/` CSV (`Date,Open,High,Low,Close,Volume`) of interval `code`
    (`d`, `w`, `m`); daily and longer bars are stamped at exchange-local midnight, as every
    provider does. Stooq dates a weekly or monthly bar on the period's last trading day
    (unverified); it is stamped on the period's first day (that week's Monday, the 1st), as
    the other providers do."""
    try:
        raw = pd.read_csv(io.StringIO(text), dtype=str, keep_default_na=False)
    except (pd.errors.ParserError, pd.errors.EmptyDataError, ValueError):
        raise ProviderError(_NOT_CSV) from None
    raw.columns = [str(c).strip().lower() for c in raw.columns]
    for column in ("date", "open", "high", "low", "close"):
        if column not in raw:
            if "apikey" in text.lower():
                raise ProviderNotConfigured(_KEY_MISSING)
            raise ProviderError(_NOT_CSV)
    if raw.empty:
        return _empty_frame()
    day = pd.to_datetime(raw["date"].str.strip(), format="%Y-%m-%d", errors="coerce")
    if code in _PERIOD_FREQ:
        day = day.dt.to_period(_PERIOD_FREQ[code]).dt.start_time
    stamp = day.dt.tz_localize(tz, ambiguous="NaT", nonexistent="shift_forward")
    ohlc = {c: pd.to_numeric(raw[c], errors="coerce") for c in ("open", "high", "low", "close")}
    ok = stamp.notna() & pd.concat(ohlc, axis=1).notna().all(axis=1)
    if not ok.any():
        return _empty_frame()
    volume = pd.to_numeric(raw["volume"], errors="coerce") if "volume" in raw else None
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
    out = out[BAR_COLUMNS].drop_duplicates("ts", keep="last")
    return out.sort_values("ts").reset_index(drop=True)


# -- the provider ------------------------------------------------------------------------


class StooqProvider:
    """`MarketDataProvider` over Stooq's CSV downloads (stdlib HTTP, key in the query)."""

    def __init__(
        self,
        config: StooqConfig,
        *,
        send: Send | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._key = config.api_key.get_secret_value()
        self._clock = clock
        # Stooq symbols seen to have data: an empty range for one of them is just empty.
        self._known: set[str] = set()
        # When a `/q/l/` that failed may be tried again (None: it is tried).
        self._quote_retry_at: datetime | None = None
        self._http = JsonHttp(config.base_url, send=send, provider=PROVIDER_ID)

    # -- transport ----------------------------------------------------------------------

    def _redact(self, text: str) -> str:
        return redact(text, self._key)

    def _csv(self, path: str, params: Mapping[str, str]) -> str:
        """GET a CSV with the key attached. Raises `_NoData` for "No data", and the provider
        errors for everything else that is not CSV; nothing raised carries the key."""
        try:
            return self._csv_checked(path, {**params, "apikey": self._key})
        except ProviderError as exc:
            exc.args = tuple(self._redact(a) if isinstance(a, str) else a for a in exc.args)
            if isinstance(exc, HttpStatusError | HttpRateLimited) and isinstance(exc.body, str):
                exc.body = self._redact(exc.body)  # an error page may echo the request URL
            raise

    def _csv_checked(self, path: str, params: Mapping[str, str]) -> str:
        try:
            text = self._http.get_text(path, params, classify=_body_outcome)
        except HttpRateLimited as exc:
            self._sniff(str(exc.body or ""), retry_after=exc.retry_after)
            raise
        except HttpStatusError as exc:
            self._sniff(str(exc.body or ""))
            if exc.status in (401, 403):
                raise ProviderNotConfigured(_KEY_MISSING) from None
            if exc.status == 404:
                raise _NoData(f"{PROVIDER_NAME}: no data") from None
            raise
        self._sniff(text)
        return text

    def _sniff(self, text: str, *, retry_after: int | None = None) -> None:
        """Raise what a non-CSV body says: the daily limit, a missing key, no data."""
        lower = text.lower()
        if _LIMIT_TEXT in lower:
            raise RateLimited(
                f"{PROVIDER_NAME}: daily hits limit exceeded",
                _seconds_to_midnight(self._clock()),
                daily=True,
            )
        if retry_after is not None:
            return  # a plain 429; the caller re-raises it
        if _looks_html(text):
            raise ProviderNotConfigured(_KEY_MISSING)
        stripped = lower.strip()
        if stripped.startswith("no data") and len(stripped) < 64:
            raise _NoData(f"{PROVIDER_NAME}: no data")

    # -- symbols ------------------------------------------------------------------------

    def _resolve(self, symbol: str) -> StooqSymbol:
        mapped = to_provider(symbol)
        if mapped is None:
            s = symbol.strip().upper()
            what = "futures" if s.endswith("=F") else "index symbols" if s.startswith("^") else s
            raise ProviderUnsupported(what, PROVIDER_NAME)
        return mapped

    def _confirm(self, sym: StooqSymbol, canonical: str) -> None:
        """Tell an unknown symbol from an empty range ("No data" answers both): ask for its
        monthly history, whole. Raises `SymbolNotFound` when that is empty too. Without budget
        for the probe the symbol is given the benefit of the doubt."""
        if sym.symbol in self._known:
            return
        try:
            charge_upstream(1)
        except ProviderError as exc:
            log.info("%s: no budget to confirm %s: %s", PROVIDER_NAME, sym.symbol, exc)
            return
        try:
            text = self._csv("/q/d/l/", {"s": sym.symbol, "i": "m"})
        except _NoData:
            raise SymbolNotFound(canonical) from None
        if not _bars(text, sym.timezone).empty:
            self._known.add(sym.symbol)

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
        code = _INTERVALS.get(interval)
        if code is None:
            raise ProviderUnsupported(f"{interval} bars", PROVIDER_NAME)
        params = {"s": sym.symbol, "i": code}
        zone = ZoneInfo(sym.timezone)
        if start is not None or end is not None:
            first = start.astimezone(zone) if start is not None else None
            last = (end or self._clock() + timedelta(days=1)).astimezone(zone)
            params["d1"] = first.strftime("%Y%m%d") if first else "19700101"
            params["d2"] = last.strftime("%Y%m%d")
        try:
            text = self._csv("/q/d/l/", params)
        except _NoData:
            if start is None and end is None:
                raise SymbolNotFound(symbol.strip().upper()) from None
            self._confirm(sym, symbol.strip().upper())
            return _empty_frame()
        frame = _bars(text, sym.timezone, code)
        if frame.empty:
            return frame
        self._known.add(sym.symbol)
        mask = pd.Series(True, index=frame.index)
        if start is not None:
            mask &= frame["ts"] >= int(start.timestamp())
        if end is not None:
            mask &= frame["ts"] < int(end.timestamp())
        return frame[mask].reset_index(drop=True)

    # -- symbol info and search ---------------------------------------------------------

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        """Minimal facts from the mapping; one request (the monthly history) tells whether
        Stooq knows the symbol, unless it already served bars of it."""
        sym = self._resolve(symbol)
        canonical = symbol.strip().upper()
        if sym.symbol not in self._known:
            try:
                text = self._csv("/q/d/l/", {"s": sym.symbol, "i": "m"})
            except _NoData:
                raise SymbolNotFound(canonical) from None
            if not _bars(text, sym.timezone).empty:
                self._known.add(sym.symbol)
        hint = 4 if sym.market == "fx" else 2
        return {
            "symbol": canonical,
            "name": canonical,
            "exchange": None,
            "exchangeName": None,
            "type": sym.type,
            "currency": sym.currency,
            "timezone": sym.timezone,
            "session": sym.session,
            "priceHint": hint,
            "minTick": 10**-hint,
            "hasIntraday": False,
        }

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        return []  # Stooq has no symbol search

    # -- symbol routing (see `base.SymbolRouting`) ---------------------------------------

    def billable(self, symbols: list[str]) -> list[str]:
        """The symbols a quote call would send: each once, without those Stooq has no name
        for (answered locally)."""
        out: list[str] = []
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            if to_provider(raw) is not None:
                out.append(raw)
        return out

    def answers_locally(self, op: str, symbol: str) -> bool:
        """Events, fundamentals and news are never served; other ops are answered locally
        only for symbols without a Stooq name."""
        return op in ("events", "fundamentals", "news") or to_provider(symbol) is None

    # -- quotes -------------------------------------------------------------------------

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol (the last daily bar's session so far). `confirmed`
        when Stooq answered for every symbol; `prevClose` and `change` are not in the quote
        CSV and stay None unless the daily-bar fallback served it. `ProviderUnsupported`
        only when no symbol has a Stooq name."""
        wanted: dict[str, StooqSymbol] = {}
        unsupported: list[ProviderUnsupported] = []
        for raw in dict.fromkeys(s.strip().upper() for s in symbols):
            try:
                wanted[raw] = self._resolve(raw)
            except ProviderUnsupported as exc:
                unsupported.append(exc)
        if not wanted:
            if unsupported:
                raise unsupported[0]
            return QuoteList(confirmed=True)
        by_key: dict[str, list[str]] = {}
        for canonical, mapped in wanted.items():
            by_key.setdefault(mapped.symbol, []).append(canonical)
        keys = list(by_key)
        rows: list[dict[str, Any]] = []
        confirmed = True
        for i in range(0, len(keys), QUOTE_BATCH):
            chunk = keys[i : i + QUOTE_BATCH]
            found, answered = self._quote_chunk(chunk, by_key, wanted)
            rows.extend(found)
            confirmed = confirmed and answered
        return QuoteList(rows, confirmed=confirmed)

    def _quote_chunk(
        self,
        keys: list[str],
        canonical: Mapping[str, list[str]],
        mapped: Mapping[str, StooqSymbol],
    ) -> tuple[list[dict[str, Any]], bool]:
        if self._quote_retry_at is not None:
            if self._clock() < self._quote_retry_at:
                # `/q/l/` failed lately: no request for it. The call's charge pays for the
                # first daily-bars request instead.
                return self._quote_fallback(keys, canonical, mapped, prepaid=True)
            self._quote_retry_at = None
        params = {"s": " ".join(keys), "f": "sd2t2ohlcv", "h": "", "e": "csv"}
        try:
            text = self._csv("/q/l/", params)
        except _NoData:
            return [], True  # Stooq answered: none of them exists
        except ProviderNotConfigured:
            # The quote endpoint may not take the key (unverified): the daily bars do.
            return self._quote_fallback_after_failure(keys, canonical, mapped)
        reader = csv.DictReader(io.StringIO(text))
        fields = {str(f).strip().lower() for f in reader.fieldnames or []}
        if not {"symbol", "close"} <= fields:
            log.warning("%s: unexpected quote CSV header, using daily bars", PROVIDER_NAME)
            return self._quote_fallback_after_failure(keys, canonical, mapped)
        seen: set[str] = set()
        rows: list[dict[str, Any]] = []
        now = self._clock()
        for record in reader:
            cells = {str(k).strip().lower(): (v or "").strip() for k, v in record.items() if k}
            key = cells.get("symbol", "").lower()
            if key not in canonical or key in seen:
                continue
            seen.add(key)
            last = _num(cells.get("close"))
            if last is None:  # "N/D": Stooq does not know the symbol
                continue
            for name in canonical[key]:
                when = self._quote_time(cells)
                rows.append(_quote_row(name, mapped[name], last, cells, when, now))
        return rows, seen >= set(keys)

    @staticmethod
    def _quote_time(cells: Mapping[str, str]) -> int | None:
        try:
            moment = datetime.strptime(
                f"{cells.get('date', '')} {cells.get('time', '')}", "%Y-%m-%d %H:%M:%S"
            )
        except ValueError:
            return None
        return int(moment.replace(tzinfo=ZoneInfo(QUOTE_TZ)).timestamp())

    def _quote_fallback_after_failure(
        self,
        keys: list[str],
        canonical: Mapping[str, list[str]],
        mapped: Mapping[str, StooqSymbol],
    ) -> tuple[list[dict[str, Any]], bool]:
        """The daily-bars quotes after a failed `/q/l/` request (which used the call's
        charge, so every fallback request is charged), remembering the failure so that the
        next calls skip `/q/l/` for `QUOTE_ENDPOINT_RETRY`."""
        self._quote_retry_at = self._clock() + QUOTE_ENDPOINT_RETRY
        try:
            return self._quote_fallback(keys, canonical, mapped, prepaid=False)
        except ProviderNotConfigured:
            self._quote_retry_at = None  # the key itself is refused: nothing learnt of `/q/l/`
            raise

    def _quote_fallback(
        self,
        keys: list[str],
        canonical: Mapping[str, list[str]],
        mapped: Mapping[str, StooqSymbol],
        *,
        prepaid: bool,
    ) -> tuple[list[dict[str, Any]], bool]:
        """Quotes from the last two daily bars of each symbol, one request each, every one
        charged to the guard (stops when it refuses) except the first when `prepaid`: the
        call's own charge, for a `/q/l/` request that was never sent."""
        today = self._clock()
        rows: list[dict[str, Any]] = []
        answered = True
        for n, key in enumerate(keys):
            sym = mapped[canonical[key][0]]
            if n or not prepaid:
                try:
                    charge_upstream(1)
                except ProviderError as exc:
                    log.info("%s: guard refused a further quote request: %s", PROVIDER_NAME, exc)
                    answered = False
                    break
            params = {
                "s": key,
                "i": "d",
                "d1": (today - timedelta(days=FALLBACK_DAYS)).strftime("%Y%m%d"),
                "d2": (today + timedelta(days=1)).strftime("%Y%m%d"),
            }
            try:
                bars = _bars(self._csv("/q/d/l/", params), sym.timezone)
            except _NoData:
                answered = False  # unknown, or no bars in ten days: not proof of absence
                continue
            if bars.empty:
                answered = False
                continue
            last = bars.iloc[-1]
            prev = float(bars.iloc[-2]["close"]) if len(bars) > 1 else None
            for name in canonical[key]:
                row = _quote_row(name, sym, float(last["close"]), {}, int(last["ts"]), today)
                row.update(
                    open=float(last["open"]),
                    dayHigh=float(last["high"]),
                    dayLow=float(last["low"]),
                    volume=int(last["volume"]),
                )
                if prev:
                    row.update(
                        prevClose=prev,
                        change=float(last["close"]) - prev,
                        changePercent=(float(last["close"]) - prev) / prev * 100,
                    )
                rows.append(row)
        return rows, answered

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        raise ProviderUnsupported("extended-hours quotes", PROVIDER_NAME)

    # -- not served ---------------------------------------------------------------------

    def events(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("events", PROVIDER_NAME)

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        raise ProviderUnsupported("news", PROVIDER_NAME)

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        raise ProviderUnsupported("fundamentals", PROVIDER_NAME)


def _market_state(sym: StooqSymbol, now: datetime, when: int | None) -> str:
    """REGULAR or CLOSED from the exchange clock (Stooq does not say): inside the symbol's
    weekday session, and the quote is from today (holidays are not known, but a quote of an
    earlier day shows no session today). FX and crypto count as always open."""
    if sym.market in ("fx", "crypto"):
        return "REGULAR"
    zone = ZoneInfo(sym.timezone)
    local = now.astimezone(zone)
    if local.weekday() >= 5:
        return "CLOSED"
    opens, _, closes = sym.session.partition("-")
    minutes = local.hour * 60 + local.minute
    if not int(opens[:2]) * 60 + int(opens[2:]) <= minutes < int(closes[:2]) * 60 + int(closes[2:]):
        return "CLOSED"
    if when is not None and datetime.fromtimestamp(when, zone).date() != local.date():
        return "CLOSED"
    return "REGULAR"


def _quote_row(
    canonical: str,
    sym: StooqSymbol,
    last: float,
    cells: Mapping[str, str],
    when: int | None,
    now: datetime,
) -> dict[str, Any]:
    volume = _num(cells.get("volume"))
    return {
        "symbol": canonical,
        "last": last,
        "prevClose": None,
        "change": None,
        "changePercent": None,
        "volume": int(volume) if volume is not None else None,
        "currency": sym.currency,
        "marketState": _market_state(sym, now, when),
        "time": when,
        "open": _num(cells.get("open")),
        "dayHigh": _num(cells.get("high")),
        "dayLow": _num(cells.get("low")),
    }
