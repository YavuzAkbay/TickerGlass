"""Golden cases for the volume group (Phase 12, batch B5): src/builtins/groups/volume.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.
"""

from __future__ import annotations

import numpy as np
import talib

from golden_common import (
    C,
    DAILY,
    H,
    HL2,
    HLC3,
    HOURLY,
    L,
    V,
    Bars,
    Case,
    Cases,
    change,
    cross_check,
    ema,
    nans,
    shift1,
    sma,
    wsum,
)


def mfv(h, l, c, v):
    """Money flow volume: close location value * volume, 0 without range."""
    rng = h - l
    flat = (rng == 0) | ((c == h) & (c == l))
    clv = np.where(flat, 0.0, (2 * c - l - h) / np.where(flat, 1.0, rng))
    return clv * v


def accdist():
    return np.cumsum(mfv(H, L, C, V))


def chaikin_osc(fast, slow):
    ad = accdist()
    return ema(ad, fast) - ema(ad, slow)


def eom(n, div):
    return sma(div * change(HL2) * (H - L) / V, n)


def klinger(fast, slow, sig):
    ch = change(HLC3)
    sv = np.where(ch >= 0, V, -V)  # NaN >= 0 is False: bar 0 is -volume
    kvo = ema(sv, fast) - ema(sv, slow)
    return kvo, ema(kvo, sig)


def net_volume(src):
    ch = change(src)
    return np.where(ch > 0, V, np.where(ch < 0, -V, 0.0))


def pvt(src):
    out = nans()
    out[1:] = np.cumsum(change(src)[1:] / shift1(src)[1:] * V[1:])
    return out


def volume_osc(short, long):
    s, lo = ema(V, short), ema(V, long)
    return 100 * (s - lo) / lo


def relative_volume(bars: Bars, n, cumulative, daily):
    """Bar offset k within the UTC day (every bar on daily bars); previous
    sessions with fewer bars contribute their last bar."""
    t, v = bars.time, bars.volume
    key = np.arange(bars.n) if daily else np.floor(t / 86400)
    starts = [i for i in range(bars.n) if i == 0 or key[i] != key[i - 1]]
    bounds = list(zip(starts, starts[1:] + [bars.n]))
    out = nans(bars.n)
    for p, (s, e) in enumerate(bounds):
        if p < n:
            continue
        prev = bounds[p - n : p]
        for i in range(s, e):
            k = i - s
            vals = []
            for ps, pe in prev:
                at = min(ps + k, pe - 1)
                vals.append(v[ps : at + 1].sum() if cumulative else v[at])
            cur = v[s : i + 1].sum() if cumulative else v[i]
            out[i] = cur / np.mean(vals)
    return out


def cases() -> list[Case]:
    out = Cases()

    out.add("accdist", {}, "talib", {"ad": talib.AD(H, L, C, V)})
    assert np.allclose(accdist(), talib.AD(H, L, C, V), rtol=1e-9, atol=1e-6)

    flow = mfv(H, L, C, V)
    out.add("cmf", {}, "numpy", {"cmf": wsum(flow, 20) / wsum(V, 20)})
    out.add("cmf-10", {"length": 10}, "numpy", {"cmf": wsum(flow, 10) / wsum(V, 10)})

    out.add("chaikin-osc", {}, "numpy", {"osc": chaikin_osc(3, 10)})
    out.add("chaikin-osc-5-20", {"fast": 5, "slow": 20}, "numpy", {"osc": chaikin_osc(5, 20)})
    # TA-Lib ADOSC seeds its EMAs with the first A/D value; converges after warm-up.
    cross_check("chaikin-osc", chaikin_osc(3, 10), talib.ADOSC(H, L, C, V, 3, 10), 300)

    out.add("eom", {}, "numpy", {"eom": eom(14, 10000)})
    out.add("eom-7", {"length": 7, "divisor": 100}, "numpy", {"eom": eom(7, 100)})

    kvo, sig = klinger(34, 55, 13)
    out.add("klinger", {}, "numpy", {"kvo": kvo, "signal": sig})
    kvo, sig = klinger(10, 20, 5)
    out.add(
        "klinger-10-20-5", {"fast": 10, "slow": 20, "signal": 5}, "numpy", {"kvo": kvo, "signal": sig}
    )

    out.add("net-volume", {}, "numpy", {"nv": net_volume(C)})
    out.add("net-volume-hl2", {"source": "hl2"}, "numpy", {"nv": net_volume(HL2)})

    out.add("pvt", {}, "numpy", {"pvt": pvt(C)})
    out.add("pvt-hlc3", {"source": "hlc3"}, "numpy", {"pvt": pvt(HLC3)})

    out.add("volume-osc", {}, "numpy", {"osc": volume_osc(5, 10)})
    out.add("volume-osc-3-20", {"short": 3, "long": 20}, "numpy", {"osc": volume_osc(3, 20)})

    out.add(
        "relative-volume",
        {},
        "numpy",
        {"rvol": relative_volume(HOURLY, 10, True, False)},
    )
    out.add(
        "relative-volume-regular",
        {"length": 5, "mode": "Regular"},
        "numpy",
        {"rvol": relative_volume(HOURLY, 5, False, False)},
    )
    daily = relative_volume(DAILY, 10, True, True)
    dv = DAILY.volume
    assert np.allclose(daily[10:], dv[10:] / sma(shift1(dv), 10)[10:], rtol=1e-12)
    out.add("relative-volume-daily", {}, "numpy", {"rvol": daily}, bars=DAILY)
    out.add(
        "relative-volume-daily-regular",
        {"length": 20, "mode": "Regular"},
        "numpy",
        {"rvol": relative_volume(DAILY, 20, False, True)},
        bars=DAILY,
    )

    return out.items
