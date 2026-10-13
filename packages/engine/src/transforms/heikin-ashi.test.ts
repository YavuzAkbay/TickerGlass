import { describe, expect, it } from 'vitest';
import { MutableOhlcv } from './buffers';
import { heikinAshi, heikinAshiUpdateLast } from './heikin-ashi';
import { bars } from './test-utils';

const input = [
  { o: 10, h: 12, l: 9, c: 11, v: 5 },
  { o: 11, h: 13, l: 10, c: 12, v: 6 },
  { o: 12, h: 12.5, l: 8, c: 9, v: 7 },
];
// [open, high, low, close]
const expected = [
  [10.5, 12, 9, 10.5],
  [10.5, 13, 10, 11.5],
  [11, 12.5, 8, 10.375],
];

function row(s: MutableOhlcv, i: number): number[] {
  return [s.open[i]!, s.high[i]!, s.low[i]!, s.close[i]!];
}

describe('heikinAshi', () => {
  it('matches hand-computed values', () => {
    const src = bars(input);
    const ha = heikinAshi(src);
    expect(ha.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(row(ha, i)).toEqual(expected[i]);
      expect(ha.time[i]).toBe(src.time[i]);
      expect(ha.volume[i]).toBe(src.volume[i]);
    }
  });

  it('handles empty, single and NaN bars', () => {
    expect(heikinAshi(bars([])).length).toBe(0);
    expect(row(heikinAshi(bars([input[0]!])), 0)).toEqual(expected[0]);
    const ha = heikinAshi(bars([input[0]!, { o: NaN, h: NaN, l: NaN, c: NaN }, input[1]!]));
    expect(ha.open[1]).toBeNaN();
    expect(row(ha, 2)).toEqual(expected[1]);
  });

  it('updateLast recomputes the last bar and appends new ones', () => {
    const src = bars(input.slice(0, 2));
    const ha = heikinAshi(src);
    src.write(1, 60, 11, 13, 10, 12, 6);
    expect(heikinAshiUpdateLast(src, ha)).toBe(ha);
    expect(row(ha, 1)).toEqual(expected[1]);
    src.push(120, 12, 12.5, 8, 9, 7);
    heikinAshiUpdateLast(src, ha);
    expect(ha.length).toBe(3);
    expect(row(ha, 2)).toEqual(expected[2]);
    // Tick on the live bar changes only that bar.
    src.write(2, 120, 12, 14, 8, 13, 8);
    heikinAshiUpdateLast(src, ha);
    expect(row(ha, 2)).toEqual([11, 14, 8, 11.75]);
    expect(row(ha, 1)).toEqual(expected[1]);
  });
});
