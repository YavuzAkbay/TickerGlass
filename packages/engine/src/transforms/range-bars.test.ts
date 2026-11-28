import { describe, expect, it } from 'vitest';
import { rangeBars } from './range-bars';
import { bars, col } from './test-utils';

describe('rangeBars', () => {
  it('splits a big candle into several bars', () => {
    const r = rangeBars(
      bars([
        { o: 100, h: 100, l: 100, c: 100, v: 10 },
        { o: 100, h: 102.5, l: 99.5, c: 102.2, v: 20 }, // walked O -> L -> H -> C
      ]),
      { range: 1 },
    );
    const b = r.bars;
    const rows = Array.from({ length: b.length }, (_, i) => [
      b.open[i],
      b.high[i],
      b.low[i],
      b.close[i],
    ]);
    expect(rows).toEqual([
      [100, 100.5, 99.5, 100.5],
      [100.5, 101.5, 100.5, 101.5],
      [101.5, 102.5, 101.5, 102.2], // still forming
    ]);
    expect(Array.from(r.sourceIndex)).toEqual([1, 1, 1]);
    expect(col(b.volume, 3)).toEqual([10, 0, 20]);
  });

  it('opens the next bar one tick past the close', () => {
    const r = rangeBars(
      bars([
        { o: 100, h: 100, l: 100, c: 100 },
        { o: 98, h: 98, l: 97.5, c: 97.5 }, // gap down, walked O -> H -> L -> C
      ]),
      { range: 1, tick: 0.25 },
    );
    const b = r.bars;
    expect(b.close[0]).toBe(99);
    expect(b.open[1]).toBe(98.75);
    expect(b.close[1]).toBe(97.75);
    expect(b.open[2]).toBe(97.5);
    expect(b.length).toBe(3);
  });

  it('handles empty and single inputs', () => {
    expect(rangeBars(bars([]), { range: 1 }).bars.length).toBe(0);
    expect(rangeBars(bars([{ o: 1, h: 1.5, l: 0.8, c: 1.2 }]), { range: 1 }).bars.length).toBe(1);
  });
});

describe('rangeBars degenerate input', () => {
  it('returns nothing when the range is below float spacing at the price (no hang)', () => {
    const src = bars([
      { o: 60000, h: 60000, l: 60000, c: 60000 },
      { o: 60000, h: 60010, l: 59990, c: 60005 },
    ]);
    expect(rangeBars(src, { range: 1e-13 }).bars.length).toBe(0);
  });

  it('caps the bars emitted for one bad-tick jump and keeps going from the new price', () => {
    const src = bars([
      { o: 100, h: 100, l: 100, c: 100 },
      { o: 100, h: 1e9, l: 100, c: 1e9 }, // 1e9 bars at range 1 without the cap
      { o: 1e9, h: 1e9 + 2, l: 1e9, c: 1e9 + 2 },
    ]);
    const r = rangeBars(src, { range: 1 });
    expect(r.bars.length).toBeLessThanOrEqual(2 * 100_000 + 5);
    expect(r.bars.length).toBeGreaterThan(100_000);
    // The tail resumes at the jumped-to price.
    expect(r.bars.close[r.bars.length - 1]).toBe(1e9 + 2);
  });
});
