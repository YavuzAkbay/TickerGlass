import { describe, expect, it } from 'vitest';
import { TaScope } from '../src/ta';
import type { Streaming, Ta } from '../src/types';

/** Deterministic pseudo-random values with many ties (exercise the deque). */
function values(n: number, seed = 3): number[] {
  let s = seed;
  return Array.from({ length: n }, () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return Math.floor((s / 2147483648) * 20);
  });
}

function naive(xs: number[], n: number, fn: (w: number[]) => number): number[] {
  return xs.map((_, i) => (i < n - 1 ? NaN : fn(xs.slice(i - n + 1, i + 1))));
}

/**
 * Feed xs; before each value save, feed a different value, restore, then
 * feed the real one (a live tick being rewound), sometimes twice.
 */
function streamWithRewinds(make: (ta: Ta) => Streaming, xs: number[]): number[] {
  const scope = new TaScope();
  const s = make(scope.ta);
  scope.open = false;
  return xs.map((x, i) => {
    scope.save();
    s.update(x + 100 * ((i % 3) - 1));
    scope.restore();
    if (i % 2) {
      s.update(-x);
      scope.restore();
    }
    return s.update(x);
  });
}

describe('ta primitives with save/restore', () => {
  const xs = values(500);
  for (const n of [1, 2, 5, 17]) {
    it(`highest/lowest(${n}) match a window scan`, () => {
      expect(streamWithRewinds((ta) => ta.highest(n), xs)).toEqual(
        naive(xs, n, (w) => Math.max(...w)),
      );
      expect(streamWithRewinds((ta) => ta.lowest(n), xs)).toEqual(
        naive(xs, n, (w) => Math.min(...w)),
      );
    });

    it(`wma(${n}) matches the weighted mean`, () => {
      const want = naive(
        xs,
        n,
        (w) => w.reduce((a, v, k) => a + v * (k + 1), 0) / ((n * (n + 1)) / 2),
      );
      const got = streamWithRewinds((ta) => ta.wma(n), xs);
      got.forEach((g, i) => {
        if (Number.isNaN(want[i]!)) expect(g).toBeNaN();
        else expect(g).toBeCloseTo(want[i]!, 9);
      });
    });

    it(`dev(${n}) matches the mean absolute deviation`, () => {
      const want = naive(xs, n, (w) => {
        const m = w.reduce((a, v) => a + v, 0) / n;
        return w.reduce((a, v) => a + Math.abs(v - m), 0) / n;
      });
      const got = streamWithRewinds((ta) => ta.dev(n), xs);
      got.forEach((g, i) => {
        if (Number.isNaN(want[i]!)) expect(g).toBeNaN();
        else expect(g).toBeCloseTo(want[i]!, 9);
      });
    });
  }

  it('vwma weights by volume and skips leading NaNs', () => {
    const scope = new TaScope();
    const v = scope.ta.vwma(2);
    expect(v.update(NaN, 1)).toBeNaN();
    expect(v.update(1, 1)).toBeNaN();
    expect(v.update(4, 3)).toBe((1 + 12) / 4);
    expect(v.update(2, 1)).toBe((12 + 2) / 4);
  });

  it('extremes skip leading NaNs and ignore later ones', () => {
    const scope = new TaScope();
    const h = scope.ta.highest(2);
    expect([NaN, 1, 3, NaN, 2, 1].map((x) => h.update(x))).toEqual([NaN, NaN, 3, NaN, 3, 2]);
  });
});
