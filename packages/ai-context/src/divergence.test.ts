import { describe, expect, it } from 'vitest';
import { findDivergences, findSwings } from './divergence';
import type { BriefBars } from './types';

const DAY = 86_400;

/** Bars whose high and low are the given values ±0 (high = low = value). */
function bars(values: number[]): BriefBars {
  return {
    length: values.length,
    time: values.map((_, i) => 1_700_000_000 + i * DAY),
    open: values,
    high: values,
    low: values,
    close: values,
    volume: values.map(() => 0),
  };
}

/** Peaks at the given indexes with the given heights on a flat base of 10. */
function peaks(n: number, at: Record<number, number>, base = 10): number[] {
  return Array.from({ length: n }, (_, i) => at[i] ?? base);
}

describe('findSwings', () => {
  it('finds confirmed highs and lows, earlier tie wins', () => {
    const v = [1, 2, 5, 2, 1, 0, 1, 2, 5, 5, 2, 1, 3, 9];
    expect(findSwings(v, 'high', { strength: 2 }).map((s) => s.index)).toEqual([2, 8]);
    expect(findSwings(v, 'low', { strength: 2 }).map((s) => s.index)).toEqual([5, 11]);
    // index 13 is unconfirmed (no bars after it)
    expect(findSwings(v, 'high', { strength: 2, from: 9 })).toEqual([]);
  });

  it('skips NaN values', () => {
    expect(findSwings([NaN, 1, 3, 1, NaN], 'high', { strength: 1 })).toEqual([
      { index: 2, value: 3, confirmed: true },
    ]);
  });
});

describe('findDivergences', () => {
  it('finds a regular bearish divergence (price HH, oscillator LH)', () => {
    const price = peaks(30, { 8: 20, 20: 25 });
    const osc = peaks(30, { 8: 80, 20: 65 }, 50);
    const [d, ...rest] = findDivergences(bars(price), osc);
    expect(rest).toEqual([]);
    expect(d).toMatchObject({ id: 'd1', kind: 'regular', direction: 'bearish', bars: 12 });
    expect(d!.price.map((p) => [p.index, p.value])).toEqual([
      [8, 20],
      [20, 25],
    ]);
    expect(d!.oscillator.map((p) => p.value)).toEqual([80, 65]);
    expect(d!.priceChangePct).toBeCloseTo(25);
    expect(d!.oscillatorChange).toBe(-15);
  });

  it('finds regular bullish and hidden kinds on lows', () => {
    const price = peaks(40, { 8: 5, 20: 3, 32: 4 }); // LL then HL
    const osc = peaks(40, { 8: 20, 20: 25, 32: 22 }, 50); // HL then LL
    const ds = findDivergences(bars(price), osc);
    expect(ds.map((d) => `${d.kind}-${d.direction}`)).toEqual([
      'hidden-bullish',
      'regular-bullish',
    ]);
    expect(ds.map((d) => d.id)).toEqual(['d1', 'd2']); // most recent first
    expect(findDivergences(bars(price), osc, { kinds: ['regular'] }).map((d) => d.kind)).toEqual([
      'regular',
    ]);
  });

  it('matches an oscillator extreme a bar or two away', () => {
    const price = peaks(30, { 8: 20, 20: 25 });
    const osc = peaks(30, { 9: 80, 19: 65 }, 50);
    const [d] = findDivergences(bars(price), osc);
    expect(d!.oscillator.map((p) => p.index)).toEqual([9, 19]);
  });

  it('ignores agreement, gaps outside the window and missing values', () => {
    const price = peaks(30, { 8: 20, 20: 25 });
    expect(findDivergences(bars(price), peaks(30, { 8: 60, 20: 70 }, 50))).toEqual([]);
    expect(findDivergences(bars(price), peaks(30, { 8: 80, 20: 65 }, 50), { maxBars: 10 })).toEqual(
      [],
    );
    expect(findDivergences(bars(price), new Float64Array(30).fill(NaN))).toEqual([]);
  });

  it('limits to the requested range', () => {
    const price = peaks(30, { 8: 20, 20: 25 });
    const osc = peaks(30, { 8: 80, 20: 65 }, 50);
    expect(findDivergences(bars(price), osc, { from: 10 })).toEqual([]);
  });
});

describe('unconfirmed and wide divergences', () => {
  it('reports a swing still forming at the end when asked', () => {
    const v = [5, 4, 3, 4, 5, 6, 5, 4, 2];
    expect(findSwings(v, 'low', { strength: 2 })).toEqual([
      { index: 2, value: 3, confirmed: true },
    ]);
    expect(findSwings(v, 'low', { strength: 2, includeLast: true }).at(-1)).toEqual({
      index: 8,
      value: 2,
      confirmed: false,
    });
  });

  it('pairs the latest low with the widest clean earlier low', () => {
    // Lows at 8 (10), 18 (9.5, a small dip above the 8->30 line), 30 (6, still forming).
    const price = Array.from({ length: 31 }, (_, i) =>
      i === 8 ? 10 : i === 18 ? 9.5 : i === 30 ? 6 : 15,
    );
    const osc = Array.from({ length: 31 }, (_, i) =>
      i === 8 ? 20 : i === 18 ? 22 : i === 30 ? 25 : 50,
    );
    const [d] = findDivergences(bars(price), osc, { strength: 3 });
    expect(d).toMatchObject({ kind: 'regular', direction: 'bullish', confirmed: false });
    expect(d!.price.map((p) => p.index)).toEqual([8, 30]); // not 18 -> 30
  });
});
