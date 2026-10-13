import { describe, expect, it } from 'vitest';
import type { OhlcvSource, TransformResult } from '../chart-types';
import { lastAtr } from './atr';
import { heikinAshi } from './heikin-ashi';
import { kagi } from './kagi';
import { lineBreak } from './line-break';
import { pointFigure } from './point-figure';
import { rangeBars } from './range-bars';
import { renko } from './renko';
import { randomWalk } from './test-utils';

const EPS = 1e-9;

function checkBars(b: OhlcvSource): void {
  let prevT = -Infinity;
  for (let i = 0; i < b.length; i++) {
    const o = b.open[i]!;
    const c = b.close[i]!;
    if (Number.isNaN(o)) continue; // heikin ashi keeps NaN source bars
    expect(b.time[i]!).toBeGreaterThanOrEqual(prevT);
    prevT = b.time[i]!;
    expect(b.high[i]!).toBeGreaterThanOrEqual(Math.max(o, c) - EPS);
    expect(b.low[i]!).toBeLessThanOrEqual(Math.min(o, c) + EPS);
  }
}

function checkResult(r: TransformResult, n: number): void {
  checkBars(r.bars);
  expect(r.sourceIndex.length).toBe(r.bars.length);
  let prev = 0;
  for (const s of r.sourceIndex) {
    expect(s).toBeGreaterThanOrEqual(prev);
    expect(s).toBeLessThan(n);
    prev = s;
  }
}

type Run = (src: OhlcvSource, box: number) => TransformResult | OhlcvSource;

const runs: Record<string, Run> = {
  heikinAshi: (src) => heikinAshi(src),
  renkoClose: (src, box) => renko(src, { boxSize: box, source: 'close', wicks: true }),
  renkoHl: (src, box) => renko(src, { boxSize: box, source: 'hl', wicks: true }),
  lineBreak: (src) => lineBreak(src, { lines: 3 }),
  kagiFixed: (src, box) => kagi(src, { reversal: box, reversalMode: 'fixed', source: 'close' }),
  kagiPercent: (src) => kagi(src, { reversal: 1, reversalMode: 'percent', source: 'hl' }),
  pointFigure: (src, box) => pointFigure(src, { boxSize: box, reversal: 3, source: 'hl' }),
  rangeBars: (src, box) => rangeBars(src, { range: box }),
};

describe('transform invariants on a 10k random walk', () => {
  const src = randomWalk(10_000);
  const box = lastAtr(src, 14);

  for (const [name, run] of Object.entries(runs)) {
    it(name, () => {
      const r = run(src, box);
      if ('sourceIndex' in r) {
        expect(r.bars.length).toBeGreaterThan(0);
        checkResult(r, src.length);
      } else {
        expect(r.length).toBe(src.length);
        checkBars(r);
      }
    });
  }

  it('renko bricks are exactly one box', () => {
    for (const source of ['close', 'hl'] as const) {
      const b = renko(src, { boxSize: box, source, wicks: false }).bars;
      for (let i = 0; i < b.length; i++)
        expect(Math.abs(b.close[i]! - b.open[i]!)).toBeCloseTo(box, 9);
    }
  });

  it('completed range bars span exactly the range', () => {
    const b = rangeBars(src, { range: box }).bars;
    for (let i = 0; i < b.length - 1; i++) expect(b.high[i]! - b.low[i]!).toBeCloseTo(box, 9);
    expect(b.high[b.length - 1]! - b.low[b.length - 1]!).toBeLessThanOrEqual(box + EPS);
  });

  it('kagi segments alternate direction except at splits', () => {
    const r = kagi(src, { reversal: box, reversalMode: 'fixed', source: 'close' });
    const yang = r.extra.kagiYang ?? new Uint8Array(0);
    expect(yang.length).toBe(r.bars.length);
    for (let i = 1; i < r.bars.length; i++) {
      const prevUp = r.bars.close[i - 1]! > r.bars.open[i - 1]!;
      const up = r.bars.close[i]! > r.bars.open[i]!;
      // Same direction twice in a row only happens at a thickness split.
      if (prevUp === up) expect(yang[i]).not.toBe(yang[i - 1]);
    }
  });
});

describe('transform performance (100k bars < 50ms)', () => {
  const src = randomWalk(100_000, 7);
  const box = lastAtr(src, 14);
  for (const [name, run] of Object.entries(runs)) {
    it(name, () => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) {
        const t0 = performance.now();
        run(src, box);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(50);
    });
  }
  it('atr', () => {
    const t0 = performance.now();
    lastAtr(src, 14);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
