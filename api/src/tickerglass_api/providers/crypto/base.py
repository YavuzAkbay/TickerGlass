"""Shared pieces of the crypto provider: symbols, the exchange adapter interface, the market and
ticker records adapters return, and the interval plan (which bars an exchange serves natively and
which are built from finer ones)."""

import math
import re
from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, ClassVar, Literal

import pandas as pd

from ..base import (
    BAR_COLUMNS,
    ProviderError,
    ProviderNotConfigured,
    RateLimited,
)
from ..http import HttpRateLimited, HttpStatusError, JsonHttp
from ..resample import resample_bars

# -- symbols -----------------------------------------------------------------------------

#: Kraken's names for assets, as canonical (Yahoo-style) symbols spell them.
ASSET_ALIASES = {"XBT": "BTC", "XDG": "DOGE"}
_PAIR = re.compile(r"([A-Z0-9]{1,20})[-/]([A-Z0-9]{3,6})")


def canonical_asset(code: str) -> str:
    """The canonical code of an asset (`XBT` -> `BTC`, `XDG` -> `DOGE`)."""
    code = code.strip().upper()
    return ASSET_ALIASES.get(code, code)


def parse_symbol(symbol: str) -> tuple[str, str] | None:
    """`(base, quote)` of a symbol shaped like a crypto pair (`BTC-USD`, `ETH/USDT`, `XBT-EUR`),
    or None for everything else (stocks, `BRK-B`, indices, FX, futures, suffixed listings). Says
    nothing about whether any exchange lists the pair."""
    s = symbol.strip().upper()
    if not s or s.startswith("^") or s.endswith(("=X", "=F")):
        return None
    match = _PAIR.fullmatch(s)
    if match is None or not any(c.isalpha() for c in match[2]):
        return None
    return canonical_asset(match[1]), canonical_asset(match[2])


def canonical_symbol(symbol: str) -> str | None:
    """`BASE-QUOTE` of a crypto-shaped symbol, aliases resolved; None otherwise."""
    pair = parse_symbol(symbol)
    return f"{pair[0]}-{pair[1]}" if pair else None


# -- records -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Market:
    """A trading pair of the active exchange."""

    #: Canonical `BASE-QUOTE`.
    symbol: str
    base: str
    quote: str
    name: str
    #: The id the exchange's REST endpoints take (`XBTUSD`, `BTC-USD`, `BTCUSDT`).
    id: str
    #: Smallest price step, when the exchange tells.
    tick: float | None = None
    #: Other names its REST answers key the pair by (Kraken's `XXBTZUSD`).
    aliases: tuple[str, ...] = ()


@dataclass(frozen=True)
class Ticker:
    """A rolling statistics row of one market. `open` is the price the change is measured
    from (24 hours ago, or today's UTC open on Kraken); the rest is 24-hour rolling."""

    last: float
    open: float | None = None
    high: float | None = None
    low: float | None = None
    #: Volume in the base asset.
    volume: float | None = None
    #: Unix seconds the exchange stamped, when it does.
    time: int | None = None


#: One bar: open time in unix seconds, open, high, low, close, base volume.
Row = tuple[int, float, float, float, float, float]


@dataclass(frozen=True)
class Page:
    """One request's bars (any order) and where the next older page ends (exclusive), or None
    when there is nothing older to ask for."""

    rows: list[Row]
    older: datetime | None


@dataclass(frozen=True)
class Profile:
    """How the app should pace itself on an exchange's public API."""

    calls_per_min: int
    burst: int
    #: Seconds a quote is served from cache, and the polling interval per symbol.
    quote_ttl_s: float
    poll_interval_s: float
    #: Bar tail refresh TTLs (crypto never closes, so these hold around the clock).
    tail_ttl_intraday_s: float
    tail_ttl_daily_s: float


def num(v: Any) -> float | None:
    """A finite float from a number or numeric string, else None."""
    if isinstance(v, bool) or v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def positive_price(v: Any) -> float | None:
    """A finite price above zero, else None (a zero or negative price is a bad row, not a
    quote or a tick)."""
    f = num(v)
    return f if f is not None and f > 0 else None


def parse_time(value: Any) -> datetime | None:
    """A UTC datetime from an RFC 3339 stamp (`2026-11-17T18:24:11.745670Z`, nanoseconds ok)."""
    if not isinstance(value, str):
        return None
    text = value.strip().replace("Z", "+00:00")
    # fromisoformat takes at most microseconds.
    text = re.sub(r"(\.\d{6})\d+", r"\1", text)
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def decimals(step: float | None) -> int:
    """Decimal places of a price step (`0.01` -> 2), for the price hint; 2 when unknown."""
    if step is None or step <= 0:
        return 2
    text = f"{step:.10f}".rstrip("0").partition(".")[2]
    return len(text)


# -- adapter interface -------------------------------------------------------------------


class Stream(ABC):
    """The live side of an exchange: frames to send and a parser of what comes back. The
    ids it speaks in (`stream symbol`) are whatever the exchange's WebSocket names a pair."""

    url: ClassVar[str]

    @abstractmethod
    def symbol(self, canonical: str) -> str:
        """The WebSocket name of a canonical symbol (`BTC-USD` -> `BTC/USD`)."""

    @abstractmethod
    def subscribe(self, ids: Sequence[str]) -> list[Any]:
        """The frames that subscribe to `ids` (stream symbols)."""

    @abstractmethod
    def unsubscribe(self, ids: Sequence[str]) -> list[Any]:
        """The frames that drop `ids`."""

    @abstractmethod
    def parse(self, message: Any) -> list[dict[str, Any]]:
        """The ticks in a decoded frame, in the hub's message shape but with `id` the stream
        symbol exactly as `symbol` spells it. Anything else (acks, heartbeats) gives []. Raises
        `StreamFatal` for an error reconnecting cannot fix."""


class CryptoExchange(ABC):
    """One exchange's public REST API, behind the interface the provider needs. Adapters hold
    no state beyond their HTTP client; the provider caches markets and pages bars."""

    id: ClassVar[str]
    name: ClassVar[str]
    base_url: ClassVar[str]
    #: Canonical interval -> the exchange's own name for it. Intervals missing here are built
    #: from finer ones by the provider.
    native: ClassVar[Mapping[str, str]]
    #: Symbols one tickers request answers.
    quote_batch: ClassVar[int]
    profile: ClassVar[Profile]
    stream: ClassVar[type[Stream]]

    def __init__(self, http: JsonHttp) -> None:
        self._http = http

    # -- transport ----------------------------------------------------------------------

    def get(self, path: str, params: Mapping[str, str], symbol: str = "") -> Any:
        """GET and map failures to the provider errors (`unwrap` and `error` are the
        exchange's own part of it)."""
        try:
            body = self._http.get(path, params)
        except HttpRateLimited as exc:
            raise RateLimited(f"{self.name}: rate limited", exc.retry_after) from None
        except HttpStatusError as exc:
            raise self.error(exc.status, exc.body, symbol) from None
        return self.unwrap(body, symbol)

    def unwrap(self, body: Any, symbol: str) -> Any:
        """The payload of a 2xx answer (Kraken carries its errors inside it)."""
        return body

    @abstractmethod
    def error(self, status: int, body: Any, symbol: str) -> ProviderError:
        """The provider error for a non-2xx answer."""

    def refused(self, status: int) -> ProviderNotConfigured:
        return ProviderNotConfigured(
            f"{self.name} refused the request (HTTP {status}): it may block this network or "
            "region. Pick another exchange with CRYPTO_EXCHANGE or point CRYPTO_BASE_URL at "
            "a reachable endpoint"
        )

    # -- data ---------------------------------------------------------------------------

    @abstractmethod
    def load_markets(self) -> list[Market]:
        """Every tradable pair (one request)."""

    @abstractmethod
    def bars_page(
        self, market: Market, interval: str, start: datetime | None, end: datetime
    ) -> Page:
        """One request's worth of bars of a native `interval` ending before `end` (the newest
        bars the request can hold), and where the next older page would end. `start` bounds
        how far back it needs to look (None: as far as the exchange allows)."""

    @abstractmethod
    def tickers(self, markets: Sequence[Market]) -> dict[str, Ticker]:
        """Rolling statistics by canonical symbol for up to `quote_batch` markets (one
        request); markets the exchange has no row for are absent."""


# -- intervals ---------------------------------------------------------------------------

#: Every interval the provider serves: native where the exchange has it, else synthesized.
INTERVALS = frozenset({"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1d", "1wk", "1mo", "3mo"})

#: Seconds of the native intervals (they only name what the exchanges serve).
INTERVAL_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400}
_MONDAY_OFFSET_S = 4 * 86400  # 1970-01-05, the first Monday after the epoch

Rule = Literal["epoch", "week", "quarter"]


@dataclass(frozen=True)
class Synth:
    """An interval built from a finer one: its source interval and the bucket rule (`week`:
    Monday-anchored; `quarter`: `factor` calendar months from January; both in UTC)."""

    source: str
    rule: Rule
    factor: int


#: How each interval is built when the exchange lacks it, in order of preference.
SYNTH: dict[str, tuple[Synth, ...]] = {
    "2m": (Synth("1m", "epoch", 2),),
    "90m": (Synth("30m", "epoch", 90),),
    "1wk": (Synth("1d", "week", 1),),
    "1mo": (Synth("1d", "quarter", 1),),
    "3mo": (Synth("1mo", "quarter", 3), Synth("1d", "quarter", 3)),
}


def plan_interval(native: Mapping[str, str], interval: str) -> tuple[str, Synth | None] | None:
    """`(source interval, synthesis)` serving `interval` on an exchange with these native
    intervals; the synthesis is None when the exchange serves it itself. None when it cannot
    be served."""
    if interval in native:
        return interval, None
    for synth in SYNTH.get(interval, ()):
        if synth.source in native:
            return synth.source, synth
    return None


def align_start(start: datetime, rule: Rule, factor: int) -> datetime:
    """The start of the bucket `start` falls in, so a synthesized bar is built from all of its
    source bars."""
    start = start.astimezone(UTC)
    if rule == "epoch":
        step = factor * 60
        return datetime.fromtimestamp(int(start.timestamp()) // step * step, UTC)
    midnight = datetime(start.year, start.month, start.day, tzinfo=UTC)
    if rule == "week":
        return midnight - timedelta(days=midnight.weekday())
    month = (start.month - 1) // factor * factor + 1
    return datetime(start.year, month, 1, tzinfo=UTC)


def synthesize(frame: pd.DataFrame, synth: Synth) -> pd.DataFrame:
    """The bars of `frame` (the source interval) aggregated by `synth`."""
    if synth.rule == "week":
        shifted = frame.assign(ts=frame["ts"] - _MONDAY_OFFSET_S)
        out = resample_bars(shifted, "epoch", 7 * 24 * 60, "UTC")
        return out.assign(ts=out["ts"] + _MONDAY_OFFSET_S)
    return resample_bars(frame, synth.rule, synth.factor, "UTC")


def empty_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=BAR_COLUMNS)


def bars_frame(rows: Sequence[Row]) -> pd.DataFrame:
    """Bars as a frame (BAR_COLUMNS, sorted, one row per open time, the last answer winning).
    `adj_close` is `close`: crypto has no adjustments. A bar with a non-positive price is a bad
    row and dropped."""
    if not rows:
        return empty_frame()
    raw = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    raw = raw[raw[["open", "high", "low", "close"]].gt(0).all(axis=1)]
    if raw.empty:
        return empty_frame()
    raw = raw.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    raw["ts"] = raw["ts"].astype("int64")
    raw["adj_close"] = raw["close"]
    return raw[BAR_COLUMNS]
