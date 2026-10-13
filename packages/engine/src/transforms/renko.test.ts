import { describe, expect, it } from 'vitest';
import { renko } from './renko';
import { bars, closes, col } from './test-utils';

describe('renko', () => {
  // Up 5 boxes, 1-box dip (no brick), then 2 boxes down from the top (reversal).
  const path = [100, 101, 102, 103, 104, 105, 104, 103];

  it('builds up bricks, ignores a 1-box dip and reverses after 2 boxes', () => {
    const r = renko(closes(path), { boxSize: 1, source: 'close', wicks: false });
    const b = r.bars;
    expect(b.length).toBe(6);
    const oc = Array.from({ length: b.length }, (_, i) => [b.open[i], b.close[i]]);
    expect(oc).toEqual([
      [100, 101],
      [101, 102],
      [102, 103],
      [103, 104],
      [104, 105],
      [104, 103],
    ]);
    expect(Array.from(r.sourceIndex)).toEqual([1, 2, 3, 4, 5, 7]);
    expect(b.time[5]).toBe(7 * 60);
    expect(r.extra.boxSize).toBe(1);
  });

  it('emits several bricks from one bar with the same time; volume goes to the first', () => {
    const r = renko(
      bars([
        { o: 100, h: 100, l: 100, c: 100, v: 2 },
        { o: 100, h: 103, l: 100, c: 103, v: 3 },
      ]),
      {
        boxSize: 1,
        source: 'close',
        wicks: false,
      },
    );
    expect(r.bars.length).toBe(3);
    expect(Array.from(r.sourceIndex)).toEqual([1, 1, 1]);
    expect(col(r.bars.time, 3)).toEqual([60, 60, 60]);
    expect(col(r.bars.volume, 3)).toEqual([5, 0, 0]);
  });

  it('wicks show the opposite extreme since the previous brick', () => {
    const src = bars(
      path.map((c, i) => {
        if (i === 0) return { o: c, h: c, l: 99.7, c };
        if (i === 1) return { o: c, h: c, l: 99.5, c };
        if (i === 6) return { o: c, h: 104, l: 103.5, c };
        if (i === 7) return { o: c, h: 104.2, l: 102.8, c };
        return { o: c, h: c, l: c, c };
      }),
    );
    const on = renko(src, { boxSize: 1, source: 'close', wicks: true }).bars;
    expect(on.low[0]).toBe(99.5);
    expect(on.high[0]).toBe(101);
    expect(on.low[1]).toBe(101);
    expect(on.high[5]).toBe(104.2);
    expect(on.low[5]).toBe(103);
    const off = renko(src, { boxSize: 1, source: 'close', wicks: false }).bars;
    expect(off.low[0]).toBe(100);
    expect(off.high[5]).toBe(104);
  });

  it("'hl' source uses highs in up moves and lows in down moves", () => {
    const src = bars([
      { o: 100, h: 100.4, l: 99.6, c: 100 },
      { o: 100, h: 102.3, l: 99.8, c: 101.5 },
      { o: 101.5, h: 101.9, l: 99.9, c: 100.2 },
    ]);
    const hl = renko(src, { boxSize: 1, source: 'hl', wicks: false });
    expect(hl.bars.length).toBe(3);
    expect(col(hl.bars.close, 3)).toEqual([101, 102, 100]);
    expect(Array.from(hl.sourceIndex)).toEqual([1, 1, 2]);
    const cl = renko(src, { boxSize: 1, source: 'close', wicks: false });
    expect(cl.bars.length).toBe(1);
  });

  it('handles empty, single, NaN bars and an invalid box size', () => {
    const opts = { boxSize: 1, source: 'close', wicks: true } as const;
    expect(renko(closes([]), opts).bars.length).toBe(0);
    expect(renko(closes([100]), opts).bars.length).toBe(0);
    expect(renko(closes([100, NaN, 102]), opts).bars.length).toBe(2);
    expect(renko(closes([100, 102]), { ...opts, boxSize: 0 }).bars.length).toBe(0);
  });
});
