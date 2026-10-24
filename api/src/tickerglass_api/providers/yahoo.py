"""The only module that talks to Yahoo Finance. Everything else uses MarketDataProvider."""

import logging
import math
import socket
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from datetime import datetime
from functools import partial
from typing import Any, TypeVar

import pandas as pd
import yfinance as yf
from yfinance.exceptions import YFRateLimitError

from .base import (
    BAR_COLUMNS,
    PartialQuotes,
    ProviderError,
    QuoteList,
    RateLimited,
    SymbolNotFound,
    UpstreamDegraded,
    UpstreamUnavailable,
    charge_upstream,
)

try:  # curl_cffi is yfinance's HTTP client; its errors are OSError subclasses.
    from curl_cffi.requests.exceptions import RequestException as _CurlRequestError
except ImportError:  # pragma: no cover - depends on the installed yfinance
    _CurlRequestError = None  # type: ignore[assignment,misc]

log = logging.getLogger(__name__)
T = TypeVar("T")

# Network failures only. A bare OSError would also catch disk-cache errors
# (PermissionError, FileNotFoundError), which are not "Yahoo unreachable".
_NETWORK_ERRORS: tuple[type[BaseException], ...] = (
    ConnectionError,
    TimeoutError,
    socket.gaierror,
    *((_CurlRequestError,) if _CurlRequestError is not None else ()),
)


# Retries after a failure that is neither a rate limit nor a network error.
_OTHER_ERROR_RETRIES = 1
# Symbols whose currency is remembered for `quotes` (least recently used dropped first).
_CURRENCY_CACHE_MAX = 4096
# Largest `quotes` batch the daily-bar download fallback serves (one request per symbol).
_FALLBACK_MAX_SYMBOLS = 10


class RateLimiter:
    """Thread-safe minimum spacing between upstream requests."""

    def __init__(self, min_interval: float) -> None:
        self._min_interval = min_interval
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            delay = self._next_at - now
            self._next_at = max(now, self._next_at) + self._min_interval
        if delay > 0:
            time.sleep(delay)


class YahooProvider:
    def __init__(
        self,
        min_interval: float = 0.25,
        retries: int = 4,
        *,
        rate_limit_retries: int | None = None,
        quote_v7_retry_s: float = 300,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """`retries` bounds retries after network failures; `rate_limit_retries` after a
        rate-limit refusal (None: same as `retries`). Other failures are retried once.
        Every retry is reported with `charge_upstream` first and skipped if refused.
        After a failed v7 quote request, `quotes` skips v7 for `quote_v7_retry_s`."""
        self._limiter = RateLimiter(min_interval)
        self._retries = retries
        self._rate_limit_retries = retries if rate_limit_retries is None else rate_limit_retries
        self._v7_retry_s = quote_v7_retry_s
        self._clock = clock
        self._v7_retry_at: float | None = None
        self._currencies: OrderedDict[str, str] = OrderedDict()
        self._currencies_lock = threading.Lock()

    def _call(self, fn: Callable[[], T], cost: int = 1) -> T:
        """Run `fn` (which makes `cost` upstream requests), retrying failures."""
        rate_limited = unreachable = failed = 0
        while True:
            self._limiter.wait()
            try:
                return fn()
            except YFRateLimitError as exc:
                if rate_limited >= self._rate_limit_retries or not _may_retry(cost):
                    raise RateLimited(
                        "Yahoo rate limit exceeded", 2**self._rate_limit_retries
                    ) from exc
                backoff = 2**rate_limited
                rate_limited += 1
                log.warning("Yahoo rate limited, retrying in %ss", backoff)
                time.sleep(backoff)
            except ProviderError:
                raise
            except _NETWORK_ERRORS as exc:
                # Connection failures and timeouts (builtin and curl_cffi ones).
                if unreachable >= self._retries or not _may_retry(cost):
                    raise UpstreamUnavailable(f"Yahoo unreachable: {exc}") from exc
                time.sleep(0.5 * 2**unreachable)
                unreachable += 1
            except Exception as exc:
                # Usually a payload yfinance could not parse; repeating rarely helps.
                if failed >= min(self._retries, _OTHER_ERROR_RETRIES) or not _may_retry(cost):
                    raise ProviderError(f"Yahoo request failed: {exc}") from exc
                time.sleep(0.5 * 2**failed)
                failed += 1

    def _remember_currency(self, symbol: str, ticker: Any) -> None:
        # Call only after ticker.history(): the metadata is then already loaded.
        # quotes() only reads this cache, so it never costs a request per symbol.
        meta = ticker.history_metadata
        if meta and meta.get("currency"):
            with self._currencies_lock:
                self._currencies[symbol.upper()] = str(meta["currency"])
                self._currencies.move_to_end(symbol.upper())
                while len(self._currencies) > _CURRENCY_CACHE_MAX:
                    self._currencies.popitem(last=False)

    def _currency(self, symbol: str) -> str | None:
        with self._currencies_lock:
            currency = self._currencies.get(symbol)
            if currency is not None:
                self._currencies.move_to_end(symbol)
            return currency

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        def fetch() -> pd.DataFrame:
            kwargs: dict[str, Any] = {
                "interval": interval,
                "prepost": prepost,
                "auto_adjust": False,
                "actions": False,
                "raise_errors": False,
            }
            if start is None:
                kwargs["period"] = "max"
            else:
                kwargs["start"] = start
                if end is not None:
                    kwargs["end"] = end
            ticker = yf.Ticker(symbol)
            df: pd.DataFrame = ticker.history(**kwargs)
            self._remember_currency(symbol, ticker)
            return df

        frame = self._call(fetch)
        if frame is None or frame.empty:
            # yfinance turns connection failures into an empty frame ("possibly delisted"):
            # make sure Yahoo answers before the symbol is reported as unknown.
            self._ensure_reachable()
        return _normalize(frame)

    def _ensure_reachable(self) -> None:
        """Raise `UpstreamUnavailable` when Yahoo cannot be reached (one cheap request)."""
        charge_upstream(1)

        def probe() -> None:
            from yfinance.const import _QUERY1_URL_
            from yfinance.data import YfData

            # Any HTTP answer will do; only a failed connection raises.
            YfData()._session.get(_QUERY1_URL_, timeout=10)

        self._call(probe)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        def fetch() -> dict[str, Any]:
            t = yf.Ticker(symbol)
            t.history(period="5d", interval="1d", auto_adjust=False, raise_errors=False)
            meta: dict[str, Any] = t.history_metadata or {}
            self._remember_currency(symbol, t)
            return meta

        meta = self._call(fetch)
        if not meta.get("symbol"):
            self._ensure_reachable()
            raise SymbolNotFound(symbol)
        price_hint = int(meta.get("priceHint") or 2)
        regular = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
        return {
            "symbol": meta["symbol"],
            "name": meta.get("longName") or meta.get("shortName") or meta["symbol"],
            "exchange": meta.get("exchangeName"),
            "exchangeName": meta.get("fullExchangeName"),
            "type": (meta.get("instrumentType") or "").lower() or None,
            "currency": meta.get("currency"),
            "timezone": meta.get("exchangeTimezoneName"),
            "session": _session_string(regular),
            "priceHint": price_hint,
            "minTick": 10**-price_hint,
            "hasIntraday": True,
        }

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        def fetch() -> list[dict[str, Any]]:
            s = yf.Search(query, max_results=limit, news_count=0, lists_count=0, raise_errors=True)
            quotes: list[dict[str, Any]] = s.quotes
            return quotes

        return [
            {
                "symbol": q["symbol"],
                "name": q.get("longname") or q.get("shortname") or q["symbol"],
                "exchange": q.get("exchDisp") or q.get("exchange"),
                "type": (q.get("quoteType") or "").lower() or None,
                "typeDisplay": q.get("typeDisp"),
            }
            for q in self._call(fetch)
            if q.get("symbol")
        ]

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Latest quote per known symbol from Yahoo's v7 quote endpoint, 50 symbols per
        request. When every chunk answered with rows, the result is `confirmed`: a symbol
        without a row does not exist (an empty answer may be a glitch, so it never confirms).

        If v7 fails for another reason than a rate limit or an outage, it is skipped for
        `quote_v7_retry_s` and the daily bars are downloaded instead (one request per
        symbol, charged with `charge_upstream`, unconfirmed), for batches of at most
        `_FALLBACK_MAX_SYMBOLS`; larger ones raise `UpstreamDegraded`.
        """
        if not symbols:
            return QuoteList(confirmed=True)
        retry_at = self._v7_retry_at
        if retry_at is not None and self._clock() < retry_at:
            return self._fallback_quotes(symbols, None)
        rows: list[dict[str, Any]] = []
        confirmed = True
        try:
            for i in range(0, len(symbols), _V7_CHUNK):
                found = self._call(partial(self._v7_quote, symbols[i : i + _V7_CHUNK]))
                confirmed = confirmed and bool(found)
                rows.extend(found)
        except (RateLimited, UpstreamUnavailable):
            raise  # the guard's breakers need to see these; a fallback would only add load
        except ProviderError as exc:
            self._v7_retry_at = self._clock() + self._v7_retry_s
            log.warning(
                "v7 quotes failing; skipping them for %.0fs", self._v7_retry_s, exc_info=True
            )
            return self._fallback_quotes(symbols, exc)
        self._v7_retry_at = None
        return QuoteList(
            (q for r in rows if (q := _v7_to_quote(r)) is not None), confirmed=confirmed
        )

    def _fallback_quotes(self, symbols: list[str], cause: Exception | None) -> QuoteList:
        if len(symbols) > _FALLBACK_MAX_SYMBOLS:
            raise UpstreamDegraded(
                f"Yahoo v7 quotes unavailable; the fallback serves at most "
                f"{_FALLBACK_MAX_SYMBOLS} symbols"
            ) from cause
        charge_upstream(len(symbols))  # raises when the budget cannot cover it
        return QuoteList(self._download_quotes(symbols))

    def _download_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        def fetch() -> pd.DataFrame:
            df: pd.DataFrame = yf.download(
                symbols,
                period="5d",
                interval="1d",
                auto_adjust=False,
                progress=False,
                group_by="ticker",
                threads=False,
            )
            return df

        frame = self._call(fetch, cost=len(symbols))
        out: list[dict[str, Any]] = []
        if frame is None or frame.empty or not isinstance(frame.columns, pd.MultiIndex):
            return out
        available = set(frame.columns.get_level_values(0))
        for sym in symbols:
            if sym not in available:
                continue
            sub = pd.DataFrame(frame[sym]).dropna(subset=["Close"])
            if sub.empty:
                continue
            last = float(sub["Close"].iloc[-1])
            prev = float(sub["Close"].iloc[-2]) if len(sub) > 1 else None
            change = last - prev if prev is not None else None
            vol = _num(sub["Volume"].iloc[-1]) if "Volume" in sub else None
            stamp = pd.Timestamp(sub.index[-1])
            if stamp.tzinfo is None:
                stamp = stamp.tz_localize("UTC")
            out.append(
                {
                    "symbol": sym,
                    "last": last,
                    "prevClose": prev,
                    "change": change,
                    "changePercent": change / prev * 100 if change is not None and prev else None,
                    "volume": int(vol) if vol is not None else None,
                    "currency": self._currency(sym),
                    "marketState": None,
                    "time": int(stamp.timestamp()),
                }
            )
        return out

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        """Pre/post-market quotes from Yahoo's v7 quote endpoint, 50 symbols per request.

        A failed chunk is not retried per symbol (that would multiply upstream requests);
        if any chunk fails, `PartialQuotes` is raised carrying the successes and the
        failed symbols, so callers never mistake a failure for "unknown symbol".
        """
        out: list[dict[str, Any]] = []
        failed: list[str] = []
        for i in range(0, len(symbols), _V7_CHUNK):
            chunk = symbols[i : i + _V7_CHUNK]
            try:
                results = self._call(partial(self._v7_quote, chunk))
            except ProviderError:
                log.warning("extended quotes unavailable for %d symbols", len(chunk), exc_info=True)
                failed.extend(chunk)
                continue
            out.extend(q for r in results if (q := _extended_quote(r)) is not None)
        if failed:
            raise PartialQuotes("Yahoo extended quotes unavailable", out, failed)
        return out

    def _v7_quote(self, chunk: list[str]) -> list[dict[str, Any]]:
        """Raw `quoteResponse.result` rows. Private yfinance API (YfData handles cookie/crumb)."""
        from yfinance.const import _QUERY1_URL_
        from yfinance.data import YfData

        payload = YfData().get_raw_json(
            f"{_QUERY1_URL_}/v7/finance/quote",
            params={"symbols": ",".join(chunk), "formatted": "false"},
        )
        # Shape errors are permanent: ProviderError is not retried by `_call`.
        if not isinstance(payload, dict):
            raise ProviderError("Yahoo v7 quote: unexpected payload")
        response = payload.get("quoteResponse")
        result = response.get("result") if isinstance(response, dict) else None
        if not isinstance(result, list):
            raise ProviderError("Yahoo v7 quote: unexpected payload shape")
        return [r for r in result if isinstance(r, dict)]

    def events(self, symbol: str) -> dict[str, Any]:
        def fetch() -> tuple[pd.Series | None, pd.Series | None, pd.DataFrame | None]:
            t = yf.Ticker(symbol)
            try:
                earnings = t.get_earnings_dates(limit=100)
            except Exception:
                log.warning("earnings dates unavailable for %s", symbol, exc_info=True)
                earnings = None
            return t.dividends, t.splits, earnings

        dividends, splits, earnings = self._call(fetch, cost=2)
        if dividends is None and splits is None:
            self._ensure_reachable()
            raise SymbolNotFound(symbol)
        return {
            "dividends": [
                {"t": _unix(i), "amount": _num(v)}
                for i, v in (dividends if dividends is not None else pd.Series(dtype=float)).items()
            ],
            "splits": [
                {"t": _unix(i), "ratio": _num(v)}
                for i, v in (splits if splits is not None else pd.Series(dtype=float)).items()
            ],
            "earnings": _earnings(earnings),
        }

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        def fetch() -> list[dict[str, Any]]:
            items: list[dict[str, Any]] = yf.Ticker(symbol).get_news(count=limit) or []
            if not items:
                # Yahoo's ncp endpoint used by get_news currently 404s (returns []);
                # the search endpoint still serves the legacy flat news shape.
                charge_upstream(1)
                s = yf.Search(symbol, max_results=1, news_count=limit, lists_count=0)
                items = s.news or []
            return items

        out = [n for n in (_news_item(i) for i in self._call(fetch)) if n is not None]
        return out[:limit]

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        def fetch() -> tuple[dict[str, Any], list[pd.DataFrame]]:
            t = yf.Ticker(symbol)
            info: dict[str, Any] = t.info or {}
            return info, [
                t.income_stmt,
                t.balance_sheet,
                t.cashflow,
                t.quarterly_income_stmt,
                t.quarterly_balance_sheet,
                t.quarterly_cashflow,
            ]

        info, (income, balance, cashflow, q_income, q_balance, q_cashflow) = self._call(
            fetch, cost=7
        )
        statements = {
            "income": _statement(income),
            "balance": _statement(balance),
            "cashflow": _statement(cashflow),
            "quarterly": {
                "income": _statement(q_income),
                "balance": _statement(q_balance),
                "cashflow": _statement(q_cashflow),
            },
        }
        quarterly = statements["quarterly"]
        all_statements = [statements["income"], statements["balance"], statements["cashflow"],
                          *quarterly.values()]
        if not info.get("quoteType") and not any(s["periods"] for s in all_statements):
            raise SymbolNotFound(symbol)
        return {
            "info": {k: _clean(info.get(k)) for k in _INFO_KEYS if info.get(k) is not None},
            "financials": statements,
        }


def _may_retry(cost: int) -> bool:
    """Whether the upstream budget allows a retry costing `cost` requests."""
    try:
        charge_upstream(cost)
    except ProviderError:
        return False
    return True


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=BAR_COLUMNS)
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    if "Adj Close" not in df.columns:
        df = df.assign(**{"Adj Close": df["Close"]})
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    out = pd.DataFrame(
        {
            "ts": idx.tz_convert("UTC").tz_localize(None).as_unit("s").to_numpy().astype("int64"),
            "open": df["Open"].to_numpy(float),
            "high": df["High"].to_numpy(float),
            "low": df["Low"].to_numpy(float),
            "close": df["Close"].to_numpy(float),
            "adj_close": df["Adj Close"].fillna(df["Close"]).to_numpy(float),
            "volume": df["Volume"].fillna(0).to_numpy(float),
        }
    )
    out = out.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    return _snap_live_bar(out)


def _snap_live_bar(df: pd.DataFrame) -> pd.DataFrame:
    """Yahoo appends the latest quote as an extra row stamped with the quote time
    (e.g. 13:42:45 on a 1m chart). Snap it onto the bar grid and merge it into the
    bar it belongs to."""
    if len(df) < 2:
        return df
    ts: list[int] = df["ts"].astype("int64").tolist()
    prev_ts, last_ts = ts[-2], ts[-1]
    # Infer bar spacing from the regular rows; skip daily+ (calendar-based spacing).
    regular = ts[-6:-1]
    gaps = [b - a for a, b in zip(regular, regular[1:], strict=False)]
    step = min(gaps) if gaps else last_ts - prev_ts
    if step <= 0 or step >= 86_400 or (last_ts - prev_ts) % step == 0:
        return df
    snapped = prev_ts + (last_ts - prev_ts) // step * step
    if snapped != prev_ts:
        df.loc[df.index[-1], "ts"] = snapped
        return df
    last = df.iloc[-1]
    i = df.index[-2]
    df.loc[i, "high"] = max(df.at[i, "high"], last["high"])
    df.loc[i, "low"] = min(df.at[i, "low"], last["low"])
    df.loc[i, "close"] = last["close"]
    df.loc[i, "adj_close"] = last["adj_close"]
    return df.iloc[:-1].reset_index(drop=True)


def _session_string(regular: dict[str, Any]) -> str | None:
    start, end = regular.get("start"), regular.get("end")
    if start is None or end is None:
        return None
    tz = regular.get("timezone")
    s, e = pd.Timestamp(start), pd.Timestamp(end)
    if isinstance(start, (int, float)):
        s = pd.Timestamp(start, unit="s", tz="UTC")
        e = pd.Timestamp(end, unit="s", tz="UTC")
        if tz:
            s, e = s.tz_convert(tz), e.tz_convert(tz)
    return f"{s:%H%M}-{e:%H%M}"


_INFO_KEYS = (
    "longName",
    "quoteType",
    "currency",
    "exchange",
    "marketCap",
    "enterpriseValue",
    "trailingPE",
    "forwardPE",
    "priceToBook",
    "trailingEps",
    "forwardEps",
    "dividendRate",
    "dividendYield",
    "payoutRatio",
    "beta",
    "fiftyTwoWeekHigh",
    "fiftyTwoWeekLow",
    "fiftyDayAverage",
    "twoHundredDayAverage",
    "averageVolume",
    "sharesOutstanding",
    "profitMargins",
    "returnOnEquity",
    "sector",
    "industry",
    "country",
    "website",
    "fullTimeEmployees",
    "longBusinessSummary",
    "earningsTimestamp",
    "earningsTimestampStart",
    "earningsTimestampEnd",
    "isEarningsDateEstimate",
    "exDividendDate",
    "floatShares",
)


_V7_CHUNK = 50


def _extended_quote(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map a v7 quote row; change fields are computed against the regular price."""
    sym = raw.get("symbol")
    if not isinstance(sym, str) or not sym:
        return None
    regular = _num(raw.get("regularMarketPrice"))

    def session(prefix: str) -> dict[str, Any]:
        price = _num(raw.get(f"{prefix}Price"))
        when = _num(raw.get(f"{prefix}Time"))
        change = price - regular if price is not None and regular is not None else None
        pct = change / regular * 100 if change is not None and regular and regular > 0 else None
        return {
            f"{prefix}Price": price,
            f"{prefix}Time": int(when) if when is not None else None,
            f"{prefix}Change": change if pct is not None else None,
            f"{prefix}ChangePercent": pct,
        }

    rtime = _num(raw.get("regularMarketTime"))
    state = raw.get("marketState")
    return {
        "symbol": sym,
        "marketState": state if isinstance(state, str) else None,
        "regularMarketPrice": regular,
        "regularMarketTime": int(rtime) if rtime is not None else None,
        **session("preMarket"),
        **session("postMarket"),
    }


def _v7_to_quote(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map a v7 row to the `quotes` shape; change fields fall back to the previous close."""
    sym = raw.get("symbol")
    if not isinstance(sym, str) or not sym:
        return None
    last = _num(raw.get("regularMarketPrice"))
    prev = _num(raw.get("regularMarketPreviousClose"))
    change = _num(raw.get("regularMarketChange"))
    if change is None and last is not None and prev is not None:
        change = last - prev
    pct = _num(raw.get("regularMarketChangePercent"))
    if pct is None and change is not None and prev:
        pct = change / prev * 100
    volume = _num(raw.get("regularMarketVolume"))
    when = _num(raw.get("regularMarketTime"))
    currency = raw.get("currency")
    state = raw.get("marketState")
    return {
        "symbol": sym,
        "last": last,
        "prevClose": prev,
        "change": change,
        "changePercent": pct,
        "volume": int(volume) if volume is not None else None,
        "currency": currency if isinstance(currency, str) else None,
        "marketState": state if isinstance(state, str) else None,
        "time": int(when) if when is not None else None,
    }


def _num(v: Any) -> float | None:
    """Float or None for NaN/inf/missing/non-numeric."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _clean(v: Any) -> Any:
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, str):
        return v
    if hasattr(v, "item"):  # numpy scalar
        v = v.item()
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    return v


def _unix(ts: Any) -> int:
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    return int(t.timestamp())


def _earnings(df: pd.DataFrame | None) -> list[dict[str, Any]]:
    if df is None or df.empty:
        return []
    out: list[dict[str, Any]] = []
    for idx, row in df.iterrows():
        out.append(
            {
                "t": _unix(idx),
                "epsEstimate": _num(row.get("EPS Estimate")),
                "epsActual": _num(row.get("Reported EPS")),
                "surprisePercent": _num(row.get("Surprise(%)")),
            }
        )
    out.sort(key=lambda e: e["t"])
    return out


def _statement(df: pd.DataFrame | None) -> dict[str, Any]:
    if df is None or df.empty:
        return {"periods": [], "rows": {}}
    periods = [pd.Timestamp(c).date().isoformat() for c in df.columns]
    rows = {str(name): [_num(v) for v in df.loc[name].tolist()] for name in df.index}
    return {"periods": periods, "rows": rows}


def _news_item(item: dict[str, Any]) -> dict[str, Any] | None:
    """Normalize both Yahoo news shapes (nested `content` and legacy flat)."""
    c: dict[str, Any] = item.get("content") or item
    title = c.get("title")
    url = (
        (c.get("canonicalUrl") or {}).get("url")
        or (c.get("clickThroughUrl") or {}).get("url")
        or c.get("link")
    )
    nid = item.get("id") or item.get("uuid") or c.get("id")
    if not title or not url or not nid:
        return None
    provider = c.get("provider")
    publisher = provider.get("displayName") if isinstance(provider, dict) else c.get("publisher")
    raw_time = c.get("pubDate") or c.get("displayTime") or c.get("providerPublishTime")
    when: int | None = None
    if isinstance(raw_time, (int, float)):
        when = int(raw_time)
    elif isinstance(raw_time, str):
        try:
            when = _unix(raw_time)
        except ValueError:
            when = None
    thumb = c.get("thumbnail")
    thumb_url: str | None = None
    if isinstance(thumb, dict):
        res = [r for r in thumb.get("resolutions") or [] if r.get("url")]
        if res:
            thumb_url = max(res, key=lambda r: r.get("width") or 0)["url"]
        elif thumb.get("originalUrl"):
            thumb_url = thumb["originalUrl"]
    return {
        "id": str(nid),
        "title": title,
        "publisher": publisher,
        "url": url,
        "time": when,
        "summary": c.get("summary") or c.get("description"),
        "thumbnail": thumb_url,
    }
