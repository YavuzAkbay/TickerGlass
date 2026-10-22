"""Offline demo data: a deterministic random walk per symbol, no network.

Every symbol exists and trades on a New York weekday session (09:30-16:00). Prices are
reproducible: the daily path is seeded by the symbol, each day's minute path by the
symbol and the date, and the minute path runs from the day's open to its close, so
daily, intraday and live prices agree with each other. Today's bars end at the current
minute. Meant for trying the app, screenshots and tests, never for trading.
"""

import asyncio
import hashlib
import math
import time
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from ..live import MessageHandler
from .base import BAR_COLUMNS, QuoteList

TZ = ZoneInfo("America/New_York")
OPEN_MIN = 9 * 60 + 30
SESSION_MINUTES = 390
FIRST_DAY = date(2006, 1, 2)

# Fictional tickers offered by search; any other symbol works as well.
DEMO_SYMBOLS: dict[str, str] = {
    "GLSS": "Glassworks Demo Corp",
    "LENS": "Lens & Optics Demo",
    "PRSM": "Prism Analytics Demo",
    "QRTZ": "Quartz Materials Demo",
    "AMBR": "Amber Energy Demo",
    "FACT": "Facet Software Demo",
    "SHRD": "Shard Logistics Demo",
    "KILN": "Kiln Industrial Demo",
}

_MINUTES = {"1m": 1, "2m": 2, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "90m": 90}


def _seed(*parts: object) -> int:
    digest = hashlib.sha256("|".join(map(str, parts)).encode()).digest()
    return int.from_bytes(digest[:8], "little")


def _session_days(last: date) -> list[date]:
    days = pd.bdate_range(FIRST_DAY, last)
    return [d.date() for d in days]


def _open_utc(day: date) -> datetime:
    local = datetime(day.year, day.month, day.day, 9, 30, tzinfo=TZ)
    return local.astimezone(UTC)


def _today_minutes(now: datetime) -> tuple[date, int]:
    """Exchange date of `now` and the number of session minutes that have started."""
    local = now.astimezone(TZ)
    minute = local.hour * 60 + local.minute - OPEN_MIN
    return local.date(), max(0, min(SESSION_MINUTES, minute + 1))


@lru_cache(maxsize=64)
def _daily_path(symbol: str, last: date) -> tuple[tuple[date, ...], np.ndarray, np.ndarray]:
    """Trading days up to `last` with each day's open and close."""
    days = _session_days(last)
    rng = np.random.default_rng(_seed(symbol, "daily"))
    start = 20 + (_seed(symbol, "start") % 380)
    drift = rng.uniform(-0.0001, 0.0005)
    vol = rng.uniform(0.012, 0.028)
    shocks = rng.normal(drift, vol, len(days))
    gaps = rng.normal(0, vol / 4, len(days))
    # Slow pull back towards the starting level keeps prices in a plausible range.
    anchor = math.log(start)
    logs = np.empty(len(days))
    level = anchor
    for i, shock in enumerate(shocks):
        level += shock - 0.004 * (level - anchor)
        logs[i] = level
    closes = np.exp(logs)
    prev = np.concatenate([[start], closes[:-1]])
    opens = prev * np.exp(gaps)
    return tuple(days), opens, closes


@lru_cache(maxsize=1024)
def _minute_path(symbol: str, day: date, open_: float, close: float) -> np.ndarray:
    """Close of each session minute: a Brownian bridge from `open_` to `close`."""
    rng = np.random.default_rng(_seed(symbol, day.isoformat()))
    steps = rng.normal(0, 0.0009, SESSION_MINUTES)
    walk = np.cumsum(steps)
    target = math.log(close / open_)
    frac = np.arange(1, SESSION_MINUTES + 1) / SESSION_MINUTES
    path: np.ndarray = open_ * np.exp(walk - frac * (walk[-1] - target))
    return path


def _minute_volume(symbol: str, day: date) -> np.ndarray:
    rng = np.random.default_rng(_seed(symbol, day.isoformat(), "volume"))
    x = np.linspace(-1, 1, SESSION_MINUTES)
    shape = 1 + 2.5 * x**2  # busier at the open and the close
    busy = rng.lognormal(0, 0.45)  # some days trade far more than others
    vol: np.ndarray = np.round(busy * shape * rng.lognormal(8, 0.5, SESSION_MINUTES))
    return vol


Minutes = tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]


def _day_minutes(symbol: str, day: date, open_: float, close: float, count: int) -> Minutes:
    """(times, opens, highs, lows, closes, volumes) of the first `count` session minutes."""
    closes = _minute_path(symbol, day, open_, close)[:count]
    opens = np.concatenate([[open_], closes[:-1]])
    rng = np.random.default_rng(_seed(symbol, day.isoformat(), "wick"))
    spread = np.abs(rng.normal(0, 0.0004, count)) * closes
    highs = np.maximum(opens, closes) + spread
    lows = np.minimum(opens, closes) - spread
    times = int(_open_utc(day).timestamp()) + 60 * np.arange(count)
    return times, opens, highs, lows, closes, _minute_volume(symbol, day)[:count]


@lru_cache(maxsize=200_000)
def _day_bar(
    symbol: str, day: date, open_: float, close: float, count: int
) -> tuple[float, float, float, float, float]:
    """(open, high, low, close, volume) of a session's first `count` minutes."""
    _, opens, highs, lows, closes, vols = _day_minutes(symbol, day, open_, close, count)
    return (
        float(opens[0]),
        float(highs.max()),
        float(lows.min()),
        float(closes[-1]),
        float(vols.sum()),
    )


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=BAR_COLUMNS)


class DemoProvider:
    """`MarketDataProvider` serving generated data (see the module docstring)."""

    def __init__(self, clock: Any = None) -> None:
        self._clock = clock or (lambda: datetime.now(UTC))

    # ---- core paths -------------------------------------------------------------------

    def _days(self, symbol: str) -> list[tuple[date, float, float, int]]:
        """(day, open, close, minutes so far) of every session up to now."""
        now = self._clock()
        today, elapsed = _today_minutes(now)
        days, opens, closes = _daily_path(symbol, today)
        out = [
            (d, float(o), float(c), SESSION_MINUTES)
            for d, o, c in zip(days, opens, closes, strict=True)
        ]
        if out and out[-1][0] == today:
            if elapsed == 0:
                out.pop()
            elif elapsed < SESSION_MINUTES:
                d, o, c, _ = out[-1]
                out[-1] = (d, o, c, elapsed)
        return out

    def _daily_frame(self, symbol: str) -> pd.DataFrame:
        rows = []
        for day, o, c, count in self._days(symbol):
            op, hi, lo, cl, vol = _day_bar(symbol, day, o, c, count)
            midnight = datetime(day.year, day.month, day.day, tzinfo=TZ)
            rows.append((int(midnight.timestamp()), op, hi, lo, cl, cl, vol))
        return pd.DataFrame(rows, columns=BAR_COLUMNS)

    # ---- MarketDataProvider -------------------------------------------------------------

    def history(
        self,
        symbol: str,
        interval: str,
        start: datetime | None,
        end: datetime | None,
        prepost: bool,
    ) -> pd.DataFrame:
        symbol = symbol.upper()
        lo = int(start.timestamp()) if start else None
        hi = int(end.timestamp()) if end else None
        if interval in _MINUTES:
            frame = self._intraday(symbol, _MINUTES[interval], lo)
        else:
            frame = self._daily_frame(symbol)
            if interval in ("5d", "1wk", "1mo", "3mo"):
                frame = _resample(frame, interval)
        if frame.empty:
            return _empty()
        mask = np.ones(len(frame), dtype=bool)
        if lo is not None:
            mask &= frame["ts"].to_numpy() >= lo
        if hi is not None:
            mask &= frame["ts"].to_numpy() < hi
        return frame[mask].reset_index(drop=True)

    def _intraday(self, symbol: str, minutes: int, lo: int | None) -> pd.DataFrame:
        floor = int((self._clock() - timedelta(days=60)).timestamp())
        lo = max(lo or floor, floor)
        parts = []
        for day, o, c, count in self._days(symbol):
            if int(_open_utc(day).timestamp()) + SESSION_MINUTES * 60 < lo:
                continue
            t, op, hi, low, cl, vol = _day_minutes(symbol, day, o, c, count)
            groups = np.arange(count) // minutes
            frame = pd.DataFrame(
                {"g": groups, "ts": t, "open": op, "high": hi, "low": low, "close": cl, "v": vol}
            )
            agg = frame.groupby("g").agg(
                ts=("ts", "first"),
                open=("open", "first"),
                high=("high", "max"),
                low=("low", "min"),
                close=("close", "last"),
                volume=("v", "sum"),
            )
            agg["adj_close"] = agg["close"]
            parts.append(agg[BAR_COLUMNS])
        if not parts:
            return _empty()
        return pd.concat(parts, ignore_index=True)

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        return {
            "symbol": symbol,
            "name": DEMO_SYMBOLS.get(symbol, f"{symbol} (demo data)"),
            "exchange": "DEMO",
            "exchangeName": "Demo exchange (generated data)",
            "type": "equity",
            "currency": "USD",
            "timezone": "America/New_York",
            "session": "0930-1600",
            "priceHint": 2,
            "minTick": 0.01,
            "hasIntraday": True,
        }

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        q = query.strip().upper()
        hits = [s for s, name in DEMO_SYMBOLS.items() if q in s or q in name.upper()]
        if q and q not in hits:
            hits.append(q)
        return [
            {
                "symbol": s,
                "name": DEMO_SYMBOLS.get(s, f"{s} (demo data)"),
                "exchange": "DEMO",
                "type": "equity",
                "typeDisplay": "Equity",
            }
            for s in hits[:limit]
        ]

    def _last(self, symbol: str) -> tuple[float, float | None, int, float, bool]:
        """(last, previous close, time, day volume, session open) of `symbol`."""
        days = self._days(symbol)
        day, o, c, count = days[-1]
        prev = days[-2][2] if len(days) > 1 else None
        _, _, _, last, volume = _day_bar(symbol, day, o, c, count)
        today, elapsed = _today_minutes(self._clock())
        live = day == today and 0 < elapsed < SESSION_MINUTES
        when = int(_open_utc(day).timestamp()) + 60 * count
        return last, prev, when, volume, live

    def quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        rows = []
        for raw in symbols:
            s = raw.upper()
            last, prev, when, volume, live = self._last(s)
            change = last - prev if prev is not None else None
            rows.append(
                {
                    "symbol": s,
                    "last": last,
                    "prevClose": prev,
                    "change": change,
                    "changePercent": change / prev * 100 if change is not None and prev else None,
                    "volume": int(volume),
                    "currency": "USD",
                    "marketState": "REGULAR" if live else "CLOSED",
                    "time": when,
                }
            )
        return QuoteList(rows, confirmed=True)

    def extended_quotes(self, symbols: list[str]) -> list[dict[str, Any]]:
        out = []
        for raw in symbols:
            s = raw.upper()
            last, _, when, _, live = self._last(s)
            empty = {"Price": None, "Time": None, "Change": None, "ChangePercent": None}
            out.append(
                {
                    "symbol": s,
                    "marketState": "REGULAR" if live else "CLOSED",
                    "regularMarketPrice": last,
                    "regularMarketTime": when,
                    **{f"preMarket{k}": v for k, v in empty.items()},
                    **{f"postMarket{k}": v for k, v in empty.items()},
                }
            )
        return out

    def events(self, symbol: str) -> dict[str, Any]:
        symbol = symbol.upper()
        days = [d for d, *_ in self._days(symbol)]
        quarterly = [d for i, d in enumerate(days) if i % 63 == 40]
        earnings = [d for i, d in enumerate(days) if i % 63 == 20]
        rng = np.random.default_rng(_seed(symbol, "events"))

        def stamp(d: date) -> int:
            return int(datetime(d.year, d.month, d.day, tzinfo=TZ).timestamp())

        return {
            "dividends": [
                {"t": stamp(d), "amount": round(0.2 + rng.random(), 2)} for d in quarterly
            ],
            "splits": [],
            "earnings": [
                {
                    "t": stamp(d),
                    "epsEstimate": round(1 + rng.random(), 2),
                    "epsActual": round(1 + rng.random(), 2),
                    "surprisePercent": round(rng.normal(0, 5), 2),
                }
                for d in earnings
            ],
        }

    def news(self, symbol: str, limit: int) -> list[dict[str, Any]]:
        return []

    def fundamentals(self, symbol: str) -> dict[str, Any]:
        info = self.symbol_info(symbol)
        empty: dict[str, Any] = {"periods": [], "rows": {}}
        return {
            "info": {"longName": info["name"], "quoteType": "EQUITY", "currency": "USD"},
            "financials": {"income": empty, "balance": empty, "cashflow": empty},
        }


def _resample(frame: pd.DataFrame, interval: str) -> pd.DataFrame:
    rule = {"5d": "5D", "1wk": "W-MON", "1mo": "MS", "3mo": "QS"}[interval]
    idx = pd.to_datetime(frame["ts"], unit="s", utc=True).dt.tz_convert(TZ)
    df = frame.set_index(idx)
    agg = df.resample(rule, closed="left", label="left").agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "adj_close": "last",
            "volume": "sum",
        }
    )
    agg = agg.dropna(subset=["open"])
    agg["ts"] = [int(t.timestamp()) for t in agg.index]
    return agg.reset_index(drop=True)[BAR_COLUMNS]


class DemoLiveSource:
    """`LiveSource` that ticks every subscribed symbol once a second from `DemoProvider`."""

    def __init__(self, provider: DemoProvider) -> None:
        self._provider = provider
        self._symbols: set[str] = set()

    async def subscribe(self, symbols: list[str]) -> None:
        self._symbols.update(s.upper() for s in symbols)

    async def unsubscribe(self, symbols: list[str]) -> None:
        self._symbols.difference_update(s.upper() for s in symbols)

    async def listen(self, handler: MessageHandler) -> None:
        while True:
            for s in list(self._symbols):
                last, prev, _, volume, live = self._provider._last(s)
                if not live:
                    continue
                # A little noise within the minute; the minute close stays on the path.
                jitter = math.sin(time.time() * 1.7 + _seed(s) % 97) * last * 0.0003
                price = last + jitter
                change = price - prev if prev is not None else None
                await handler(
                    {
                        "id": s,
                        "price": price,
                        "change": change,
                        "change_percent": (
                            change / prev * 100 if change is not None and prev else None
                        ),
                        "day_volume": volume,
                        "time": int(time.time() * 1000),
                        "market_hours": 1,
                    }
                )
            await asyncio.sleep(1)

    async def close(self) -> None:
        return None
