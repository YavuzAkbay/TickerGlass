/**
 * Swing points and price/oscillator divergences, computed exactly so a language model only has to
 * call a tool and explain the result (docs/design/local-ai.md §7).
 */
import { at } from './format';
import type { BriefBars } from './types';

export interface SwingOptions {
  /** Bars on each side a swing must beat (confirmed pivots only). Default 3. */
  strength?: number;
  /** Inclusive index range searched. Default: all bars. */
  from?: number;
  to?: number;
}

export interface Swing {
  index: number;
  value: number;
}

/**
 * Confirmed pivot highs (`kind` 'high': greater than the `strength` values on each side, ties go
 * to the earlier bar) or lows of `values`.
 */
export function findSwings(
  values: ArrayLike<number>,
  kind: 'high' | 'low',
  opts: SwingOptions = {},
): Swing[] {
  const k = Math.max(1, Math.floor(opts.strength ?? 3));
  const n = values.length;
  const from = Math.max(opts.from ?? 0, k);
  const to = Math.min(opts.to ?? n - 1, n - 1 - k);
  const out: Swing[] = [];
  const better =
    kind === 'high' ? (a: number, b: number) => a > b : (a: number, b: number) => a < b;
  for (let i = from; i <= to; i++) {
    const v = at(values, i);
    if (!Number.isFinite(v)) continue;
    let ok = true;
    for (let j = i - k; j <= i + k && ok; j++) {
      if (j === i) continue;
      const w = at(values, j);
      if (!Number.isFinite(w)) continue;
      // Ties go to the earlier bar: an equal value before `i` disqualifies it, one after does not.
      if (j < i ? !better(v, w) : better(w, v)) ok = false;
    }
    if (ok) out.push({ index: i, value: v });
  }
  return out;
}

export type DivergenceKind = 'regular' | 'hidden';
export type DivergenceDirection = 'bullish' | 'bearish';

export interface DivergencePoint {
  index: number;
  time: number;
  value: number;
}

export interface Divergence {
  /** `d1` is the most recent. */
  id: string;
  kind: DivergenceKind;
  direction: DivergenceDirection;
  /** Price swing pair (highs for bearish, lows for bullish), older first. */
  price: [DivergencePoint, DivergencePoint];
  /** Oscillator at the same swings, older first. */
  oscillator: [DivergencePoint, DivergencePoint];
  bars: number;
  priceChangePct: number;
  oscillatorChange: number;
}

export interface DivergenceOptions extends SwingOptions {
  /** Kinds to report. Default both. */
  kinds?: readonly DivergenceKind[];
  /** Bars between the two swings. Defaults 5 and 60. */
  minBars?: number;
  maxBars?: number;
  /** The oscillator extreme may sit this many bars from the price swing. Default 2. */
  tolerance?: number;
  /** Most results returned (most recent first). Default 10. */
  limit?: number;
}

/** Extreme of `osc` within `tol` bars of `i`, or null without values. */
function oscAt(
  osc: ArrayLike<number>,
  i: number,
  tol: number,
  kind: 'high' | 'low',
): { index: number; value: number } | null {
  let best: { index: number; value: number } | null = null;
  for (let j = Math.max(0, i - tol); j <= Math.min(osc.length - 1, i + tol); j++) {
    const v = at(osc, j);
    if (!Number.isFinite(v)) continue;
    if (!best || (kind === 'high' ? v > best.value : v < best.value)) best = { index: j, value: v };
  }
  return best;
}

/**
 * Divergences between price and `osc` (aligned to `bars`) over consecutive confirmed swings:
 * regular bearish (price higher high, oscillator lower high), regular bullish (lower low / higher
 * low), hidden bearish (lower high / higher high), hidden bullish (higher low / lower low).
 */
export function findDivergences(
  bars: BriefBars,
  osc: ArrayLike<number>,
  opts: DivergenceOptions = {},
): Divergence[] {
  const kinds = opts.kinds ?? ['regular', 'hidden'];
  const minBars = opts.minBars ?? 5;
  const maxBars = opts.maxBars ?? 60;
  const tol = opts.tolerance ?? 2;
  const found: Omit<Divergence, 'id'>[] = [];

  const scan = (kind: 'high' | 'low') => {
    const series = kind === 'high' ? bars.high : bars.low;
    const swings = findSwings(series, kind, opts);
    for (let s = 1; s < swings.length; s++) {
      const a = swings[s - 1]!;
      const b = swings[s]!;
      const gap = b.index - a.index;
      if (gap < minBars || gap > maxBars) continue;
      const oa = oscAt(osc, a.index, tol, kind);
      const ob = oscAt(osc, b.index, tol, kind);
      if (!oa || !ob || oa.value === ob.value || a.value === b.value) continue;
      const priceUp = b.value > a.value;
      const oscUp = ob.value > oa.value;
      if (priceUp === oscUp) continue;
      // Highs: HH+LH regular bearish, LH+HH hidden bearish. Lows: LL+HL regular bullish,
      // HL+LL hidden bullish.
      const kindOf: DivergenceKind =
        kind === 'high' ? (priceUp ? 'regular' : 'hidden') : priceUp ? 'hidden' : 'regular';
      if (!kinds.includes(kindOf)) continue;
      const point = (index: number, value: number): DivergencePoint => ({
        index,
        time: at(bars.time, index),
        value,
      });
      found.push({
        kind: kindOf,
        direction: kind === 'high' ? 'bearish' : 'bullish',
        price: [point(a.index, a.value), point(b.index, b.value)],
        oscillator: [point(oa.index, oa.value), point(ob.index, ob.value)],
        bars: gap,
        priceChangePct: a.value !== 0 ? ((b.value - a.value) / a.value) * 100 : 0,
        oscillatorChange: ob.value - oa.value,
      });
    }
  };
  scan('high');
  scan('low');
  found.sort((x, y) => y.price[1].index - x.price[1].index || y.price[0].index - x.price[0].index);
  return found.slice(0, opts.limit ?? 10).map((d, i) => ({ id: `d${i + 1}`, ...d }));
}
