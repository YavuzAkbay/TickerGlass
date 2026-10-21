"""Golden cases for the external group (Phase 12, batch B7): src/builtins/groups/external.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.

External symbol series: `bars-ext.csv` (seeded random walk on the hourly
times) and `bars-ext-gaps.csv` (the same with a few bars missing, as NaN rows).
"""

from __future__ import annotations

import numpy as np
import talib

from golden_common import C, HLC3, HOURLY, T, Bars, Case, Cases, nans, random_walk


def window_corr(x: np.ndarray, y: np.ndarray, n: int) -> np.ndarray:
    """Pearson correlation over the last n bars; NaN when any value in the window is NaN."""
    out = nans(len(x))
    for i in range(n - 1, len(x)):
        a, b = x[i - n + 1 : i + 1], y[i - n + 1 : i + 1]
        if np.isnan(a).any() or np.isnan(b).any():
            continue
        out[i] = np.corrcoef(a, b)[0, 1]
    return out


def cases() -> list[Case]:
    out = Cases()
    ext = random_walk("bars-ext.csv", T, seed=7, drift_sd=0.04, ret_sd=0.005, wick_sd=0.2)
    gaps = Bars(
        "bars-ext-gaps.csv",
        ext.time,
        *[a.copy() for a in (ext.open, ext.high, ext.low, ext.close, ext.volume)],
    )
    for a in (gaps.open, gaps.high, gaps.low, gaps.close, gaps.volume):
        a[[300, 301, 640]] = np.nan

    out.add(
        "correlation",
        {"symbol": "GOOG", "source": "close", "length": 20},
        "talib",
        {"cc": talib.CORREL(C, ext.close, timeperiod=20)},
        extra=ext,
    )
    out.add(
        "correlation-hlc3",
        {"symbol": "GOOG", "source": "hlc3", "length": 7},
        "talib",
        {"cc": talib.CORREL(HLC3, ext.hlc3, timeperiod=7)},
        extra=ext,
    )
    out.add(
        "correlation-gaps",
        {"symbol": "GOOG", "source": "close", "length": 12},
        "numpy",
        {"cc": window_corr(C, gaps.close, 12)},
        extra=gaps,
    )
    return out.items
