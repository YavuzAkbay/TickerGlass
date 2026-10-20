"""Golden cases for the trend-ma group (Phase 12, batch B2): src/builtins/groups/trend-ma.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.

TA-Lib where it matches including the warm-up (DEMA, TEMA, LINEARREG);
numpy ports otherwise. KAMA: TA-Lib seeds from the previous value instead of
starting at the source, so the alpha recurrence is checked against TA-Lib with
its seeding (exact) and our KAMA must converge to it later.
"""

from __future__ import annotations

import numpy as np
import talib

from golden_common import (
    HL2,
    HLC3,
    HOURLY,
    C,
    Bars,
    Case,
    Cases,
    V,
    cross_check,
    ema,
    first_valid,
    ma_by_type,
    nans,
    rma,
    sma,
    windowed,
)


def alma(x, n, offset, sigma):
    m = offset * (n - 1)
    s = n / sigma
    k = np.arange(n, dtype=np.float64)
    w = np.exp(-((k - m) ** 2) / (2 * s * s))  # k = 0 oldest = window[0]
    return windowed(x, n, lambda win: np.dot(win, w) / w.sum())


def kama(x, n, fast, slow, talib_seed=False):
    """KAMA; `talib_seed` starts from x[n-1] like TA-Lib instead of x[n]."""
    fa, sa = 2 / (fast + 1), 2 / (slow + 1)
    out = nans(len(x))
    prev = np.nan
    for i in range(n, len(x)):
        mom = abs(x[i] - x[i - n])
        vol = np.sum(np.abs(np.diff(x[i - n : i + 1])))
        er = mom / vol if vol != 0 else 0.0
        alpha = (er * (fa - sa) + sa) ** 2
        if np.isnan(prev):
            prev = x[i - 1] if talib_seed else x[i]
        prev = alpha * x[i] + (1 - alpha) * prev
        out[i] = prev
    return out


def linreg(x, n, offset):
    xs = np.arange(n, dtype=np.float64)

    def fit(w):
        b, a = np.polyfit(xs, w, 1)
        return a + b * (n - 1 - offset)

    return windowed(x, n, fit)


def mcginley(x, n):
    seed = sma(x, n)
    out = nans(len(x))
    s = first_valid(seed)
    mg = seed[s]
    out[s] = mg
    for i in range(s + 1, len(x)):
        mg = mg + (x[i] - mg) / (n * (x[i] / mg) ** 4)
        out[i] = mg
    return out


# Hourly bars on a 0.25 price grid: equal highs/lows are common, so the
# fractal "frontier" branches that allow equal bars before the centre are hit.
COARSE = Bars(
    "bars-coarse.csv",
    HOURLY.time,
    *(np.round(a * 4) / 4 for a in (HOURLY.open, HOURLY.high, HOURLY.low, HOURLY.close)),
    HOURLY.volume,
)


def fractals(n, bars=HOURLY, max_eq=4):
    """Williams Fractals (5-bar definition); values = fractal bar high/low on the confirming bar.

    `max_eq` < 4 drops frontier branches (only to assert the full test uses them).
    """
    H, L = bars.high, bars.low

    def at(a, i, k):
        return a[i - k] if i >= k else np.nan

    def test(a, i, beyond, level):
        c = at(a, i, n)
        if not all(beyond(c, at(a, i, n - k)) for k in range(1, n + 1)):
            return False
        for eq in range(max_eq + 1):
            prefix = all(level(c, at(a, i, n + e)) for e in range(1, eq + 1))
            if prefix and all(beyond(c, at(a, i, n + eq + k)) for k in range(1, n + 1)):
                return True
        return False

    up, down = nans(bars.n), nans(bars.n)
    for i in range(bars.n):
        if test(H, i, lambda a, b: a > b, lambda a, b: a >= b):
            up[i] = H[i - n]
        if test(L, i, lambda a, b: a < b, lambda a, b: a <= b):
            down[i] = L[i - n]
    return up, down


def envelopes(x, n, pct, exponential):
    basis = ema(x, n) if exponential else sma(x, n)
    k = pct / 100
    return {"basis": basis, "upper": basis * (1 + k), "lower": basis * (1 - k)}


def source(name):
    return {"close": C, "hl2": HL2, "hlc3": HLC3}[name]


def cases() -> list[Case]:
    out = Cases()
    case = out.add

    case("smma", {}, "numpy", {"smma": rma(C, 7)})
    case("smma-hl2-14", {"length": 14, "source": "hl2"}, "numpy", {"smma": rma(HL2, 14)})

    case("dema", {}, "talib", {"dema": talib.DEMA(C, 9)})
    case("dema-hlc3-20", {"length": 20, "source": "hlc3"}, "talib", {"dema": talib.DEMA(HLC3, 20)})
    e1 = ema(C, 9)
    cross_check("dema", 2 * e1 - ema(e1, 9), talib.DEMA(C, 9), 0)

    case("tema", {}, "talib", {"tema": talib.TEMA(C, 9)})
    case("tema-30", {"length": 30}, "talib", {"tema": talib.TEMA(C, 30)})
    e1 = ema(C, 9)
    e2 = ema(e1, 9)
    cross_check("tema", 3 * e1 - 3 * e2 + ema(e2, 9), talib.TEMA(C, 9), 0)

    case("alma", {}, "numpy", {"alma": alma(C, 9, 0.85, 6)})
    case(
        "alma-centered",
        {"length": 21, "offset": 0.5, "sigma": 4, "source": "hl2"},
        "numpy",
        {"alma": alma(HL2, 21, 0.5, 4)},
    )

    case("kama", {}, "numpy", {"kama": kama(C, 10, 2, 30)})
    case(
        "kama-fast",
        {"length": 14, "fast": 3, "slow": 20},
        "numpy",
        {"kama": kama(C, 14, 3, 20)},
    )
    # Same efficiency ratio / alpha as TA-Lib (exact with its seeding) ...
    cross_check("kama-talib-seed", kama(C, 10, 2, 30, True), talib.KAMA(C, 10), 0)
    # ... and the seeding difference has decayed by the end of the series.
    cross_check("kama", kama(C, 10, 2, 30), talib.KAMA(C, 10), 600)

    case("lsma", {}, "talib", {"lsma": talib.LINEARREG(C, 25)})
    cross_check("lsma", linreg(C, 25, 0), talib.LINEARREG(C, 25), 0)
    case(
        "lsma-offset",
        {"length": 14, "offset": 3, "source": "hlc3"},
        "numpy",
        {"lsma": linreg(HLC3, 14, 3)},
    )
    case("lsma-offset-neg", {"offset": -2}, "numpy", {"lsma": linreg(C, 25, -2)})

    case("mcginley", {}, "numpy", {"mg": mcginley(C, 14)})
    case("mcginley-hl2-30", {"length": 30, "source": "hl2"}, "numpy", {"mg": mcginley(HL2, 30)})

    case("ma-ribbon", {}, "numpy", {f"ma{k}": sma(C, n) for k, n in enumerate((20, 50, 100, 200), 1)})
    mix = [("EMA", "close", 10), ("WMA", "hl2", 30), ("SMMA (RMA)", "close", 60), ("VWMA", "hlc3", 120)]
    inputs, outputs = {}, {}
    for k, (kind, src, n) in enumerate(mix, 1):
        inputs.update({f"type{k}": kind, f"source{k}": src, f"length{k}": n})
        outputs[f"ma{k}"] = ma_by_type(kind, source(src), n, V)
    case("ma-ribbon-mix", inputs, "numpy", outputs)
    mix = [("EMA", 20), ("EMA", 50), ("WMA", 100), ("WMA", 200)]
    inputs, outputs = {}, {}
    for k, (kind, n) in enumerate(mix, 1):
        inputs[f"type{k}"] = kind
        outputs[f"ma{k}"] = ma_by_type(kind, C, n)
    case("ma-ribbon-ema-wma", inputs, "numpy", outputs)

    case("envelopes", {}, "numpy", envelopes(C, 20, 10, False))
    case(
        "envelopes-exp",
        {"length": 10, "percent": 2.5, "exponential": True},
        "numpy",
        envelopes(C, 10, 2.5, True),
    )

    case("alligator", {}, "numpy", {"jaw": rma(HL2, 13), "teeth": rma(HL2, 8), "lips": rma(HL2, 5)})
    case(
        "alligator-close",
        {"jawLength": 21, "teethLength": 13, "lipsLength": 8, "jawOffset": 0, "source": "close"},
        "numpy",
        {"jaw": rma(C, 21), "teeth": rma(C, 13), "lips": rma(C, 8)},
    )

    up, down = fractals(2)
    assert np.isfinite(up).sum() > 20 and np.isfinite(down).sum() > 20
    case("fractals", {}, "numpy", {"up": up, "down": down})
    up, down = fractals(3)
    case("fractals-3", {"periods": 3}, "numpy", {"up": up, "down": down})
    up, down = fractals(2, COARSE)
    strict_up, strict_down = fractals(2, COARSE, max_eq=0)
    assert not np.array_equal(up, strict_up, equal_nan=True)
    assert not np.array_equal(down, strict_down, equal_nan=True)
    case("fractals-equal", {}, "numpy", {"up": up, "down": down}, bars=COARSE)

    case("median-price", {}, "numpy", {"mp": HL2})
    case("typical-price", {}, "numpy", {"tp": HLC3})
    return out.items
