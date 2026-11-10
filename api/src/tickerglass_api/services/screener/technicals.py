"""Snapshot technicals of one symbol from its daily bars (docs/design/server-screener.md §5).

Pure numpy/pandas: no I/O, no clock except the `now` passed in. Prices are the stored
`close` (split-adjusted, not dividend-adjusted, like the chart's default series). Rows
without a close are dropped; a missing open/high/low is taken to be the close.

Definitions (bar = one daily bar, "today" = the newest bar used):

- In-progress bars are dropped first. Crypto: every bar of the current UTC day. Others:
  every bar whose local date (in `tz`) is after `target`, the latest completed session
  (default: `latest_completed_session(now, tz)`).
- `last` close of today; `prev_close` / `prev_last` close of the bar before.
- `chg1d_pct` = (last - prev_close) / prev_close * 100;
  `gap_pct` = (open - prev_close) / prev_close * 100.
- `volume` today's volume; `avg_vol30` mean volume of the 30 bars before today (today
  excluded); `rel_vol` = volume / avg_vol30; `avg_dollar_vol30` mean close * volume of the
  same 30 bars (in the quote currency).
- `perf_*`: `services.performance.compute_performance` (calendar offsets in `tz`).
- `rsi14`: Wilder RSI (RMA of gains/losses seeded with the mean of the first 14 changes;
  first value on the 15th bar), `prev_rsi14` the value one bar earlier.
- `smaN` simple mean of the last N closes; `prev_smaN` the same ending one bar earlier;
  `pct_vs_smaN` = (last / smaN - 1) * 100.
- `hi52` / `lo52`: highest high / lowest low of the last 252 bars (365 for crypto, which
  trades every day; today included);
  `pct_off_hi52` = (last / hi52 - 1) * 100 (<= 0), `pct_off_lo52` = (last / lo52 - 1) * 100.
- `new_hi52`: today's high >= the highest high of the 252 (crypto: 365) bars before today
  (253 / 366 bars needed); `new_lo52`: today's low <= the lowest low of those 252 bars.
- `atr14`: Wilder ATR (true range, the first bar's being high - low, RMA seeded with the
  mean of the first 14); `atr_pct` = atr14 / last * 100.
- `cross_state`: 1 while SMA50 > SMA200 (golden), -1 while below (death), None when equal
  or not computable. `days_since_cross`: bars since the first bar of the current state
  (0: the cross happened today), None when the history with both averages does not reach
  back to the previous opposite state.

A field needing more bars than there are is None.
"""

import math
from collections.abc import Collection
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from ..holidays import close_time, is_trading_day, previous_trading_day
from ..performance import compute_performance

RSI_LEN = 14
ATR_LEN = 14
SMA_LENGTHS = (20, 50, 200)
#: Trading bars in a 52-week window.
WEEKS52_BARS = 252
#: Crypto trades every day: a 52-week window is 365 daily bars.
WEEKS52_BARS_CRYPTO = 365
VOLUME_AVG_BARS = 30
# `compute_performance` period keys -> snapshot columns.
_PERF_COLUMNS = {
    "1W": "perf_1w",
    "1M": "perf_1m",
    "3M": "perf_3m",
    "6M": "perf_6m",
    "YTD": "perf_ytd",
    "1Y": "perf_1y",
}

#: Every metric key of `compute_snapshot` besides `bar_ts` and `bars_count`.
METRIC_COLUMNS = (
    "last",
    "prev_close",
    "chg1d_pct",
    "gap_pct",
    "volume",
    "avg_vol30",
    "rel_vol",
    "avg_dollar_vol30",
    *_PERF_COLUMNS.values(),
    "rsi14",
    "prev_rsi14",
    "sma20",
    "sma50",
    "sma200",
    "prev_last",
    "prev_sma20",
    "prev_sma50",
    "prev_sma200",
    "pct_vs_sma20",
    "pct_vs_sma50",
    "pct_vs_sma200",
    "hi52",
    "lo52",
    "pct_off_hi52",
    "pct_off_lo52",
    "new_hi52",
    "new_lo52",
    "atr14",
    "atr_pct",
    "cross_state",
    "days_since_cross",
)


def session_final_at(
    target: date,
    tz: str,
    settle: timedelta = timedelta(0),
    *,
    extra: Collection[date] | None = None,
) -> datetime:
    """When the bars of the `target` session are final (its close in `tz` plus `settle`), UTC:
    16:00, or 13:00 on an NYSE early-close day (`services.holidays.close_time`). A snapshot
    computed from then on has every bar there is for that session: it is current even when
    its newest bar is older (a symbol not trading, or a crypto series whose newest complete UTC
    day ends before the US close)."""
    close = close_time(target, extra=extra)
    return (datetime.combine(target, close, ZoneInfo(tz)) + settle).astimezone(UTC)


def latest_completed_session(
    now: datetime,
    tz: str,
    *,
    close: time | None = None,
    settle: timedelta = timedelta(0),
    extra: Collection[date] | None = None,
) -> date:
    """Local date (in `tz`) of the latest NYSE trading day (no weekend, no holiday: see
    `services.holidays`, `extra` the one-off closures) whose close + `settle` is at or before
    `now`. The close is `close` when given, else the day's (13:00 on an early close, else
    16:00)."""
    zone = ZoneInfo(tz)
    local = now.astimezone(zone)
    day = local.date()
    if is_trading_day(day, extra=extra):
        end = datetime.combine(day, close or close_time(day, extra=extra), zone) + settle
        if local >= end:
            return day
    return previous_trading_day(day, extra=extra)


def _rma(x: np.ndarray, n: int) -> np.ndarray:
    """Wilder smoothing seeded with the mean of the first `n` values from the first
    non-NaN one (the `rma` of packages/indicators golden_common.py)."""
    out = np.full(len(x), np.nan)
    valid = np.flatnonzero(~np.isnan(x))
    if valid.size == 0:
        return out
    s = int(valid[0])
    if s + n - 1 >= len(x):
        return out
    prev = float(np.mean(x[s : s + n]))
    out[s + n - 1] = prev
    alpha = 1.0 / n
    for i in range(s + n, len(x)):
        prev = alpha * float(x[i]) + (1 - alpha) * prev
        out[i] = prev
    return out


def wilder_rsi(close: np.ndarray, n: int = RSI_LEN) -> np.ndarray:
    """Wilder RSI per bar (NaN during warm-up): 100 when there were no losses, 0 when no
    gains."""
    ch = np.full(len(close), np.nan)
    if len(close) > 1:
        ch[1:] = np.diff(close)
    up = _rma(np.where(np.isnan(ch), np.nan, np.maximum(ch, 0.0)), n)
    down = _rma(np.where(np.isnan(ch), np.nan, -np.minimum(ch, 0.0)), n)
    out = np.full(len(close), np.nan)
    for i in range(len(close)):
        u, d = up[i], down[i]
        if np.isnan(u) or np.isnan(d):
            continue
        out[i] = 100.0 if d == 0 else 0.0 if u == 0 else 100 - 100 / (1 + u / d)
    return out


def true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """True range per bar; the first bar's is high - low."""
    if len(close) == 0:
        return np.array([], dtype=float)
    prev = np.concatenate([[np.nan], close[:-1]])
    tr: np.ndarray = np.maximum(np.maximum(high - low, np.abs(high - prev)), np.abs(low - prev))
    tr[0] = high[0] - low[0]
    return tr


def wilder_atr(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int = ATR_LEN
) -> np.ndarray:
    return _rma(true_range(high, low, close), n)


def sma(x: np.ndarray, n: int) -> np.ndarray:
    """Simple moving average per bar (NaN before `n` values)."""
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        csum = np.cumsum(np.concatenate([[0.0], x]))
        out[n - 1 :] = (csum[n:] - csum[:-n]) / n
    return out


def _f(v: Any) -> float | None:
    """Finite float or None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _pct(a: float | None, b: float | None) -> float | None:
    """(a / b - 1) * 100, None when either is missing or b is not positive."""
    if a is None or b is None or b <= 0:
        return None
    return (a / b - 1) * 100


def _at(x: np.ndarray, back: int) -> float | None:
    """x[-1 - back] as a finite float, None when out of range."""
    return _f(x[-1 - back]) if len(x) > back else None


def _nanmean(x: np.ndarray) -> float | None:
    x = x[~np.isnan(x)]
    return float(np.mean(x)) if x.size else None


def _cross(sma50: np.ndarray, sma200: np.ndarray) -> tuple[int | None, int | None]:
    diff = sma50 - sma200
    if len(diff) == 0 or np.isnan(diff[-1]) or diff[-1] == 0:
        return None, None
    state = 1 if diff[-1] > 0 else -1
    last = len(diff) - 1
    first_of_state = last
    for i in range(last - 1, -1, -1):
        d = diff[i]
        if np.isnan(d):
            return state, None
        if d == 0:
            continue  # touching without crossing: still the same state
        if (d > 0) != (state > 0):
            return state, last - first_of_state
        first_of_state = i
    return state, None


def _prepare(
    df: pd.DataFrame, tz: str, now: datetime, crypto: bool, target: date | None
) -> pd.DataFrame:
    frame = df.sort_values("ts").drop_duplicates("ts", keep="last")
    frame = frame[frame["close"].notna()].reset_index(drop=True)
    if frame.empty:
        return frame
    zone = UTC if crypto else ZoneInfo(tz)
    dates = [datetime.fromtimestamp(int(t), zone).date() for t in frame["ts"]]
    if crypto:
        today_utc = now.astimezone(UTC).date()
        keep = [d < today_utc for d in dates]
    else:
        limit = target if target is not None else latest_completed_session(now, tz)
        keep = [d <= limit for d in dates]
    frame = frame[keep].reset_index(drop=True)
    for col in ("open", "high", "low"):
        frame[col] = frame[col].fillna(frame["close"])
    return frame


def compute_snapshot(
    df: pd.DataFrame,
    tz: str,
    now: datetime,
    *,
    crypto: bool = False,
    target: date | None = None,
) -> dict[str, float | int | bool | None]:
    """Snapshot metrics (see the module docstring) of daily bars `df` (BAR_COLUMNS, any
    order). Keys are `ScreenerSnapshot` column names: `bar_ts` (open time of the newest bar
    used), `bars_count` and every `METRIC_COLUMNS` entry. Raises ValueError when no
    completed bar is left."""
    frame = _prepare(df, tz, now, crypto, target)
    if frame.empty:
        raise ValueError("no completed bars")
    c = frame["close"].to_numpy(dtype=float)
    o = frame["open"].to_numpy(dtype=float)
    h = frame["high"].to_numpy(dtype=float)
    lo = frame["low"].to_numpy(dtype=float)
    v = frame["volume"].to_numpy(dtype=float)
    n = len(c)

    out: dict[str, float | int | bool | None] = dict.fromkeys(METRIC_COLUMNS)
    out["bar_ts"] = int(frame["ts"].iloc[-1])
    out["bars_count"] = n
    last = _f(c[-1])
    prev = _at(c, 1)
    out["last"] = last
    out["prev_close"] = prev
    out["prev_last"] = prev
    if prev is not None and prev != 0 and last is not None:
        out["chg1d_pct"] = (last - prev) / prev * 100
        today_open = _f(o[-1])
        if today_open is not None:
            out["gap_pct"] = (today_open - prev) / prev * 100

    volume = _f(v[-1])
    out["volume"] = volume
    if n > VOLUME_AVG_BARS:
        window = slice(n - 1 - VOLUME_AVG_BARS, n - 1)
        avg_vol = _nanmean(v[window])
        out["avg_vol30"] = avg_vol
        out["avg_dollar_vol30"] = _nanmean(c[window] * v[window])
        if volume is not None and avg_vol is not None and avg_vol > 0:
            out["rel_vol"] = volume / avg_vol

    perf = compute_performance(frame, "UTC" if crypto else tz)
    for period in perf["periods"]:
        column = _PERF_COLUMNS.get(period["key"])
        if column is not None:
            out[column] = _f(period["changePercent"])

    rsi = wilder_rsi(c)
    out["rsi14"] = _at(rsi, 0)
    out["prev_rsi14"] = _at(rsi, 1)

    smas: dict[int, np.ndarray] = {}
    for length in SMA_LENGTHS:
        series = sma(c, length)
        smas[length] = series
        value = _at(series, 0)
        out[f"sma{length}"] = value
        out[f"prev_sma{length}"] = _at(series, 1)
        out[f"pct_vs_sma{length}"] = _pct(last, value)

    year = WEEKS52_BARS_CRYPTO if crypto else WEEKS52_BARS
    if n >= year:
        hi52 = _f(np.nanmax(h[-year:]))
        lo52 = _f(np.nanmin(lo[-year:]))
        out["hi52"], out["lo52"] = hi52, lo52
        out["pct_off_hi52"] = _pct(last, hi52)
        out["pct_off_lo52"] = _pct(last, lo52)
    if n > year:
        prior = slice(n - 1 - year, n - 1)
        prior_hi, prior_lo = _f(np.nanmax(h[prior])), _f(np.nanmin(lo[prior]))
        today_hi, today_lo = _f(h[-1]), _f(lo[-1])
        if prior_hi is not None and today_hi is not None:
            out["new_hi52"] = bool(today_hi >= prior_hi)
        if prior_lo is not None and today_lo is not None:
            out["new_lo52"] = bool(today_lo <= prior_lo)

    atr = _at(wilder_atr(h, lo, c), 0)
    out["atr14"] = atr
    if atr is not None and last:
        out["atr_pct"] = atr / last * 100

    out["cross_state"], out["days_since_cross"] = _cross(smas[50], smas[200])
    return out


def bar_date(ts: int, tz: str, *, crypto: bool = False) -> date:
    """Session date of a daily bar opening at `ts` (UTC date for crypto)."""
    return datetime.fromtimestamp(ts, UTC if crypto else ZoneInfo(tz)).date()
