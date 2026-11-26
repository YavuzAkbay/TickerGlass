import { at } from './format';
import type { BriefBars, FocusStats, PricePoint } from './types';

const ATR_PERIOD = 14;
const MAX_SWINGS = 5;

/** Index of the first bar at or after `t` (`length` when none). */
export function lowerBound(times: ArrayLike<number>, length: number, t: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(times, mid) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first bar after `t` (`length` when none). */
function upperBound(times: ArrayLike<number>, length: number, t: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (at(times, mid) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Inclusive bar indexes of `[from, to]`, or null when no bar falls inside. */
export function rangeIndexes(bars: BriefBars, from: number, to: number): [number, number] | null {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const a = lowerBound(bars.time, bars.length, lo);
  const b = upperBound(bars.time, bars.length, hi) - 1;
  return a <= b && a < bars.length ? [a, b] : null;
}

function finite(v: number): boolean {
  return Number.isFinite(v);
}

/** Wilder ATR at bar `end` (needs `ATR_PERIOD + 1` bars up to it). */
export function atrAt(bars: BriefBars, end: number, period = ATR_PERIOD): number | null {
  if (end < period) return null;
  const tr = (i: number): number => {
    const h = at(bars.high, i);
    const l = at(bars.low, i);
    const pc = at(bars.close, i - 1);
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  };
  // Seed over the first `period` true ranges of a window ending at `end`, then smooth;
  // a long warm-up keeps the value close to the full-history Wilder ATR.
  const start = Math.max(1, end - period * 10 + 1);
  if (end - start + 1 < period) return null;
  let atr = 0;
  for (let i = start; i < start + period; i++) atr += tr(i);
  atr /= period;
  for (let i = start + period; i <= end; i++) atr = (atr * (period - 1) + tr(i)) / period;
  return finite(atr) ? atr : null;
}

function regression(values: number[]): { slope: number; r2: number } | null {
  const n = values.length;
  if (n < 3) return null;
  const mx = (n - 1) / 2;
  const my = values.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    const dy = (values[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

/** Pivot highs/lows with `w` bars on each side, most recent `MAX_SWINGS` of each. */
function swings(
  bars: BriefBars,
  a: number,
  b: number,
): { highs: PricePoint[]; lows: PricePoint[] } {
  const n = b - a + 1;
  const w = Math.max(2, Math.min(5, Math.floor(n / 10)));
  const highs: PricePoint[] = [];
  const lows: PricePoint[] = [];
  for (let i = a + w; i <= b - w; i++) {
    const h = at(bars.high, i);
    const l = at(bars.low, i);
    let isHigh = finite(h);
    let isLow = finite(l);
    for (let j = i - w; j <= i + w && (isHigh || isLow); j++) {
      if (j === i) continue;
      if (at(bars.high, j) >= h && (j < i || at(bars.high, j) > h)) isHigh = false;
      if (at(bars.low, j) <= l && (j < i || at(bars.low, j) < l)) isLow = false;
    }
    if (isHigh) highs.push({ time: at(bars.time, i), price: h });
    if (isLow) lows.push({ time: at(bars.time, i), price: l });
  }
  return { highs: highs.slice(-MAX_SWINGS), lows: lows.slice(-MAX_SWINGS) };
}

function avgVolume(bars: BriefBars, a: number, b: number): number | null {
  let sum = 0;
  let count = 0;
  for (let i = a; i <= b; i++) {
    const v = at(bars.volume, i);
    if (finite(v)) {
      sum += v;
      count++;
    }
  }
  return count > 0 && sum > 0 ? sum / count : null;
}

/** Statistics of bars `a..b` (inclusive), using the bars around them for context. */
export function focusStats(bars: BriefBars, a: number, b: number): FocusStats {
  const open = at(bars.open, a);
  const close = at(bars.close, b);
  let high: PricePoint = { time: at(bars.time, a), price: -Infinity };
  let low: PricePoint = { time: at(bars.time, a), price: Infinity };
  let upBars = 0;
  let downBars = 0;
  let largestUp: PricePoint | null = null;
  let largestDown: PricePoint | null = null;
  let largestUpPct: number | null = null;
  let largestDownPct: number | null = null;
  let maxVolume: PricePoint | null = null;
  const returns: number[] = [];
  const closes: number[] = [];

  for (let i = a; i <= b; i++) {
    const t = at(bars.time, i);
    const h = at(bars.high, i);
    const l = at(bars.low, i);
    const o = at(bars.open, i);
    const c = at(bars.close, i);
    const v = at(bars.volume, i);
    if (h > high.price) high = { time: t, price: h };
    if (l < low.price) low = { time: t, price: l };
    if (c > o) upBars++;
    else if (c < o) downBars++;
    if (finite(c)) closes.push(c);
    if (finite(v) && v > 0 && (maxVolume === null || v > maxVolume.price)) {
      maxVolume = { time: t, price: v };
    }
    if (i > 0) {
      const pc = at(bars.close, i - 1);
      if (finite(pc) && pc !== 0 && finite(c)) {
        const r = ((c - pc) / pc) * 100;
        if (i > a) returns.push(r);
        if (r > 0 && (largestUpPct === null || r > largestUpPct)) {
          largestUpPct = r;
          largestUp = { time: t, price: c };
        }
        if (r < 0 && (largestDownPct === null || r < largestDownPct)) {
          largestDownPct = r;
          largestDown = { time: t, price: c };
        }
      }
    }
  }

  let volatilityPct: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    volatilityPct = Math.sqrt(variance);
  }

  const n = b - a + 1;
  const avg = avgVolume(bars, a, b);
  const priorN = Math.min(n, a);
  const priorAvg = priorN > 0 ? avgVolume(bars, a - priorN, a - 1) : null;
  const reg = regression(closes);
  const sw = swings(bars, a, b);

  const leadN = Math.min(a, Math.max(5, Math.min(n, 50)));
  let priorChangePct: number | null = null;
  if (leadN >= 2) {
    const from = at(bars.close, a - leadN);
    const to = at(bars.close, a - 1);
    if (finite(from) && from !== 0 && finite(to)) priorChangePct = ((to - from) / from) * 100;
  }
  const last = bars.length - 1;
  const lastClose = at(bars.close, last);
  const afterChangePct =
    last > b && finite(lastClose) && close !== 0 ? ((lastClose - close) / close) * 100 : null;

  return {
    bars: n,
    from: at(bars.time, a),
    to: at(bars.time, b),
    open,
    close,
    change: close - open,
    changePct: open !== 0 ? ((close - open) / open) * 100 : NaN,
    high,
    low,
    upBars,
    downBars,
    largestUp,
    largestDown,
    largestUpPct,
    largestDownPct,
    volatilityPct,
    atr: atrAt(bars, b),
    slope: reg?.slope ?? null,
    r2: reg?.r2 ?? null,
    avgVolume: avg,
    volumeVsPrior: avg !== null && priorAvg !== null ? avg / priorAvg : null,
    maxVolume,
    swingHighs: sw.highs,
    swingLows: sw.lows,
    priorChangePct,
    afterChangePct,
    barsAfter: last - b,
  };
}
