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

/** Compare against a reference allowing tiny float differences; NaN must match. */
function expectClose(got: number[], want: number[]): void {
  expect(got.length).toBe(want.length);
  got.forEach((g, i) => {
    if (Number.isNaN(want[i]!)) expect(g, `[${i}]`).toBeNaN();
    else expect(g, `[${i}]`).toBeCloseTo(want[i]!, 9);
  });
}

describe('phase 12 ta primitives with save/restore', () => {
  const xs = values(400, 7);
  const ys = values(400, 19).map((v, i) => v + Math.sin(i));

  it('cum is a running total', () => {
    let t = 0;
    expect(streamWithRewinds((ta) => ta.cum(), xs)).toEqual(xs.map((x) => (t += x)));
    const scope = new TaScope();
    const c = scope.ta.cum();
    expect([NaN, 1, 2, NaN, 3].map((x) => c.update(x))).toEqual([NaN, 1, 3, NaN, 6]);
  });

  for (const n of [1, 2, 5, 17]) {
    it(`highestBars/lowestBars(${n}) give the most recent extreme's offset`, () => {
      const offset = (w: number[], pick: number) => w.lastIndexOf(pick) - (w.length - 1);
      expect(streamWithRewinds((ta) => ta.highestBars(n), xs)).toEqual(
        naive(xs, n, (w) => offset(w, Math.max(...w))),
      );
      expect(streamWithRewinds((ta) => ta.lowestBars(n), xs)).toEqual(
        naive(xs, n, (w) => offset(w, Math.min(...w))),
      );
    });

    it(`change(${n}) is x - x[n]`, () => {
      expect(streamWithRewinds((ta) => ta.change(n), xs)).toEqual(
        naive(xs, n + 1, (w) => w[n]! - w[0]!),
      );
    });

    it(`linreg(${n}) matches a least-squares fit`, () => {
      for (const off of [0, 1, -2]) {
        const want = naive(xs, n, (w) => {
          const m = w.length;
          const mx = (m - 1) / 2;
          const my = w.reduce((a, v) => a + v, 0) / m;
          let num = 0;
          let den = 0;
          w.forEach((v, x) => {
            num += (x - mx) * (v - my);
            den += (x - mx) ** 2;
          });
          const b = den ? num / den : 0;
          return my - b * mx + b * (m - 1 - off);
        });
        expectClose(
          streamWithRewinds((ta) => ta.linreg(n, off), xs),
          want,
        );
      }
    });

    it(`percentrank(${n}) counts previous values <= current`, () => {
      expectClose(
        streamWithRewinds((ta) => ta.percentrank(n), xs),
        naive(xs, n + 1, (w) => (100 * w.slice(0, n).filter((v) => v <= w[n]!).length) / n),
      );
    });

    it(`alma(${n}) matches the gaussian-weighted mean`, () => {
      const want = naive(xs, n, (w) => {
        const m = 0.85 * (n - 1);
        const s = n / 6;
        let sum = 0;
        let norm = 0;
        w.forEach((v, k) => {
          const wk = Math.exp(-((k - m) ** 2) / (2 * s * s));
          sum += wk * v;
          norm += wk;
        });
        return sum / norm;
      });
      expectClose(
        streamWithRewinds((ta) => ta.alma(n, 0.85, 6), xs),
        want,
      );
    });

    it(`correlation(${n}) matches Pearson`, () => {
      const scope = new TaScope();
      const c = scope.ta.correlation(n);
      scope.open = false;
      const got = xs.map((x, i) => {
        scope.save();
        c.update(x + 50, ys[i]! - 3);
        scope.restore();
        return c.update(x, ys[i]!);
      });
      const want = xs.map((_, i) => {
        if (i < n - 1) return NaN;
        const a = xs.slice(i - n + 1, i + 1);
        const b = ys.slice(i - n + 1, i + 1);
        const ma = a.reduce((s, v) => s + v, 0) / n;
        const mb = b.reduce((s, v) => s + v, 0) / n;
        let sab = 0;
        let saa = 0;
        let sbb = 0;
        for (let k = 0; k < n; k++) {
          sab += (a[k]! - ma) * (b[k]! - mb);
          saa += (a[k]! - ma) ** 2;
          sbb += (b[k]! - mb) ** 2;
        }
        return saa * sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
      });
      expectClose(got, want);
    });
  }

  it('swma weights 1-2-2-1', () => {
    expectClose(
      streamWithRewinds((ta) => ta.swma(), xs),
      naive(xs, 4, (w) => (w[0]! + 2 * w[1]! + 2 * w[2]! + w[3]!) / 6),
    );
  });

  for (const [l, r] of [
    [1, 1],
    [2, 3],
    [5, 0],
    [10, 10],
  ] as const) {
    it(`pivotHigh/pivotLow(${l}, ${r}) find strict window extremes ${r} values back`, () => {
      const pivot = (w: number[], high: boolean) => {
        const c = w[l]!;
        return w.every((v, k) => k === l || (high ? c > v : c < v)) ? c : NaN;
      };
      expect(streamWithRewinds((ta) => ta.pivotHigh(l, r), xs)).toEqual(
        naive(xs, l + r + 1, (w) => pivot(w, true)),
      );
      expect(streamWithRewinds((ta) => ta.pivotLow(l, r), xs)).toEqual(
        naive(xs, l + r + 1, (w) => pivot(w, false)),
      );
    });
  }

  it('reject invalid parameters', () => {
    const ta = new TaScope().ta;
    expect(() => ta.change(0)).toThrow();
    expect(() => ta.pivotHigh(-1, 2)).toThrow();
    expect(() => ta.alma(9, 0.85, 0)).toThrow();
    expect(() => ta.linreg(5, NaN)).toThrow();
  });
});
