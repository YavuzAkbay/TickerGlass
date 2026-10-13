"""Reference CSVs for the indicator golden tests (packages/indicators/test/golden).

Run from the repo root without touching the API project:

    uv run --no-project --python 3.11 --with ta-lib --with pandas --with numpy \
        packages/indicators/scripts/golden.py

Writes `bars.csv` (1000 seeded random-walk hourly OHLCV bars) and one
`<id>[-<variant>].csv` per case: first line `# inputs: {json} ref: talib|numpy`,
then `time,<outputId>...` (`<outputId>.color` = palette index), empty cell = NaN,
floats as `repr`.

Target semantics are reference / standard. TA-Lib is used where its output,
including the warm-up, matches standard (SMA, EMA, WMA, RSI, Bollinger, Williams %R,
CCI, MFI). Everything else is a plain numpy port of the textbook / standard
reference formula (ref: numpy). Where TA-Lib differs only in the warm-up or
seeding, the script cross-checks the numpy reference against TA-Lib after the
point where they must agree (see `cross_check`).

Conventions mirrored from standard: warm-up is NaN; ema/rma seed with the SMA of
the first `length` values; stdev is population; leading NaNs are skipped.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import talib

OUT = Path(__file__).resolve().parent.parent / "test" / "golden"
N = 1000
START = 1704286800  # 2024-01-03 13:00 UTC (Wednesday, mid-week, mid-month)
STEP = 3600  # hourly bars: ~41 sessions, 7 weeks, 2 months
NAN = float("nan")


# ---------------------------------------------------------------- bars


def make_bars() -> dict[str, np.ndarray]:
    rng = np.random.default_rng(42)
    time = START + STEP * np.arange(N, dtype=np.float64)
    close = np.empty(N)
    open_ = np.empty(N)
    price = 100.0
    for i in range(N):
        o = price + rng.normal(0, 0.05)
        c = o * (1 + rng.normal(0, 0.006))
        open_[i] = round(o, 4)
        close[i] = round(c, 4)
        price = c
    wick_hi = np.abs(rng.normal(0, 0.25, N))
    wick_lo = np.abs(rng.normal(0, 0.25, N))
    high = np.round(np.maximum(open_, close) + wick_hi, 4)
    low = np.round(np.minimum(open_, close) - wick_lo, 4)
    volume = rng.integers(1_000, 10_000, N).astype(np.float64)
    return {"time": time, "open": open_, "high": high, "low": low, "close": close, "volume": volume}


B = make_bars()
T, O, H, L, C, V = (B[k] for k in ("time", "open", "high", "low", "close", "volume"))
HL2 = (H + L) / 2
HLC3 = (H + L + C) / 3


# ----------------------------------------------------- textbook primitives


def nans() -> np.ndarray:
    return np.full(N, NAN)


def first_valid(x: np.ndarray) -> int:
    idx = np.flatnonzero(~np.isnan(x))
    return int(idx[0]) if len(idx) else N


def windowed(x: np.ndarray, n: int, fn) -> np.ndarray:
    """fn(window) for every full window after the leading NaNs."""
    out = nans()
    s = first_valid(x)
    for i in range(s + n - 1, N):
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
    out = nans()
    s = first_valid(x)
    if s + n - 1 >= N:
        return out
    prev = np.mean(x[s : s + n])
    out[s + n - 1] = prev
    for i in range(s + n, N):
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
    out = nans()
    out[1:] = x[1:] - x[:-1]
    return out


def true_range(handle_na: bool):
    pc = np.concatenate([[NAN], C[:-1]])
    tr = np.maximum(np.maximum(H - L, np.abs(H - pc)), np.abs(L - pc))
    tr[0] = H[0] - L[0] if handle_na else NAN
    return tr


def ma_by_type(kind, x, n):
    return (
        {"SMA": sma, "EMA": ema, "SMMA (RMA)": rma, "WMA": wma}[kind](x, n)
        if kind != "VWMA"
        else vwma(x, V, n)
    )


def rsi_np(x, n):
    ch = change(x)
    up = rma(np.maximum(ch, 0), n)  # np.maximum keeps NaN
    down = rma(-np.minimum(ch, 0), n)
    out = nans()
    for i in range(N):
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


# --------------------------------------------------------- indicators

CASES: list[tuple[str, dict, str, dict[str, np.ndarray]]] = []


def case(name, inputs, ref, outputs):
    CASES.append((name, inputs, ref, outputs))


# Moving averages (TA-Lib matches standard including warm-up).
case("sma", {}, "talib", {"ma": talib.SMA(C, 9)})
case("sma-hlc3-20", {"length": 20, "source": "hlc3"}, "talib", {"ma": talib.SMA(HLC3, 20)})
case("ema", {}, "talib", {"ema": talib.EMA(C, 9)})
case("ema-50", {"length": 50}, "talib", {"ema": talib.EMA(C, 50)})
cross_check("ema", ema(C, 50), talib.EMA(C, 50), 0)
case("wma", {}, "talib", {"wma": talib.WMA(C, 9)})
cross_check("wma", wma(C, 9), talib.WMA(C, 9), 0)
case("vwma", {}, "numpy", {"vwma": vwma(C, V, 20)})


def hma(x, n):
    return wma(2 * wma(x, n // 2) - wma(x, n), math.floor(math.sqrt(n)))


case("hma", {}, "numpy", {"hma": hma(C, 9)})
case("hma-20", {"length": 20, "source": "hl2"}, "numpy", {"hma": hma(HL2, 20)})


# VWAP: standard ta.vwap, UTC session/week (Monday)/month boundaries.
def period_key(t, anchor):
    day = int(t // 86400)
    if anchor == "Session":
        return day
    if anchor == "Week":
        return (day + 3) // 7
    d = np.datetime64(int(t), "s").astype("datetime64[M]").astype(int)
    return int(d)


def vwap_np(x, starts):
    """starts[i]: bar i begins a new period (None = before the anchor)."""
    vw, sd = nans(), nans()
    sv = vv = ssv = NAN
    for i in range(N):
        if starts[i] is None:
            continue
        if starts[i]:
            sv, vv, ssv = x[i] * V[i], V[i], x[i] ** 2 * V[i]
        else:
            sv, vv, ssv = sv + x[i] * V[i], vv + V[i], ssv + x[i] ** 2 * V[i]
        vw[i] = sv / vv
        sd[i] = math.sqrt(max(ssv / vv - vw[i] ** 2, 0))
    return vw, sd


def vwap_outputs(vw, sd, mode, shows, mults):
    basis = sd if mode == "Standard Deviation" else vw * 0.01
    out = {"vwap": vw}
    for k, (show, m) in enumerate(zip(shows, mults), start=1):
        out[f"upper{k}"] = vw + basis * m if show else nans()
        out[f"lower{k}"] = vw - basis * m if show else nans()
    return out


def vwap_case(name, anchor, mode, shows, mults=(1, 2, 3)):
    keys = [period_key(t, anchor) for t in T]
    starts = [i == 0 or keys[i] != keys[i - 1] for i in range(N)]
    vw, sd = vwap_np(HLC3, starts)
    inputs = {"anchor": anchor, "bandMode": mode}
    for k, (s, m) in enumerate(zip(shows, mults), start=1):
        inputs[f"showBand{k}"] = s
        inputs[f"mult{k}"] = m
    case(name, inputs, "numpy", vwap_outputs(vw, sd, mode, shows, mults))


vwap_case("vwap", "Session", "Standard Deviation", (True, False, False))
vwap_case("vwap-week", "Week", "Standard Deviation", (True, True, True), (1, 2, 2.5))
vwap_case("vwap-month", "Month", "Percentage", (True, True, True))

anchor_t = float(T[250] + 1800)  # mid-bar: the first bar at or after it is 251
av_starts = [None if T[i] < anchor_t else (i == 251) for i in range(N)]
vw, sd = vwap_np(HLC3, av_starts)
case(
    "anchored-vwap",
    {"anchor": anchor_t, "showBand1": True, "showBand2": True, "showBand3": True},
    "numpy",
    vwap_outputs(vw, sd, "Standard Deviation", (True, True, True), (1, 2, 3)),
)
vw, sd = vwap_np(C, [i == 0 for i in range(N)])
case(
    "anchored-vwap-unset",
    {"source": "close"},
    "numpy",
    vwap_outputs(vw, sd, "Standard Deviation", (False, False, False), (1, 2, 3)),
)

# Bands
up, mid, lo = talib.BBANDS(C, 20, 2.0, 2.0, matype=0)
case("bollinger", {}, "talib", {"basis": mid, "upper": up, "lower": lo})
basis = ema(C, 10)
dev = 1.5 * stdev(C, 10)
case(
    "bollinger-ema",
    {"length": 10, "maType": "EMA", "mult": 1.5},
    "numpy",
    {"basis": basis, "upper": basis + dev, "lower": basis - dev},
)


def keltner(n, mult, use_ema, style, atr_len):
    ma = ema(C, n) if use_ema else sma(C, n)
    if style == "Average True Range":
        rng_ = rma(true_range(True), atr_len)
    elif style == "True Range":
        rng_ = true_range(True)
    else:
        rng_ = rma(H - L, n)
    return {"upper": ma + rng_ * mult, "basis": ma, "lower": ma - rng_ * mult}


case("keltner", {}, "numpy", keltner(20, 2.0, True, "Average True Range", 10))
case(
    "keltner-range",
    {"useEma": False, "bandStyle": "Range", "length": 14},
    "numpy",
    keltner(14, 2.0, False, "Range", 10),
)
case(
    "keltner-tr",
    {"bandStyle": "True Range", "mult": 1.5},
    "numpy",
    keltner(20, 1.5, True, "True Range", 10),
)

hh, ll = highest(H, 20), lowest(L, 20)
case("donchian", {}, "numpy", {"basis": (hh + ll) / 2, "upper": hh, "lower": ll})
cross_check("donchian", hh, talib.MAX(H, 20), 0)


# Ichimoku (values unshifted; offsets are display only)
def donch(n):
    return (highest(H, n) + lowest(L, n)) / 2


conv, base, span_b = donch(9), donch(26), donch(52)
span_a = (conv + base) / 2
with np.errstate(invalid="ignore"):
    cloud = np.where(span_a > span_b, 0, 1)
case(
    "ichimoku",
    {},
    "numpy",
    {
        "conversion": conv,
        "base": base,
        "lagging": C.copy(),
        "spanA": span_a,
        "spanB": span_b,
        "cloud.color": cloud.astype(np.float64),
    },
)


# Parabolic SAR: literal port of the standard ta.sar reference implementation.
def sar_pine(start, inc, mx):
    out = nans()
    result = max_min = acc = NAN
    is_below = False
    for i in range(N):
        first = False
        if i == 1:
            if C[1] > C[0]:
                is_below, max_min, result = True, H[1], L[0]
            else:
                is_below, max_min, result = False, L[1], H[0]
            first = True
            acc = start
        result = result + acc * (max_min - result)
        if is_below:
            if result > L[i]:
                first, is_below = True, False
                result = max(H[i], max_min)
                max_min, acc = L[i], start
        else:
            if result < H[i]:
                first, is_below = True, True
                result = min(L[i], max_min)
                max_min, acc = H[i], start
        if not first:
            if is_below:
                if H[i] > max_min:
                    max_min, acc = H[i], min(acc + inc, mx)
            else:
                if L[i] < max_min:
                    max_min, acc = L[i], min(acc + inc, mx)
        if i >= 1:
            if is_below:
                result = min(result, L[i - 1])
                if i > 1:
                    result = min(result, L[i - 2])
            else:
                result = max(result, H[i - 1])
                if i > 1:
                    result = max(result, H[i - 2])
        out[i] = result
    return out


case("parabolic-sar", {}, "numpy", {"sar": sar_pine(0.02, 0.02, 0.2)})
case(
    "parabolic-sar-fast",
    {"start": 0.05, "increment": 0.03, "max": 0.3},
    "numpy",
    {"sar": sar_pine(0.05, 0.03, 0.3)},
)


# Supertrend: port of the standard ta.supertrend; the built-in hides the first bar.
def supertrend_pine(factor, atr_len):
    atr = rma(true_range(True), atr_len)
    up_out, down_out, mid = nans(), nans(), nans()
    prev_lower = prev_upper = prev_st = prev_atr = NAN
    for i in range(N):
        src = HL2[i]
        lower = src - factor * atr[i]
        upper = src + factor * atr[i]
        pl = 0.0 if np.isnan(prev_lower) else prev_lower
        pu = 0.0 if np.isnan(prev_upper) else prev_upper
        pc = C[i - 1] if i > 0 else NAN
        lower = lower if (lower > pl or pc < pl) else pl
        upper = upper if (upper < pu or pc > pu) else pu
        if np.isnan(prev_atr):
            direction = 1
        elif prev_st == pu:
            direction = -1 if C[i] > upper else 1
        else:
            direction = 1 if C[i] < lower else -1
        st = lower if direction == -1 else upper
        prev_lower, prev_upper, prev_st, prev_atr = lower, upper, st, atr[i]
        if i == 0:
            continue
        if direction < 0:
            up_out[i] = st
        else:
            down_out[i] = st
        mid[i] = (O[i] + C[i]) / 2
    return {"up": up_out, "down": down_out, "middle": mid}


case("supertrend", {}, "numpy", supertrend_pine(3.0, 10))
case("supertrend-7-2", {"atrLength": 7, "factor": 2.0}, "numpy", supertrend_pine(2.0, 7))


# DMI / ADX (standard built-in "Directional Movement Index")
def dmi(adx_len, di_len):
    up_, down_ = change(H), -change(L)
    plus_dm, minus_dm = nans(), nans()
    for i in range(1, N):
        plus_dm[i] = up_[i] if (up_[i] > down_[i] and up_[i] > 0) else 0.0
        minus_dm[i] = down_[i] if (down_[i] > up_[i] and down_[i] > 0) else 0.0
    trur = rma(true_range(False), di_len)
    plus = 100 * rma(plus_dm, di_len) / trur
    minus = 100 * rma(minus_dm, di_len) / trur
    s = plus + minus
    adx = 100 * rma(np.abs(plus - minus) / np.where(s == 0, 1, s), adx_len)
    return {"adx": adx, "plusDi": plus, "minusDi": minus}


case("dmi", {}, "numpy", dmi(14, 14))
case("dmi-10-20", {"adxSmoothing": 10, "diLength": 20}, "numpy", dmi(10, 20))
# TA-Lib seeds DI with sums of n-1 values; the DI ratio converges after warm-up.
cross_check("plus_di", dmi(14, 14)["plusDi"], talib.PLUS_DI(H, L, C, 14), 300)


# Momentum
def rsi_case(name, inputs, n, ma_type, ma_len, mult):
    r = talib.RSI(C, n)
    cross_check("rsi", rsi_np(C, n), r, 0)
    is_bb = ma_type == "Bollinger Bands"
    ma = ma_by_type("SMA" if is_bb else ma_type, r, ma_len)
    out = {"rsi": r, "ma": ma}
    if is_bb:
        sd = stdev(r, ma_len) * mult
        out["bbUpper"], out["bbLower"] = ma + sd, ma - sd
    else:
        out["bbUpper"], out["bbLower"] = nans(), nans()
    case(name, inputs, "talib", out)


rsi_case("rsi", {}, 14, "SMA", 14, 2.0)
rsi_case(
    "rsi-bb",
    {"length": 7, "maType": "Bollinger Bands", "maLength": 20, "bbMult": 1.5},
    7,
    "Bollinger Bands",
    20,
    1.5,
)
rsi_case("rsi-wma", {"maType": "WMA", "maLength": 9}, 14, "WMA", 9, 2.0)


def macd(fast, slow, sig, osc="EMA", sig_ma="EMA"):
    f = ema if osc == "EMA" else sma
    m = f(C, fast) - f(C, slow)
    s = (ema if sig_ma == "EMA" else sma)(m, sig)
    h = m - s
    colors = np.empty(N)
    for i in range(N):
        prev = h[i - 1] if i > 0 else NAN
        rising = (not np.isnan(prev)) and prev < h[i]
        colors[i] = (0 if rising else 1) if h[i] >= 0 else (2 if rising else 3)
    return {"hist": h, "hist.color": colors, "macd": m, "signal": s}


case("macd", {}, "numpy", macd(12, 26, 9))
case(
    "macd-sma",
    {"oscMa": "SMA", "signalMa": "SMA", "fast": 8, "slow": 21, "signal": 5},
    "numpy",
    macd(8, 21, 5, "SMA", "SMA"),
)
# TA-Lib's MACD starts the fast EMA late (aligned with the slow one); it converges.
cross_check("macd", macd(12, 26, 9)["macd"], talib.MACD(C, 12, 26, 9)[0], 400)


def stochastic(pk, sk, pd):
    k = sma(stoch_np(C, H, L, pk), sk)
    return {"k": k, "d": sma(k, pd)}


case("stochastic", {}, "numpy", stochastic(14, 1, 3))
case("stochastic-slow", {"periodK": 10, "smoothK": 3, "periodD": 5}, "numpy", stochastic(10, 3, 5))
# TA-Lib aligns %K with %D (both start at the %D warm-up); values agree after it.
cross_check("stoch", stochastic(14, 3, 3)["k"], talib.STOCH(H, L, C, 14, 3, 0, 3, 0)[0], 30)


def stoch_rsi(sk, sd, rl, sl):
    r = rsi_np(C, rl)
    k = sma(stoch_np(r, r, r, sl), sk)
    return {"k": k, "d": sma(k, sd)}


case("stoch-rsi", {}, "numpy", stoch_rsi(3, 3, 14, 14))
case(
    "stoch-rsi-alt",
    {"smoothK": 2, "smoothD": 4, "rsiLength": 10, "stochLength": 20},
    "numpy",
    stoch_rsi(2, 4, 10, 20),
)

cci = talib.CCI(H, L, C, 20)
cross_check("cci", (HLC3 - sma(HLC3, 20)) / (0.015 * mean_dev(HLC3, 20)), cci, 0)
case("cci", {}, "talib", {"cci": cci, "ma": sma(cci, 14)})
cci_c = (C - sma(C, 10)) / (0.015 * mean_dev(C, 10))
case(
    "cci-close-ema",
    {"length": 10, "source": "close", "maType": "EMA", "maLength": 5},
    "numpy",
    {"cci": cci_c, "ma": ema(cci_c, 5)},
)

case("williams-r", {}, "talib", {"r": talib.WILLR(H, L, C, 14)})
case("williams-r-30", {"length": 30}, "talib", {"r": talib.WILLR(H, L, C, 30)})


# Volatility
def atr(n, smoothing):
    tr = true_range(True)
    return {"RMA": rma, "SMA": sma, "EMA": ema, "WMA": wma}[smoothing](tr, n)


case("atr", {}, "numpy", {"atr": atr(14, "RMA")})
case("atr-sma", {"length": 10, "smoothing": "SMA"}, "numpy", {"atr": atr(10, "SMA")})
# TA-Lib skips the first bar's TR (first value one bar later); converges after.
cross_check("atr", atr(14, "RMA"), talib.ATR(H, L, C, 14), 300)


# Volume
def obv():
    out = np.zeros(N)
    total = 0.0
    for i in range(1, N):
        total += np.sign(C[i] - C[i - 1]) * V[i]
        out[i] = total
    return out


def obv_case(name, inputs, ma_type, ma_len, mult):
    o = obv()
    out = {"obv": o, "ma": nans(), "bbUpper": nans(), "bbLower": nans()}
    if ma_type != "None":
        is_bb = ma_type == "SMA + Bollinger Bands"
        out["ma"] = ma_by_type("SMA" if is_bb else ma_type, o, ma_len)
        if is_bb:
            sd = stdev(o, ma_len) * mult
            out["bbUpper"], out["bbLower"] = out["ma"] + sd, out["ma"] - sd
    case(name, inputs, "numpy", out)


obv_case("obv", {}, "None", 14, 2.0)
obv_case(
    "obv-bb",
    {"maType": "SMA + Bollinger Bands", "maLength": 20, "bbMult": 1.5},
    "SMA + Bollinger Bands",
    20,
    1.5,
)
obv_case("obv-ema", {"maType": "EMA", "maLength": 9}, "EMA", 9, 2.0)
# TA-Lib's OBV starts at volume[0] instead of 0.
cross_check("obv", obv() + V[0], talib.OBV(C, V), 0)

case("mfi", {}, "talib", {"mf": talib.MFI(H, L, C, V, 14)})
case("mfi-7", {"length": 7}, "talib", {"mf": talib.MFI(H, L, C, V, 7)})


def volume_case(name, inputs, ma_len, prev_close):
    colors = np.empty(N)
    for i in range(N):
        down = (i > 0 and C[i - 1] > C[i]) if prev_close else O[i] > C[i]
        colors[i] = 1 if down else 0
    case(name, inputs, "numpy", {"volume": V.copy(), "volume.color": colors, "ma": sma(V, ma_len)})


volume_case("volume", {}, 20, False)
volume_case("volume-prev-close", {"maLength": 10, "prevClose": True}, 10, True)


# Pivot Points Standard (Traditional) from the previous period's H/L/C.
def pivot_levels(h, l, c):
    p = (h + l + c) / 3
    return {
        "p": p,
        "r1": 2 * p - l,
        "s1": 2 * p - h,
        "r2": p + (h - l),
        "s2": p - (h - l),
        "r3": 2 * p + (h - 2 * l),
        "s3": 2 * p - (2 * h - l),
        "r4": 3 * p + (h - 3 * l),
        "s4": 3 * p - (3 * h - l),
        "r5": 4 * p + (h - 4 * l),
        "s5": 4 * p - (4 * h - l),
    }


def shift1(x):
    return np.concatenate([[NAN], x[:-1]])


# On chart bars ('' timeframe): pivots of the previous bar.
case(
    "pivot-points-chart", {"timeframe": ""}, "numpy", pivot_levels(shift1(H), shift1(L), shift1(C))
)

# Daily pivots on hourly bars: UTC-day bars, each chart bar shows the pivots
# of the day before its own. The test feeds the same daily aggregation.
days = (T // 86400).astype(np.int64)
uniq = np.unique(days)
dh = np.array([H[days == d].max() for d in uniq])
dl = np.array([L[days == d].min() for d in uniq])
dc = np.array([C[days == d][-1] for d in uniq])
lv = pivot_levels(shift1(dh), shift1(dl), shift1(dc))
pos = np.searchsorted(uniq, days)
case("pivot-points", {"timeframe": "1D"}, "numpy", {k: v[pos] for k, v in lv.items()})


# --------------------------------------------------------------- output


def cell(x: float) -> str:
    return "" if math.isnan(x) else repr(float(x))


def write_csv(path: Path, header: str | None, cols: dict[str, np.ndarray]):
    lines = [] if header is None else [header]
    lines.append(",".join(["time", *cols]))
    for i in range(N):
        row = [repr(float(T[i]))]
        for k, v in cols.items():
            row.append(str(int(v[i])) if k.endswith(".color") else cell(v[i]))
        lines.append(",".join(row))
    path.write_text("\n".join(lines) + "\n")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.csv"):
        old.unlink()
    write_csv(OUT / "bars.csv", None, {k: B[k] for k in ("open", "high", "low", "close", "volume")})
    for name, inputs, ref, outputs in CASES:
        header = f"# inputs: {json.dumps(inputs)} ref: {ref}"
        write_csv(OUT / f"{name}.csv", header, outputs)
    print(f"wrote {len(CASES)} cases + bars.csv to {OUT}")


if __name__ == "__main__":
    main()
