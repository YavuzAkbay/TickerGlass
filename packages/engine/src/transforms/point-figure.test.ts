import { describe, expect, it } from 'vitest';
import { pointFigure } from './point-figure';
import { bars, closes, col } from './test-utils';

describe('pointFigure', () => {
  it('builds columns with a 3-box reversal', () => {
    const r = pointFigure(closes([10, 11, 12, 13, 11, 10, 9, 10, 12, 13]), {
      boxSize: 1,
      reversal: 3,
      source: 'close',
    });
    const b = r.bars;
    expect(b.length).toBe(3);
    const oc = Array.from({ length: b.length }, (_, i) => [b.open[i], b.close[i]]);
    expect(oc).toEqual([
      [10, 13], // X
      [12, 9], // O starts one box below the X top; 11 alone was not a 3-box reversal
      [10, 13], // X
    ]);
    expect(Array.from(r.extra.pfDirection ?? [])).toEqual([1, -1, 1]);
    expect(col(b.time, 3)).toEqual([60, 300, 480]);
    expect(Array.from(r.sourceIndex)).toEqual([3, 6, 9]);
    expect(col(b.volume, 3)).toEqual([5, 3, 2]);
    expect(r.extra.boxSize).toBe(1);
  });

  it("'hl' extends with highs before testing lows", () => {
    const r = pointFigure(
      bars([
        { o: 10, h: 10, l: 10, c: 10 },
        { o: 10, h: 12.4, l: 9.9, c: 12 },
        { o: 12, h: 13.2, l: 9, c: 9.5 }, // extends to 13; the low reversal is ignored
        { o: 9.5, h: 10, l: 9.8, c: 9.9 }, // ceil(9.8) = 10 <= 13 - 3 -> O column
      ]),
      { boxSize: 1, reversal: 3, source: 'hl' },
    );
    expect(r.bars.length).toBe(2);
    expect(r.bars.close[0]).toBe(13);
    expect(r.bars.open[1]).toBe(12);
    expect(r.bars.close[1]).toBe(10);
  });

  it('handles empty and single inputs', () => {
    const opts = { boxSize: 1, reversal: 3, source: 'close' } as const;
    expect(pointFigure(closes([]), opts).bars.length).toBe(0);
    expect(pointFigure(closes([5]), opts).bars.length).toBe(0);
  });
});
