"""Golden cases for the volatility group (Phase 12, batch B4): src/builtins/groups/volatility.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.

The group also holds the second momentum set (Connors RSI .. Balance of Power).
"""

from __future__ import annotations

import numpy as np
import talib

from golden_common import (
    DAILY,
    HL2,
    HOURLY,
    NAN,
    C,
    Case,
    Cases,
    H,
    L,
    O,
    V,
    change,
    ema,
    highest,
    lowest,
    nans,
    rsi_np,
    shift1,
    sma,
    stdev,
    true_range,
    windowed,
    wsum,
)


def shift(x, n):
    """x[n] (n bars back), NaN before."""
    out = nans(len(x))
    out[n:] = x[: len(x) - n]
    return out


def div(a, b):
    """a / b with a zero denominator -> NaN (standard)."""
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(b == 0, NAN, a / b)


def swma(x):
    return windowed(x, 4, lambda w: (w[0] + 2 * w[1] + 2 * w[2] + w[3]) / 6)


def percentrank(x, n):
    """Share (percent) of the previous n values <= the current one."""
    out = nans(len(x))
    for i in range(n, len(x)):
        w = x[i - n : i + 1]
        if np.isnan(w).any():
            continue
        out[i] = 100 * np.count_nonzero(w[:-1] <= w[-1]) / n
    return out


# ------------------------------------------------------------- momentum


def updown(x):
    """standard Connors streak: comparisons with NaN are false (bar 0 -> -1)."""
    ud = nans(len(x))
    prev_ud = NAN
    for i in range(len(x)):
        prev = x[i - 1] if i > 0 else NAN
        p = 0.0 if np.isnan(prev_ud) else prev_ud
        if x[i] == prev:
            u = 0.0
        elif x[i] > prev:
            u = 1.0 if p <= 0 else p + 1
        else:
            u = -1.0 if p >= 0 else p - 1
        ud[i] = prev_ud = u
    return ud


def connors_rsi(x, rsi_len, ud_len, roc_len):
    roc1 = 100 * (x - shift1(x)) / shift1(x)
    return (rsi_np(x, rsi_len) + rsi_np(updown(x), ud_len) + percentrank(roc1, roc_len)) / 3


def cmo(x, n):
    m = change(x)
    s1 = wsum(np.maximum(m, 0), n)  # np.maximum keeps NaN
    s2 = wsum(np.maximum(-m, 0), n)
    return div(100 * (s1 - s2), s1 + s2)


def vortex(n):
    tr = wsum(true_range(True), n)
    plus = wsum(np.abs(H - shift1(L)), n)
    minus = wsum(np.abs(L - shift1(H)), n)
    return div(plus, tr), div(minus, tr)


def chop(n):
    tr = wsum(true_range(True), n)
    rng = highest(H, n) - lowest(L, n)
    return 100 * np.log10(div(tr, rng)) / np.log10(n)


def rvi(n):
    r = div(wsum(swma(C - O), n), wsum(swma(H - L), n))
    return r, swma(r)


# ----------------------------------------------------------- volatility


def hv(bars, n, per):
    c = bars.close
    return 100 * stdev(np.log(c / shift1(c)), n) * np.sqrt(365 / per)


def chaikin_vol(ema_len, roc_len):
    e = ema(H - L, ema_len)
    old = shift(e, roc_len)
    return div(100 * (e - old), old)


def ulcer(x, n):
    h = highest(x, n)
    dd = div(100 * (x - h), h)
    return np.sqrt(sma(dd * dd, n))


def bbands(x, n, mult):
    upper, basis, lower = talib.BBANDS(x, timeperiod=n, nbdevup=mult, nbdevdn=mult, matype=0)
    return upper, basis, lower


def mass_index(n):
    e1 = ema(H - L, 9)
    e2 = ema(e1, 9)
    return wsum(div(e1, e2), n)


def rvol_index(x, n, smooth):
    s = stdev(x, n)
    ch = change(x)
    valid = ~np.isnan(s)
    up = ema(np.where(valid, np.where(ch <= 0, 0.0, s), NAN), smooth)
    dn = ema(np.where(valid, np.where(ch > 0, 0.0, s), NAN), smooth)
    return div(100 * up, up + dn)


def cases() -> list[Case]:
    out = Cases()

    # Momentum (second set).
    out.add("connors-rsi", {}, "numpy", {"crsi": connors_rsi(C, 3, 2, 100)})
    out.add(
        "connors-rsi-short",
        {"rsiLength": 5, "upDownLength": 3, "rocLength": 20, "source": "hl2"},
        "numpy",
        {"crsi": connors_rsi(HL2, 5, 3, 20)},
    )
    out.add("cmo", {}, "numpy", {"cmo": cmo(C, 9)})
    out.add("cmo-20", {"length": 20, "source": "hl2"}, "numpy", {"cmo": cmo(HL2, 20)})
    for n in (14, 25):
        down, up = talib.AROON(H, L, timeperiod=n)
        out.add("aroon" if n == 14 else f"aroon-{n}", {"length": n}, "talib", {"up": up, "down": down})
    plus, minus = vortex(14)
    out.add("vortex", {}, "numpy", {"plus": plus, "minus": minus})
    out.add("chop", {}, "numpy", {"chop": chop(14)})
    out.add("chop-30", {"length": 30}, "numpy", {"chop": chop(30)})
    r, sig = rvi(10)
    out.add("rvi", {}, "numpy", {"rvi": r, "signal": sig})
    out.add("efi", {}, "numpy", {"efi": ema(change(C) * V, 13)})
    out.add("bop", {}, "numpy", {"bop": div(C - O, H - L)})

    # Volatility.
    out.add("hv", {}, "numpy", {"hv": hv(HOURLY, 10, 1)})
    out.add("hv-daily", {"length": 20}, "numpy", {"hv": hv(DAILY, 20, 1)}, bars=DAILY)
    out.add("chaikin-volatility", {}, "numpy", {"cv": chaikin_vol(10, 10)})
    out.add(
        "chaikin-volatility-alt",
        {"emaLength": 14, "rocLength": 7},
        "numpy",
        {"cv": chaikin_vol(14, 7)},
    )
    out.add("ulcer", {}, "numpy", {"ulcer": ulcer(C, 14)})
    upper, basis, lower = bbands(C, 20, 2)
    out.add("bb-percent-b", {}, "talib", {"pb": div(C - lower, upper - lower)})
    upper3, _, lower3 = bbands(HL2, 10, 1.5)
    out.add(
        "bb-percent-b-alt",
        {"length": 10, "mult": 1.5, "source": "hl2"},
        "talib",
        {"pb": div(HL2 - lower3, upper3 - lower3)},
    )
    bbw = 100 * (upper - lower) / basis
    out.add(
        "bb-width",
        {},
        "talib",
        {"bbw": bbw, "exp": highest(bbw, 125), "con": lowest(bbw, 125)},
    )
    out.add(
        "bb-width-alt",
        {"expansionLength": 50, "contractionLength": 80},
        "talib",
        {"bbw": bbw, "exp": highest(bbw, 50), "con": lowest(bbw, 80)},
    )
    out.add("stdev", {}, "talib", {"sd": talib.STDDEV(C, timeperiod=20, nbdev=1)})
    out.add(
        "stdev-hl2",
        {"length": 7, "source": "hl2"},
        "talib",
        {"sd": talib.STDDEV(HL2, timeperiod=7, nbdev=1)},
    )
    out.add("mass-index", {}, "numpy", {"mi": mass_index(10)})
    out.add("rvol-index", {}, "numpy", {"rvi": rvol_index(C, 10, 14)})
    return out.items
