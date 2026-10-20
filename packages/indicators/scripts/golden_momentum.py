"""Golden cases for the momentum group (Phase 12, batch B3): src/builtins/groups/momentum.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.
"""

from __future__ import annotations

import numpy as np
import talib

from golden_common import (
    DAILY,
    HL2,
    HLC3,
    NAN,
    C,
    Case,
    Cases,
    H,
    L,
    change,
    cross_check,
    ema,
    highest,
    lowest,
    nans,
    shift1,
    sma,
    wma,
    wsum,
)


def shift(x, n):
    """x[n] (n bars back), NaN before."""
    out = nans(len(x))
    out[n:] = x[: len(x) - n]
    return out


def roc_np(x, n):
    base = shift(x, n)
    return 100 * (x - base) / base


def ultosc_np(h, l, c, lengths):
    pc = shift1(c)
    lo = np.minimum(l, pc)  # NaN on bar 0
    hi = np.maximum(h, pc)
    bp, tr = c - lo, hi - lo
    a = [wsum(bp, n) / wsum(tr, n) for n in lengths]
    return 100 * (4 * a[0] + 2 * a[1] + a[2]) / 7


def ergodic_np(c, long, short):
    pc = change(c)
    return ema(ema(pc, long), short) / ema(ema(np.abs(pc), long), short)


def ao_color(x):
    diff = x - shift1(x)
    with np.errstate(invalid="ignore"):
        return np.where(diff <= 0, 1, 0).astype(np.float64)  # NaN diff -> 0 (green)


def ao_np(hl2):
    return sma(hl2, 5) - sma(hl2, 34)


def fisher_np(h, l, n):
    hl2 = (h + l) / 2
    hh, ll = highest(hl2, n), lowest(hl2, n)
    fish = nans(len(h))
    value_prev = NAN
    fish_prev = NAN
    for i in range(len(h)):
        nz_v = 0.0 if np.isnan(value_prev) else value_prev
        nz_f = 0.0 if np.isnan(fish_prev) else fish_prev
        pos = NAN if np.isnan(hh[i]) or hh[i] == ll[i] else (hl2[i] - ll[i]) / (hh[i] - ll[i])
        v = 0.66 * (pos - 0.5) + 0.67 * nz_v
        if v > 0.99:
            v = 0.999
        elif v < -0.99:
            v = -0.999
        f = 0.5 * np.log((1 + v) / (1 - v)) + 0.5 * nz_f
        fish[i] = f
        value_prev, fish_prev = v, f
    return {"fisher": fish, "trigger": shift1(fish)}


def kst_np(c, rocs, smas, sig):
    k = sum((j + 1) * sma(roc_np(c, r), s) for j, (r, s) in enumerate(zip(rocs, smas)))
    return {"kst": k, "signal": sma(k, sig)}


def dpo_np(c, n, centered):
    back = n // 2 + 1
    m = sma(c, n)
    return shift(c, back) - m if centered else c - shift(m, back)


def po_np(x, short, long, exp):
    f = ema if exp else sma
    s, l_ = f(x, short), f(x, long)
    return 100 * (s - l_) / l_


def cases() -> list[Case]:
    out = Cases()

    # Momentum / ROC: TA-Lib matches including warm-up.
    out.add("momentum", {}, "talib", {"mom": talib.MOM(C, 10)})
    out.add("momentum-hlc3-20", {"length": 20, "source": "hlc3"}, "talib", {"mom": talib.MOM(HLC3, 20)})
    cross_check("momentum", C - shift(C, 10), talib.MOM(C, 10), 0)
    out.add("roc", {}, "talib", {"roc": talib.ROC(C, 9)})
    out.add("roc-daily", {"length": 20}, "talib", {"roc": talib.ROC(DAILY.close, 20)}, bars=DAILY)
    cross_check("roc", roc_np(C, 9), talib.ROC(C, 9), 0)

    # TRIX: 10000 * change of the triple EMA of ln(close). TA-Lib TRIX is
    # the 1-bar ROC of the triple EMA of close (no log), so only the EMA chain
    # is cross-checked.
    for n, name in ((18, "trix"), (9, "trix-9")):
        e3 = ema(ema(ema(np.log(C), n), n), n)
        out.add(name, {} if n == 18 else {"length": n}, "numpy", {"trix": 10000 * change(e3)})
        lc = np.log(C)
        cross_check(name, e3, talib.EMA(talib.EMA(talib.EMA(lc, n), n), n), 0)

    # TSI
    for name, inputs, (lo, sh, sg) in (
        ("tsi", {}, (25, 13, 13)),
        ("tsi-daily", {"long": 40, "short": 20, "signal": 7}, (40, 20, 7)),
    ):
        bars_c = DAILY.close if name.endswith("daily") else C
        t = 100 * ergodic_np(bars_c, lo, sh)
        kw = {"bars": DAILY} if name.endswith("daily") else {}
        out.add(name, inputs, "numpy", {"tsi": t, "signal": ema(t, sg)}, **kw)

    # Ultimate Oscillator: TA-Lib ULTOSC matches warm-up (first value at bar
    # slow) for ascending lengths; it sorts the lengths, other platforms do not, so the
    # unsorted variant is numpy only.
    uo = talib.ULTOSC(H, L, C, 7, 14, 28)
    cross_check("ultimate-osc", ultosc_np(H, L, C, (7, 14, 28)), uo, 0)
    out.add("ultimate-osc", {}, "talib", {"uo": uo})
    out.add(
        "ultimate-osc-unsorted",
        {"fast": 20, "middle": 5, "slow": 10},
        "numpy",
        {"uo": ultosc_np(H, L, C, (20, 5, 10))},
    )

    # Awesome / Accelerator: columns coloured by the bar-to-bar change.
    ao = ao_np(HL2)
    out.add("awesome-osc", {}, "numpy", {"ao": ao, "ao.color": ao_color(ao)})
    ac = ao - sma(ao, 5)
    out.add("accelerator-osc", {}, "numpy", {"ac": ac, "ac.color": ao_color(ac)})
    dao = ao_np(DAILY.hl2)
    dac = dao - sma(dao, 5)
    out.add("accelerator-osc-daily", {}, "numpy", {"ac": dac, "ac.color": ao_color(dac)}, bars=DAILY)

    # Coppock
    out.add("coppock", {}, "numpy", {"coppock": wma(roc_np(C, 14) + roc_np(C, 11), 10)})
    out.add(
        "coppock-daily",
        {"wmaLength": 5, "longRoc": 20, "shortRoc": 8},
        "numpy",
        {"coppock": wma(roc_np(DAILY.close, 20) + roc_np(DAILY.close, 8), 5)},
        bars=DAILY,
    )

    # KST
    out.add("kst", {}, "numpy", kst_np(C, (10, 15, 20, 30), (10, 10, 10, 15), 9))
    out.add(
        "kst-short",
        {"roc1": 5, "roc2": 8, "roc3": 11, "roc4": 15, "sma1": 4, "sma2": 5, "sma3": 6, "sma4": 7, "signal": 4},
        "numpy",
        kst_np(C, (5, 8, 11, 15), (4, 5, 6, 7), 4),
    )

    # DPO (barsback = floor(period / 2) + 1)
    out.add("dpo", {}, "numpy", {"dpo": dpo_np(C, 21, False)})
    out.add("dpo-centered", {"centered": True}, "numpy", {"dpo": dpo_np(C, 21, True)})
    out.add("dpo-centered-20", {"length": 20, "centered": True}, "numpy", {"dpo": dpo_np(C, 20, True)})

    # Price Oscillator
    out.add("price-oscillator", {}, "numpy", {"po": po_np(C, 10, 21, False)})
    out.add(
        "price-oscillator-exp",
        {"exponential": True, "short": 12, "long": 26, "source": "hl2"},
        "numpy",
        {"po": po_np(HL2, 12, 26, True)},
    )

    # SMI Ergodic / Histogram (unscaled TSI)
    erg = ergodic_np(C, 20, 5)
    sig = ema(erg, 5)
    out.add("smi-ergodic", {}, "numpy", {"smi": erg, "signal": sig})
    out.add("smi-ergodic-osc", {}, "numpy", {"osc": erg - sig})
    erg2 = ergodic_np(C, 13, 3)
    out.add(
        "smi-ergodic-osc-13",
        {"long": 13, "short": 3, "signal": 8},
        "numpy",
        {"osc": erg2 - ema(erg2, 8)},
    )

    # Fisher Transform
    out.add("fisher", {}, "numpy", fisher_np(H, L, 9))
    out.add("fisher-daily", {"length": 20}, "numpy", fisher_np(DAILY.high, DAILY.low, 20), bars=DAILY)

    return out.items
