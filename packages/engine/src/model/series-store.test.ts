import { describe, expect, it } from 'vitest';
import type { BarColumns } from '../types';
import { SeriesStore } from './series-store';

function cols(times: number[]): BarColumns {
  const f = (k: number) => Float64Array.from(times, (t) => t + k);
  return {
    time: Float64Array.from(times),
    open: f(0.1),
    high: f(0.4),
    low: f(-0.4),
    close: f(0.2),
    volume: f(0),
  };
}

describe('SeriesStore', () => {
  it('upserts: update same time, append newer, ignore older', () => {
    const s = new SeriesStore();
    s.setAll(cols([10, 20, 30]));
    const bar = { time: 30, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 };
    expect(s.upsert(bar)).toBe('update');
    expect(s.last()).toEqual(bar);
    expect(s.upsert({ ...bar, time: 40 })).toBe('append');
    expect(s.length).toBe(4);
    expect(s.upsert({ ...bar, time: 5 })).toBe('ignored');
  });

  it('prepends history and drops overlap', () => {
    const s = new SeriesStore();
    s.setAll(cols([30, 40]));
    expect(s.prepend(cols([10, 20, 30]))).toBe(2);
    expect(Array.from(s.time.subarray(0, s.length))).toEqual([10, 20, 30, 40]);
    expect(s.close[2]).toBeCloseTo(30.2);
  });

  it('grows past initial capacity', () => {
    const s = new SeriesStore();
    for (let t = 0; t < 1000; t++)
      s.upsert({ time: t, open: t, high: t, low: t, close: t, volume: 0 });
    expect(s.length).toBe(1000);
    expect(s.indexAtOrBefore(499.5)).toBe(499);
    expect(s.indexAtOrBefore(-1)).toBe(-1);
  });
});
