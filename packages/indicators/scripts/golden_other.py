"""Golden cases for the other group (Phase 12, batch B6): src/builtins/groups/other.ts.

Add cases with `out.add(name, inputs, ref, outputs[, bars=DAILY][, extra=...])`
(see golden_common.py). Case names are `<id>` or `<id>-<variant>`.

All numpy ports (no TA-Lib equivalents). Repainting definitions (ZigZag, Auto
Fib, Linear Regression Channel) are checked on their final arrays after the
last bar: the test also feeds bars 500.. live and expects identical arrays.
Linear regression uses `np.polyfit` (textbook OLS), independent of the
summation form the definition ports.
"""

from __future__ import annotations

import datetime as dt

import numpy as np

from golden_common import (
    DAILY,
    HL2,
    HOURLY,
    NAN,
    Bars,
    C,
    Case,
    Cases,
    H,
    L,
    N,
    O,
    T,
    nans,
    rma,
    shift1,
    true_range,
)
from golden_trend_ma import COARSE

DAY = 86400
LEVEL_IDS = ("p", "r1", "s1", "r2", "s2", "r3", "s3", "r4", "s4", "r5", "s5")


# ------------------------------------------------------------ pivot points


def pivot_levels(kind, o, h, l, c, o_cur):
    """Levels of the previous period (o, h, l, c) for one type; undefined -> NaN."""
    r = h - l
    if kind == "Fibonacci":
        p = (h + l + c) / 3
        lv = {"p": p, "r1": p + 0.382 * r, "s1": p - 0.382 * r, "r2": p + 0.618 * r}
        lv.update({"s2": p - 0.618 * r, "r3": p + r, "s3": p - r})
    elif kind == "Woodie":
        p = (h + l + 2 * o_cur) / 4
        r3 = h + 2 * (p - l)
        s3 = l - 2 * (h - p)
        lv = {"p": p, "r1": 2 * p - l, "s1": 2 * p - h, "r2": p + r, "s2": p - r}
        lv.update({"r3": r3, "s3": s3, "r4": r3 + r, "s4": s3 - r})
    elif kind == "Classic":
        p = (h + l + c) / 3
        lv = {"p": p, "r1": 2 * p - l, "s1": 2 * p - h, "r2": p + r, "s2": p - r}
        lv.update({"r3": p + 2 * r, "s3": p - 2 * r, "r4": p + 3 * r, "s4": p - 3 * r})
    elif kind == "DM":
        x = np.where(c < o, h + 2 * l + c, np.where(c > o, 2 * h + l + c, h + l + 2 * c))
        lv = {"p": x / 4, "r1": x / 2 - l, "s1": x / 2 - h}
    elif kind == "Camarilla":
        r5 = h / l * c
        lv = {"p": (h + l + c) / 3, "r5": r5, "s5": c - (r5 - c)}
        for k, f in ((1, 12), (2, 6), (3, 4), (4, 2)):
            lv[f"r{k}"] = c + 1.1 * r / f
            lv[f"s{k}"] = c - 1.1 * r / f
    else:
        raise ValueError(kind)
    n = len(h)
    return {k: lv.get(k, nans(n)) for k in LEVEL_IDS}


def pivot_cases(out: Cases):
    # On chart bars: previous bar's OHLC, current bar's open (Woodie).
    for kind in ("Fibonacci", "Woodie", "Classic", "DM", "Camarilla"):
        lv = pivot_levels(kind, shift1(O), shift1(H), shift1(L), shift1(C), O)
        out.add(f"pivot-points-{kind.lower()}", {"type": kind, "timeframe": ""}, "numpy", lv)
    # Woodie on UTC-day bars of the hourly series: the day's open is its first bar's.
    days = (T // DAY).astype(np.int64)
    uniq = np.unique(days)
    do = np.array([O[days == d][0] for d in uniq])
    dh = np.array([H[days == d].max() for d in uniq])
    dl = np.array([L[days == d].min() for d in uniq])
    dc = np.array([C[days == d][-1] for d in uniq])
    lv = pivot_levels("Woodie", shift1(do), shift1(dh), shift1(dl), shift1(dc), do)
    pos = np.searchsorted(uniq, days)
    out.add(
        "pivot-points-woodie-1d",
        {"type": "Woodie", "timeframe": "1D"},
        "numpy",
        {k: v[pos] for k, v in lv.items()},
    )


# ------------------------------------------------------------ pivots high/low


def pivot_np(x, left, right, high):
    """Pivot high/low (strict on both sides): value at the confirming bar i of center i - right."""
    out = nans(len(x))
    for i in range(left + right, len(x)):
        c = i - right
        others = np.concatenate([x[c - left : c], x[c + 1 : i + 1]])
        if (x[c] > others).all() if high else (x[c] < others).all():
            out[i] = x[c]
    return out


def swing_hl_cases(out: Cases):
    out.add(
        "swing-hl",
        {},
        "numpy",
        {"ph": pivot_np(H, 10, 10, True), "pl": pivot_np(L, 10, 10, False)},
    )
    inputs = {"leftHigh": 5, "rightHigh": 3, "leftLow": 2, "rightLow": 7}
    out.add(
        "swing-hl-asym",
        inputs,
        "numpy",
        {"ph": pivot_np(H, 5, 3, True), "pl": pivot_np(L, 2, 7, False)},
    )


# ------------------------------------------------------------ zigzag / swing fib


def zz_pivot_np(x, d, high):
    """ZigZag pivot test at the confirming bar i of center i - d: no newer
    bar strictly beyond, no older bar beyond or equal (oldest equal bar wins).
    Differs from pivot_np (strict on both sides)."""
    out = nans(len(x))
    for i in range(2 * d, len(x)):
        p = x[i - d]
        newer, older = x[i - d + 1 : i + 1], x[i - 2 * d : i - d]
        if high:
            ok = not (newer > p).any() and not (older >= p).any()
        else:
            ok = not (newer < p).any() and not (older <= p).any()
        if ok:
            out[i] = p
    return out


def zigzag_np(h, l, depth, threshold, pivot=zz_pivot_np):
    """ZigZag pivots, final state. threshold[i]: reversal % at
    bar i (NaN: none).

    Returns pivots = list of [bar, price, dir] after the last bar (moves
    overwrite the last pivot in place). Per bar the high candidate is tried,
    then the low one (allowZigZagOnOneBar = true), so two pivots can share a
    bar. The reversal deviation is signed (a high must be above a low pivot).
    `pivot` is swappable only to assert that a case exercises ties.
    """
    d = max(2, depth // 2)
    ph = pivot(h, d, True)
    pl = pivot(l, d, False)
    piv: list[list] = []

    def offer(j, price, direction, dev):
        if not piv:
            piv.append([j, price, direction])
            return
        last = piv[-1]
        if last[2] == direction:
            if (price > last[1]) if direction > 0 else (price < last[1]):
                last[0], last[1] = j, price
            return
        change = 100 * (price - last[1]) / abs(last[1])
        if (change >= dev) if direction > 0 else (change <= -dev):
            piv.append([j, price, direction])

    for i in range(len(h)):
        j, dev = i - d, threshold[i]
        if not np.isnan(ph[i]):
            offer(j, ph[i], 1, dev)
        if not np.isnan(pl[i]):
            offer(j, pl[i], -1, dev)
    return piv


def zigzag_outputs(bars: Bars, deviation, depth, extend, labels):
    """ZigZag pivots with price labels plus `zzf`, the dashed forecast of the
    leg in progress. The last pivot stays hidden until price has moved
    `deviation` % against it since its bar (window inclusive of the pivot bar);
    earlier pivots were proven by the pivot that followed them. While hidden,
    the forecast runs from the previous pivot to the furthest extreme reached
    since (oldest bar wins ties); once confirmed, from the pivot itself.
    `extend` continues the forecast to the last close, `labels` writes the
    label at its end."""
    n = bars.n
    piv = zigzag_np(bars.high, bars.low, depth, np.full(n, float(deviation)))
    zz, hi, lo, zzf = nans(n), nans(n), nans(n), nans(n)
    for j, price, direction in piv:
        zz[j] = price
        if labels:
            (hi if direction > 0 else lo)[j] = price
    if piv:
        bar, price, direction = piv[-1]
        if direction > 0:
            move = 100 * (bars.low[bar:].min() - price) / abs(price)
            confirmed = move <= -deviation
        else:
            move = 100 * (bars.high[bar:].max() - price) / abs(price)
            confirmed = move >= deviation
        if confirmed or len(piv) == 1:
            start, start_price = bar, price
            up = direction < 0  # a pivot high starts a down-leg, a low an up-leg
        else:
            # Unconfirmed: the pivot stays hidden and the leg runs on to it.
            zz[bar] = NAN
            if labels:
                (hi if direction > 0 else lo)[bar] = NAN
            if piv[-2][0] == bar:  # same-bar pair: the earlier pivot shows again
                zz[bar] = piv[-2][1]
            start, start_price = piv[-2][0], piv[-2][1]
            up = direction > 0
        if start < n - 1:
            seg = bars.high[start + 1 :] if up else bars.low[start + 1 :]
            off = int(np.argmax(seg) if up else np.argmin(seg))  # oldest bar wins ties
            end, end_price = start + 1 + off, seg[off]
            zzf[start] = start_price
            zzf[end] = end_price
            if extend and end < n - 1:
                zzf[n - 1] = bars.close[n - 1]
            if labels:
                (hi if up else lo)[end] = end_price
    return {"zz": zz, "zzf": zzf, "hiLbl": hi, "loLbl": lo}


def zigzag_cases(out: Cases):
    out.add("zigzag", {}, "numpy", zigzag_outputs(HOURLY, 5, 10, True, True))
    out.add(
        "zigzag-dev1",
        {"deviation": 1, "depth": 6},
        "numpy",
        zigzag_outputs(HOURLY, 1, 6, True, True),
    )
    out.add(
        "zigzag-noext",
        {"deviation": 2.5, "depth": 15, "extendToLastBar": False, "showPrice": False},
        "numpy",
        zigzag_outputs(HOURLY, 2.5, 15, False, False),
    )
    # Equal highs/lows within the pivot window (0.25 price grid): the oldest
    # equal bar is the pivot, unlike the strict pivot. Some bars also hold
    # both a high and a low pivot.
    dev = np.full(COARSE.n, 1.0)
    ties = zigzag_np(COARSE.high, COARSE.low, 6, dev)
    strict = zigzag_np(COARSE.high, COARSE.low, 6, dev, lambda x, d, hi: pivot_np(x, d, d, hi))
    assert ties != strict
    assert len({j for j, *_ in ties}) < len(ties)
    out.add(
        "zigzag-ties",
        {"deviation": 1, "depth": 6},
        "numpy",
        zigzag_outputs(COARSE, 1, 6, True, True),
        bars=COARSE,
    )


FIB = (
    ("l0", "show0", 0.0, True),
    ("l236", "show236", 0.236, True),
    ("l382", "show382", 0.382, True),
    ("l500", "show500", 0.5, True),
    ("l618", "show618", 0.618, True),
    ("l786", "show786", 0.786, True),
    ("l1000", "show1000", 1.0, True),
    ("l1618", "show1618", 1.618, False),
    ("l2618", "show2618", 2.618, False),
    ("l3618", "show3618", 3.618, False),
    ("l4236", "show4236", 4.236, False),
)


def swing_fib_outputs(deviation, depth, reverse, shown: dict):
    atr = rma(true_range(True), 10)
    piv = zigzag_np(H, L, depth, 100 * atr / C * deviation)
    outs = {fid: nans() for fid, *_ in FIB}
    assert len(piv) >= 2, "swing-fib case needs two pivots"
    (s_bar, s_price, _), (_, e_price, _) = piv[-2], piv[-1]
    if reverse:
        s_price, e_price = e_price, s_price
    for fid, key, ratio, on in FIB:
        if shown.get(key, on):
            outs[fid][s_bar:] = e_price + (s_price - e_price) * ratio
    return outs


def swing_fib_cases(out: Cases):
    out.add("swing-fib", {}, "numpy", swing_fib_outputs(3, 10, False, {}))
    shown = {"show236": False, "show1618": True, "show4236": True}
    out.add(
        "swing-fib-reverse",
        {"deviation": 2, "depth": 8, "reverse": True, **shown},
        "numpy",
        swing_fib_outputs(2, 8, True, shown),
    )


# ------------------------------------------------------------ linreg channel


def linreg_outputs(src, length, up_mult, dn_mult):
    """Channel over the last `length` bars; None multiplier = max excursion of high/low."""
    outs = {k: nans() for k in ("mid", "upper", "lower", "r")}
    y = src[N - length :]
    x = np.arange(length, dtype=np.float64)
    b, a = np.polyfit(x, y, 1)
    fit = a + b * x
    resid = y - fit
    sd = np.sqrt(np.sum(resid**2) / (length - 1))
    up = up_mult * sd if up_mult is not None else max(0.0, np.max(H[N - length :] - fit))
    dn = dn_mult * sd if dn_mult is not None else max(0.0, np.max(fit - L[N - length :]))
    outs["mid"][N - length :] = fit
    outs["upper"][N - length :] = fit + up
    outs["lower"][N - length :] = fit - dn
    outs["r"][N - length :] = np.corrcoef(y, fit)[0, 1]  # |Pearson r|
    return outs


def linreg_cases(out: Cases):
    out.add("linreg-channel", {}, "numpy", linreg_outputs(C, 100, 2, 2))
    out.add(
        "linreg-channel-nodev",
        {"length": 50, "useUpperDev": False, "useLowerDev": False},
        "numpy",
        linreg_outputs(C, 50, None, None),
    )
    out.add(
        "linreg-channel-hl2",
        {"length": 30, "source": "hl2", "upperDev": 1.5, "useLowerDev": False},
        "numpy",
        linreg_outputs(HL2, 30, 1.5, None),
    )


# ------------------------------------------------------------ 52-week range


def high_low_time(time, high, low, weeks):
    """Max/min over bars with time > t - weeks * 7 days (partial windows allowed)."""
    span = weeks * 7 * DAY
    hi, lo = nans(len(time)), nans(len(time))
    for i in range(len(time)):
        w = time > time[i] - span
        w[i + 1 :] = False
        hi[i], lo[i] = high[w].max(), low[w].min()
    return hi, lo


def high_low_cases(out: Cases):
    hi, lo = high_low_time(DAILY.time, DAILY.high, DAILY.low, 52)
    out.add("high-low-52w", {"timeframe": ""}, "numpy", {"hi": hi, "lo": lo}, bars=DAILY)
    # Default 1D timeframe with "wait for close": each bar shows the previous day's value.
    out.add("high-low-52w-1d", {}, "numpy", {"hi": shift1(hi), "lo": shift1(lo)}, bars=DAILY)
    hi13, lo13 = high_low_time(DAILY.time, DAILY.high, DAILY.low, 13)
    out.add(
        "high-low-52w-13w-nowait",
        {"weeks": 13, "waitForClose": False},
        "numpy",
        {"hi": hi13, "lo": lo13},
        bars=DAILY,
    )
    # Hourly chart, daily timeframe: UTC-day bars, confirmed (previous day) values.
    days = (T // DAY).astype(np.int64)
    uniq = np.unique(days)
    dh = np.array([H[days == d].max() for d in uniq])
    dl = np.array([L[days == d].min() for d in uniq])
    dhi, dlo = high_low_time(uniq.astype(np.float64) * DAY, dh, dl, 1)
    pos = np.searchsorted(uniq, days)
    out.add(
        "high-low-52w-hourly-1w",
        {"weeks": 1},
        "numpy",
        {"hi": shift1(dhi)[pos], "lo": shift1(dlo)[pos]},
    )


# ------------------------------------------------------------ seasonality


def seasonality_outputs(bars: Bars, years):
    keys = []
    for t in bars.time:
        d = dt.datetime.fromtimestamp(int(t), dt.timezone.utc)
        keys.append(d.year * 10000 + d.month * 100 + d.day)
    keys = np.array(keys)
    close = bars.close

    def last_at_or_before(target, hi):
        idx = np.flatnonzero(keys[: hi + 1] <= target)
        return int(idx[-1]) if len(idx) else -1

    def ytd(hi, target):
        ref = last_at_or_before((target // 10000 - 1) * 10000 + 1231, hi)
        if ref < 0:
            return NAN
        return 100 * (close[last_at_or_before(target, hi)] / close[ref] - 1)

    cur, avg = nans(bars.n), nans(bars.n)
    for i in range(bars.n):
        key = int(keys[i])
        cur[i] = ytd(i, key)
        vals = [ytd(i, (key // 10000 - k) * 10000 + key % 10000) for k in range(1, years + 1)]
        vals = [v for v in vals if not np.isnan(v)]
        avg[i] = np.mean(vals) if vals else NAN
    return {"cur": cur, "avg": avg}


def seasonality_cases(out: Cases):
    out.add("seasonality", {}, "numpy", seasonality_outputs(DAILY, 5), bars=DAILY)
    out.add("seasonality-2y", {"years": 2}, "numpy", seasonality_outputs(DAILY, 2), bars=DAILY)


# ------------------------------------------------------------ volume profiles


def vp_cases(out: Cases):
    # Visible range: engine-side only, the values array stays NaN.
    out.add("vp-visible", {}, "numpy", {"vp": nans()})
    size = {"layout": "size", "rowSize": 0.5, "placement": "left"}
    out.add("vp-visible-size", size, "numpy", {"vp": nans()})
    # Session: 1 on the first bar of every (UTC) day.
    days = T // DAY
    starts = np.where(np.concatenate([[True], days[1:] != days[:-1]]), 1.0, NAN)
    out.add("vp-session", {}, "numpy", {"vp": starts})
    out.add("vp-session-size", size, "numpy", {"vp": starts})


# ------------------------------------------------------------ chart patterns

# Output id of each pattern kind (must mirror src/builtins/chart-patterns.ts).
PATTERN_LABEL = {
    "doubleTop": "dblTop",
    "doubleBottom": "dblBot",
    "tripleTop": "triTop",
    "tripleBottom": "triBot",
    "headShoulders": "hs",
    "inverseHeadShoulders": "ihs",
    "ascendingTriangle": "ascTri",
    "descendingTriangle": "descTri",
    "symmetricalTriangle": "symTri",
    "risingWedge": "risWed",
    "fallingWedge": "falWed",
    "rectangle": "rect",
}
# 0 bearish, 1 bullish, 2 neutral.
PATTERN_CATEGORY = {
    "doubleTop": 0,
    "tripleTop": 0,
    "headShoulders": 0,
    "risingWedge": 0,
    "descendingTriangle": 0,
    "doubleBottom": 1,
    "tripleBottom": 1,
    "inverseHeadShoulders": 1,
    "fallingWedge": 1,
    "ascendingTriangle": 1,
    "symmetricalTriangle": 2,
    "rectangle": 2,
}
PATTERN_MIN_SPAN = 5


def rel_diff(a, b):
    m = (a + b) / 2
    return abs(a - b) / m * 100 if m != 0 else float("inf")


def fit_line(points):
    """Least-squares line y = intercept + slope * bar (closed form, as the TS)."""
    n = len(points)
    sx = sum(p[0] for p in points)
    sy = sum(p[1] for p in points)
    sxx = sum(p[0] * p[0] for p in points)
    sxy = sum(p[0] * p[1] for p in points)
    denom = n * sxx - sx * sx
    slope = 0.0 if denom == 0 else (n * sxy - sx * sy) / denom
    return slope, (sy - slope * sx) / n


def line_value(line, bar):
    return line[1] + line[0] * bar


def interp_anchors(points, bar):
    """Piecewise-linear through the anchors, clamped at the ends."""
    if bar <= points[0][0]:
        return points[0][1]
    if bar >= points[-1][0]:
        return points[-1][1]
    for k in range(1, len(points)):
        if bar <= points[k][0]:
            a, b = points[k - 1], points[k]
            return a[1] + (b[1] - a[1]) * (bar - a[0]) / (b[0] - a[0])
    return points[-1][1]


def pattern_window(piv, end, size, max_bars):
    start = end - size + 1
    if start < 0:
        return None
    w = piv[start : end + 1]
    start_bar, end_bar = w[0][0], w[-1][0]
    span = end_bar - start_bar
    if span < PATTERN_MIN_SPAN or span > max_bars:
        return None
    mean_price = sum(p[1] for p in w) / size
    if not mean_price > 0:
        return None
    return w, start_bar, end_bar, mean_price


def point_pattern(w, tolerance):
    wp = w[0]
    if wp[-1][2] > 0:
        if len(wp) == 4:
            if rel_diff(wp[1][1], wp[3][1]) <= tolerance:
                return "doubleTop", [wp[1], wp[3]], [wp[0], wp[2]]
            return None
        h1, h3, h5 = wp[1][1], wp[3][1], wp[5][1]
        mean_h = (h1 + h3 + h5) / 3
        if (
            mean_h > 0
            and rel_diff(h1, mean_h) <= tolerance
            and rel_diff(h3, mean_h) <= tolerance
            and rel_diff(h5, mean_h) <= tolerance
            and rel_diff(wp[2][1], wp[4][1]) <= tolerance
        ):
            return "tripleTop", [wp[1], wp[3], wp[5]], [wp[0], wp[2], wp[4]]
        if h3 > h1 and h3 > h5 and rel_diff(h1, h5) <= tolerance:
            return "headShoulders", [wp[1], wp[3], wp[5]], [wp[0], wp[2], wp[4]]
        return None
    if len(wp) == 4:
        if rel_diff(wp[1][1], wp[3][1]) <= tolerance:
            return "doubleBottom", [wp[0], wp[2]], [wp[1], wp[3]]
        return None
    l1, l3, l5 = wp[1][1], wp[3][1], wp[5][1]
    mean_l = (l1 + l3 + l5) / 3
    if (
        mean_l > 0
        and rel_diff(l1, mean_l) <= tolerance
        and rel_diff(l3, mean_l) <= tolerance
        and rel_diff(l5, mean_l) <= tolerance
        and rel_diff(wp[2][1], wp[4][1]) <= tolerance
    ):
        return "tripleBottom", [wp[0], wp[2], wp[4]], [wp[1], wp[3], wp[5]]
    if l3 < l1 and l3 < l5 and rel_diff(l1, l5) <= tolerance:
        return "inverseHeadShoulders", [wp[0], wp[2], wp[4]], [wp[1], wp[3], wp[5]]
    return None


def line_pattern(w, tolerance):
    wp, start_bar, end_bar, mean_price = w
    highs = [p for p in wp if p[2] > 0]
    lows = [p for p in wp if p[2] < 0]
    if len(highs) < 2 or len(lows) < 2:
        return None
    fit_high = fit_line(highs)
    fit_low = fit_line(lows)
    if line_value(fit_high, start_bar) <= line_value(fit_low, start_bar):
        return None
    if line_value(fit_high, end_bar) <= line_value(fit_low, end_bar):
        return None
    for p in highs:
        if abs(p[1] - line_value(fit_high, p[0])) / mean_price * 100 > tolerance:
            return None
    for p in lows:
        if abs(p[1] - line_value(fit_low, p[0])) / mean_price * 100 > tolerance:
            return None
    change_high = (
        abs(line_value(fit_high, highs[-1][0]) - line_value(fit_high, highs[0][0]))
        / mean_price
        * 100
    )
    change_low = (
        abs(line_value(fit_low, lows[-1][0]) - line_value(fit_low, lows[0][0])) / mean_price * 100
    )
    flat_high = change_high < tolerance
    flat_low = change_low < tolerance
    rising_high = not flat_high and fit_high[0] > 0
    falling_high = not flat_high and fit_high[0] < 0
    rising_low = not flat_low and fit_low[0] > 0
    falling_low = not flat_low and fit_low[0] < 0
    kind = None
    if flat_high and flat_low:
        kind = "rectangle"
    elif flat_high and rising_low:
        kind = "ascendingTriangle"
    elif falling_high and flat_low:
        kind = "descendingTriangle"
    elif falling_high and rising_low:
        kind = "symmetricalTriangle"
    elif rising_high and rising_low and fit_low[0] > fit_high[0]:
        kind = "risingWedge"
    elif falling_high and falling_low and fit_high[0] < fit_low[0]:
        kind = "fallingWedge"
    if kind is None:
        return None
    return kind, highs, lows, fit_high, fit_low


def match_chart_pattern(piv, end, tolerance, max_bars):
    """(kind, high anchors, low anchors, fit high, fit low, start idx, end idx) or None.
    Reversal patterns take precedence over continuation shapes, larger windows
    first. Point patterns carry fits of None (anchor interpolation)."""
    w6 = pattern_window(piv, end, 6, max_bars)
    if w6 is not None:
        p = point_pattern(w6, tolerance)
        if p is not None:
            return p[0], p[1], p[2], None, None, end - 5, end
    w4 = pattern_window(piv, end, 4, max_bars)
    if w4 is not None:
        p = point_pattern(w4, tolerance)
        if p is not None:
            return p[0], p[1], p[2], None, None, end - 3, end
    for size in (6, 5, 4):
        w = pattern_window(piv, end, size, max_bars)
        if w is None:
            continue
        p = line_pattern(w, tolerance)
        if p is not None:
            return p[0], p[1], p[2], p[3], p[4], end - size + 1, end
    return None


def detect_chart_patterns(piv, tolerance, max_bars):
    """Full-history detection: one pattern per completing pivot, then windows
    contained in a longer one are dropped (the final state the indicator draws)."""
    found = []
    for end in range(3, len(piv)):
        m = match_chart_pattern(piv, end, tolerance, max_bars)
        if m is not None:
            found.append(m)
    return [m for m in found if not any(o[6] > m[6] and o[5] <= m[5] for o in found)]


def chart_patterns_outputs(bars, deviation, depth, tolerance, max_bars):
    n = bars.n
    piv = zigzag_np(bars.high, bars.low, depth, np.full(n, float(deviation)))
    zz, upper, lower = nans(n), nans(n), nans(n)
    zz_color = np.zeros(n)
    upper_color = np.zeros(n)
    lower_color = np.zeros(n)
    labels = {pid: nans(n) for pid in PATTERN_LABEL.values()}
    for j, price, _ in piv:
        zz[j] = price
    for kind, highs, lows, fit_high, fit_low, start_idx, end_idx in detect_chart_patterns(
        piv, tolerance, max_bars
    ):
        category = PATTERN_CATEGORY[kind]
        start_bar, end_bar = piv[start_idx][0], piv[end_idx][0]
        for j in range(start_bar, end_bar + 1):
            upper[j] = line_value(fit_high, j) if fit_high is not None else interp_anchors(highs, j)
            lower[j] = line_value(fit_low, j) if fit_low is not None else interp_anchors(lows, j)
            upper_color[j] = category
            lower_color[j] = category
        for p in piv[start_idx : end_idx + 1]:
            zz_color[p[0]] = category + 1
        labels[PATTERN_LABEL[kind]][end_bar] = 1
    out = {"zz": zz, "zz.color": zz_color, "upper": upper, "upper.color": upper_color,
           "lower": lower, "lower.color": lower_color}
    out.update(labels)
    return out


# A deterministic series whose turning points form known patterns: double top,
# inverse head & shoulders, rising wedges, a double top/bottom pair and a
# double bottom (piecewise-linear closes, so the ZigZag pivots are exactly the
# waypoints; every leg reverses by more than the 5% default deviation).
PATTERN_WAYPOINTS = [
    (0, 104),
    (10, 99),
    (25, 110),
    (40, 103),
    (55, 111),
    (72, 100),
    (88, 108),
    (104, 94),
    (120, 107),
    (136, 99),
    (152, 112),
    (166, 106),
    (180, 113),
    (194, 107),
    (208, 118),
    (213, 116),
]


def piecewise_bars(file: str, waypoints, step: float) -> Bars:
    """Wick-less OHLCV following the piecewise-linear close through `waypoints`
    ([bar, price]); the ZigZag pivots of such a series are exactly its turning
    points (each confirming `d` bars late)."""
    n = waypoints[-1][0] + 1
    close = np.empty(n)
    for (b0, p0), (b1, p1) in zip(waypoints, waypoints[1:]):
        close[b0:b1] = p0 + (p1 - p0) * (np.arange(b0, b1) - b0) / (b1 - b0)
    close[-1] = waypoints[-1][1]
    open_ = np.empty(n)
    open_[0] = close[0]
    open_[1:] = close[:-1]
    return Bars(
        file,
        1_700_000_000 + step * np.arange(n, dtype=np.float64),
        open_,
        np.maximum(open_, close),
        np.minimum(open_, close),
        close,
        np.full(n, 1000.0),
    )


PATTERNS = piecewise_bars("bars-patterns.csv", PATTERN_WAYPOINTS, 3600)


def chart_patterns_cases(out: Cases):
    out.add("chart-patterns", {}, "numpy", chart_patterns_outputs(PATTERNS, 5, 10, 3, 150), bars=PATTERNS)
    out.add(
        "chart-patterns-hourly",
        {"deviation": 2, "depth": 8, "tolerance": 2, "maxBars": 100},
        "numpy",
        chart_patterns_outputs(HOURLY, 2, 8, 2, 100),
    )


def cases() -> list[Case]:
    out = Cases()
    pivot_cases(out)
    swing_hl_cases(out)
    zigzag_cases(out)
    swing_fib_cases(out)
    chart_patterns_cases(out)
    linreg_cases(out)
    high_low_cases(out)
    seasonality_cases(out)
    vp_cases(out)
    return out.items
