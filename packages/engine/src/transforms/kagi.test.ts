import { describe, expect, it } from 'vitest';
import { kagi } from './kagi';
import { closes, col } from './test-utils';

describe('kagi', () => {
  it('switches yang / yin and splits segments at the shoulder / waist', () => {
    const r = kagi(closes([10, 13, 12, 15, 11, 8, 14, 16]), {
      reversal: 2,
      reversalMode: 'fixed',
      source: 'close',
    });
    const b = r.bars;
    const oc = Array.from({ length: b.length }, (_, i) => [b.open[i], b.close[i]]);
    expect(oc).toEqual([
      [10, 15],
      [15, 10], // yang until the waist (10) breaks...
      [10, 8], // ...then yin
      [8, 15], // yin until the shoulder (15) is exceeded...
      [15, 16], // ...then yang (in-progress segment)
    ]);
    expect(Array.from(r.extra.kagiYang ?? [])).toEqual([1, 1, 0, 0, 1]);
    expect(Array.from(r.sourceIndex)).toEqual([3, 5, 5, 7, 7]);
  });

  it('percent reversal scales with the extreme', () => {
    const pct = kagi(closes([100, 112, 101]), {
      reversal: 10,
      reversalMode: 'percent',
      source: 'close',
    });
    expect(pct.bars.length).toBe(1); // 11 < 10% of 112
    const fixed = kagi(closes([100, 112, 101]), {
      reversal: 10,
      reversalMode: 'fixed',
      source: 'close',
    });
    expect(fixed.bars.length).toBe(2);
    const pct2 = kagi(closes([100, 112, 101, 95]), {
      reversal: 10,
      reversalMode: 'percent',
      source: 'close',
    });
    // 95 reverses (17 >= 11.2) and also breaks the first waist (100), so it is split.
    expect(pct2.bars.length).toBe(3);
    expect(col(pct2.bars.close, 3)).toEqual([112, 100, 95]);
    expect(Array.from(pct2.extra.kagiYang ?? [])).toEqual([1, 1, 0]);
  });

  it('handles empty, single and flat inputs', () => {
    const opts = { reversal: 1, reversalMode: 'fixed', source: 'close' } as const;
    expect(kagi(closes([]), opts).bars.length).toBe(0);
    expect(kagi(closes([5]), opts).bars.length).toBe(0);
    expect(kagi(closes([5, 5, 5]), opts).bars.length).toBe(0);
  });
});
