import { describe, expect, it } from 'vitest';
import { atrSeries, lastAtr, roundBoxSize } from './atr';
import { bars } from './test-utils';

const src = bars([
  { o: 10, h: 11, l: 9, c: 10 }, // TR 2
  { o: 10, h: 12, l: 10, c: 11 }, // TR 2
  { o: 11, h: 13, l: 11.5, c: 12 }, // TR 2 -> ATR(3) = 2
  { o: 12, h: 12.5, l: 9, c: 9.5 }, // TR 3.5 -> (2*2 + 3.5) / 3 = 2.5
  { o: 9.5, h: 10, l: 9, c: 9.8 }, // TR 1 -> (2.5*2 + 1) / 3 = 2
]);

describe('atr', () => {
  it('computes Wilder ATR with NaN warm-up', () => {
    const a = Array.from(atrSeries(src, 3));
    expect(a[0]).toBeNaN();
    expect(a[1]).toBeNaN();
    expect(a[2]).toBeCloseTo(2);
    expect(a[3]).toBeCloseTo(2.5);
    expect(a[4]).toBeCloseTo(2);
  });

  it('lastAtr uses the most recent bar and falls back to 1% of the close', () => {
    expect(lastAtr(src, 3)).toBeCloseTo(2);
    expect(lastAtr(src, 10)).toBeCloseTo(0.098);
    expect(lastAtr(bars([]), 14)).toBe(1);
  });

  it('skips NaN bars', () => {
    const s = bars([
      { o: 10, h: 11, l: 9, c: 10 },
      { o: NaN, h: NaN, l: NaN, c: NaN },
      { o: 10, h: 12, l: 10, c: 11 },
    ]);
    const a = atrSeries(s, 2);
    expect(a[1]).toBeNaN();
    expect(a[2]).toBeCloseTo(2);
  });

  it('roundBoxSize rounds to nice tick multiples', () => {
    expect(roundBoxSize(1.2345)).toBe(1.2);
    expect(roundBoxSize(0.0123456, 0.005)).toBe(0.01);
    expect(roundBoxSize(0.001, 0.01)).toBe(0.01);
    expect(roundBoxSize(347)).toBe(350);
    expect(roundBoxSize(0, 0.25)).toBe(0.25);
    expect(roundBoxSize(NaN)).toBeNaN();
  });
});
