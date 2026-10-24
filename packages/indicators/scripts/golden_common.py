"""Shared bars, numpy primitives and case collection for the golden scripts.

`golden.py` (entry point) holds the pre-Phase-12 cases and imports one module
per indicator group (`golden_<group>.py`), each exposing `cases()`.

Bar series: `HOURLY` (the default, `bars.csv`, 1000 seeded hourly bars; also
exported as the module-level arrays T, O, H, L, C, V, HL2, HLC3 and length N)
and `DAILY` (`bars-daily.csv`, ~6 years of seeded weekday daily bars). A case
on another series names it with `bars=`; the CSV header then carries
` bars: <file>`. A second aligned series (external symbol, e.g. Correlation)
goes in `extra=` (header ` extra: <file>`). Series files are named
`bars*.csv` and have no header line.

Primitives take arrays of any length (`nans(n)` defaults to the hourly N).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent.parent / "test" / "golden"
NAN = float("nan")


# ---------------------------------------------------------------- bars


@dataclass(eq=False)
class Bars:
    """One OHLCV series and the CSV file it is written to."""

    file: str
    time: np.ndarray
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray

    @property
    def n(self) -> int:
        return len(self.time)

    @property
    def hl2(self) -> np.ndarray:
        return (self.high + self.low) / 2

    @property
    def hlc3(self) -> np.ndarray:
        return (self.high + self.low + self.close) / 3

    def columns(self) -> dict[str, np.ndarray]:
        return {
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
        }


def random_walk(file, time, seed, drift_sd, ret_sd, wick_sd) -> Bars:
    """Seeded random-walk OHLCV with prices rounded to 4 decimals."""
    n = len(time)
    rng = np.random.default_rng(seed)
    close = np.empty(n)
    open_ = np.empty(n)
    price = 100.0
    for i in range(n):
        o = price + rng.normal(0, drift_sd)
        c = o * (1 + rng.normal(0, ret_sd))
        open_[i] = round(o, 4)
        close[i] = round(c, 4)
        price = c
    wick_hi = np.abs(rng.normal(0, wick_sd, n))
    wick_lo = np.abs(rng.normal(0, wick_sd, n))
    high = np.round(np.maximum(open_, close) + wick_hi, 4)
    low = np.round(np.minimum(open_, close) - wick_lo, 4)
    volume = rng.integers(1_000, 10_000, n).astype(np.float64)
    return Bars(file, time, open_, high, low, close, volume)


HOURLY_START = 1704286800  # 2024-01-03 13:00 UTC (Wednesday, mid-week, mid-month)
HOURLY_STEP = 3600  # hourly bars: ~41 sessions, 7 weeks, 2 months
HOURLY = random_walk(
    "bars.csv",
    HOURLY_START + HOURLY_STEP * np.arange(1000, dtype=np.float64),
    seed=42,
    drift_sd=0.05,
    ret_sd=0.006,
    wick_sd=0.25,
)


def weekdays(start: str, end: str) -> np.ndarray:
    """UTC midnight of every Monday..Friday in [start, end)."""
    days = np.arange(np.datetime64(start, "D"), np.datetime64(end, "D"))
    days = days[np.is_busday(days)]
    return days.astype("datetime64[s]").astype(np.int64).astype(np.float64)


# 2019-01-02 (Wednesday) .. 2024-12-31: ~1565 weekday bars over 6 calendar years.
DAILY = random_walk(
    "bars-daily.csv",
    weekdays("2019-01-02", "2025-01-01"),
    seed=6,
    drift_sd=0.1,
    ret_sd=0.015,
    wick_sd=0.6,
)

# Default series as module-level arrays (most cases use these).
N = HOURLY.n
T, O, H, L, C, V = HOURLY.time, HOURLY.open, HOURLY.high, HOURLY.low, HOURLY.close, HOURLY.volume
HL2 = HOURLY.hl2
HLC3 = HOURLY.hlc3


# ----------------------------------------------------- textbook primitives


def nans(n: int = N) -> np.ndarray:
    return np.full(n, NAN)


def first_valid(x: np.ndarray) -> int:
    idx = np.flatnonzero(~np.isnan(x))
    return int(idx[0]) if len(idx) else len(x)


def windowed(x: np.ndarray, n: int, fn) -> np.ndarray:
    """fn(window) for every full window after the leading NaNs."""
    out = nans(len(x))
    s = first_valid(x)
    for i in range(s + n - 1, len(x)):
        w = x[i - n + 1 : i + 1]
        assert not np.isnan(w).any(), "unexpected NaN inside a window"
        out[i] = fn(w)
    return out


def sma(x, n):
    return windowed(x, n, np.mean)


def wsum(x, n):
    return windowed(x, n, np.sum)


def stdev(x, n):
    return windowed(x, n, lambda w: np.sqrt(np.mean((w - w.mean()) ** 2)))


def mean_dev(x, n):
    return windowed(x, n, lambda w: np.mean(np.abs(w - w.mean())))


def highest(x, n):
    return windowed(x, n, np.max)


def lowest(x, n):
    return windowed(x, n, np.min)


def wma(x, n):
    weights = np.arange(1, n + 1, dtype=np.float64)
    return windowed(x, n, lambda w: np.dot(w, weights) / weights.sum())


def smoothed(x, n, alpha):
    """Exponential smoothing seeded with the SMA of the first n values."""
    out = nans(len(x))
    s = first_valid(x)
    if s + n - 1 >= len(x):
        return out
    prev = np.mean(x[s : s + n])
    out[s + n - 1] = prev
    for i in range(s + n, len(x)):
        prev = alpha * x[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def ema(x, n):
    return smoothed(x, n, 2 / (n + 1))


def rma(x, n):
    return smoothed(x, n, 1 / n)


def vwma(x, v, n):
    return wsum(x * v, n) / wsum(v, n)


def change(x):
    out = nans(len(x))
    out[1:] = x[1:] - x[:-1]
    return out


def shift1(x):
    return np.concatenate([[NAN], x[:-1]])


def true_range(handle_na: bool, bars: Bars = HOURLY):
    h, l, c = bars.high, bars.low, bars.close
    pc = shift1(c)
    tr = np.maximum(np.maximum(h - l, np.abs(h - pc)), np.abs(l - pc))
    tr[0] = h[0] - l[0] if handle_na else NAN
    return tr


def ma_by_type(kind, x, n, v=None):
    if kind == "VWMA":
        return vwma(x, V if v is None else v, n)
    return {"SMA": sma, "EMA": ema, "SMMA (RMA)": rma, "WMA": wma}[kind](x, n)


def rsi_np(x, n):
    ch = change(x)
    up = rma(np.maximum(ch, 0), n)  # np.maximum keeps NaN
    down = rma(-np.minimum(ch, 0), n)
    out = nans(len(x))
    for i in range(len(x)):
        u, d = up[i], down[i]
        if np.isnan(u) or np.isnan(d):
            continue
        out[i] = 100.0 if d == 0 else 0.0 if u == 0 else 100 - 100 / (1 + u / d)
    return out


def stoch_np(x, hi, lo, n):
    hh, ll = highest(hi, n), lowest(lo, n)
    return 100 * (x - ll) / (hh - ll)


# --------------------------------------------------------- cross checks


def cross_check(name, ours, ref, start):
    """numpy reference vs TA-Lib from index `start` on (where they must agree)."""
    a, b = ours[start:], ref[start:]
    ok = np.allclose(a, b, rtol=1e-9, atol=1e-9, equal_nan=True)
    assert ok, f"{name}: numpy and TA-Lib disagree after index {start}"


# --------------------------------------------------------------- cases


@dataclass
class Case:
    """One golden CSV `<name>.csv`: inputs, reference kind and expected outputs.

    `outputs` keys are output ids (`<id>.color` = palette index) with one value
    per bar of `bars`. `extra` is a second series aligned to `bars`. `fund` is
    the statements fixture JSON the case needs (see golden_financials.py).
    """

    name: str
    inputs: dict
    ref: str
    outputs: dict[str, np.ndarray]
    bars: Bars = HOURLY
    extra: Bars | None = None
    fund: str | None = None


class Cases:
    """Collector used by the golden modules: `cases.add(...)`, return `cases.items`."""

    def __init__(self) -> None:
        self.items: list[Case] = []

    def add(
        self,
        name,
        inputs,
        ref,
        outputs,
        bars: Bars = HOURLY,
        extra: Bars | None = None,
        fund: str | None = None,
    ):
        for k, v in outputs.items():
            assert len(v) == bars.n, f"{name}.{k}: {len(v)} values for {bars.n} bars"
        if extra is not None:
            assert extra.n == bars.n and (extra.time == bars.time).all(), f"{name}: extra not aligned"
        self.items.append(Case(name, inputs, ref, outputs, bars, extra, fund))


# --------------------------------------------------------------- output


def cell(x: float) -> str:
    return "" if math.isnan(x) else repr(float(x))


def write_csv(path: Path, header: str | None, time: np.ndarray, cols: dict[str, np.ndarray]):
    lines = [] if header is None else [header]
    lines.append(",".join(["time", *cols]))
    for i in range(len(time)):
        row = [repr(float(time[i]))]
        for k, v in cols.items():
            row.append(str(int(v[i])) if k.endswith(".color") else cell(v[i]))
        lines.append(",".join(row))
    path.write_text("\n".join(lines) + "\n")
