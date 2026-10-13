import { describe, expect, it } from 'vitest';
import { lineBreak } from './line-break';
import { closes } from './test-utils';

describe('lineBreak', () => {
  it('reverses only after breaking the 3-line extreme', () => {
    const r = lineBreak(closes([10, 11, 12, 13, 12.5, 11.5, 10.5, 9.5, 9, 11, 13.5]), { lines: 3 });
    const b = r.bars;
    const oc = Array.from({ length: b.length }, (_, i) => [b.open[i], b.close[i]]);
    expect(oc).toEqual([
      [10, 11],
      [11, 12],
      [12, 13],
      [12, 9.5], // 12.5 / 11.5 / 10.5 do not break the low of the last 3 lines (10)
      [9.5, 9],
      [9.5, 13.5], // 11 does not break the high of the last 3 lines (13)
    ]);
    expect(Array.from(r.sourceIndex)).toEqual([1, 2, 3, 7, 8, 10]);
    expect(b.high[3]).toBe(12);
    expect(b.low[3]).toBe(9.5);
  });

  it('a 1-line break reverses on the previous line extreme', () => {
    const r = lineBreak(closes([10, 11, 12, 10.5]), { lines: 1 });
    expect(r.bars.length).toBe(3);
    expect(r.bars.open[2]).toBe(11);
    expect(r.bars.close[2]).toBe(10.5);
  });

  it('handles empty and single inputs', () => {
    expect(lineBreak(closes([]), { lines: 3 }).bars.length).toBe(0);
    expect(lineBreak(closes([5]), { lines: 3 }).bars.length).toBe(0);
  });
});
