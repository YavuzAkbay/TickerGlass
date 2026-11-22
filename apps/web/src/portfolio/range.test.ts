import type { PerformancePoint } from '@tickerglass/portfolio';
import { describe, expect, it } from 'vitest';
import { rangeStart, sliceRange } from './range';

const DAY = 86_400;
const T0 = Date.UTC(2025, 0, 1) / 1000;

/** Daily points; `twr` / `bench` are cumulative percent per day. */
function series(twr: number[], bench?: number[]): PerformancePoint[] {
  return twr.map((v, i) => ({
    t: T0 + i * DAY,
    value: 100 * (1 + v / 100),
    netFlow: 0,
    twr: v,
    ...(bench ? { benchmark: bench[i]! } : {}),
  }));
}

describe('rangeStart', () => {
  const last = Date.UTC(2026, 4, 15) / 1000;
  it('counts calendar ranges back from the last point', () => {
    expect(rangeStart('1M', last)).toBe(Date.UTC(2026, 3, 15) / 1000);
    expect(rangeStart('3M', last)).toBe(Date.UTC(2026, 1, 15) / 1000);
    expect(rangeStart('1Y', last)).toBe(Date.UTC(2025, 4, 15) / 1000);
    expect(rangeStart('YTD', last)).toBe(Date.UTC(2025, 11, 31) / 1000);
    expect(rangeStart('All', last)).toBe(-Infinity);
  });
});

describe('sliceRange', () => {
  it('is null without points', () => {
    expect(sliceRange([], 'All')).toBeNull();
  });

  it('All keeps the series from its first point', () => {
    const r = sliceRange(series([0, 10, 21]), 'All')!;
    r.points.forEach((p, i) => expect(p.portfolio).toBeCloseTo([0, 10, 21][i]!));
    expect(r.twr).toBeCloseTo(21);
  });

  it('rebases to the base point of the range', () => {
    // 200 days: 0% then +1%/day compounding; 1M base = a point ~30 days before the end
    const twr = Array.from({ length: 200 }, (_, i) => (1.01 ** i - 1) * 100);
    const r = sliceRange(series(twr), '1M')!;
    expect(r.points[0]!.portfolio).toBe(0);
    const n = r.points.length;
    // growth over n-1 days of +1%/day
    expect(r.twr).toBeCloseTo((1.01 ** (n - 1) - 1) * 100, 6);
    expect(n).toBeGreaterThan(28);
    expect(n).toBeLessThan(33);
  });

  it('rebases the benchmark with the same base', () => {
    const r = sliceRange(series([0, 10, 21, 33.1], [0, 5, 10.25, 15.7625]), 'All')!;
    expect(r.benchmarkReturn).toBeCloseTo(15.7625);
    const sub = sliceRange(series([0, 10, 21, 33.1], [0, 5, 10.25, 15.7625]), '1M')!;
    expect(sub.points).toHaveLength(4);
  });

  it('omits the benchmark when a point lacks it', () => {
    const pts = series([0, 1, 2], [0, 1, 2]);
    delete (pts[1] as { benchmark?: number }).benchmark;
    const r = sliceRange(pts, 'All')!;
    expect(r.benchmarkReturn).toBeUndefined();
    expect(r.points[0]!.benchmark).toBeUndefined();
  });

  it('measures the drawdown inside the range only', () => {
    // 0 -> +100% -> +50% (a 25% fall from peak 2.0 to 1.5)
    const r = sliceRange(series([0, 100, 50]), 'All')!;
    expect(r.maxDrawdownPct).toBeCloseTo(25);
  });

  it('YTD uses the last close of the previous year as its base', () => {
    const pts: PerformancePoint[] = [
      { t: Date.UTC(2025, 11, 30) / 1000, value: 100, netFlow: 0, twr: 10 },
      { t: Date.UTC(2025, 11, 31) / 1000, value: 110, netFlow: 0, twr: 20 },
      { t: Date.UTC(2026, 0, 2) / 1000, value: 132, netFlow: 0, twr: 44 },
    ];
    const r = sliceRange(pts, 'YTD')!;
    expect(r.points).toHaveLength(2);
    expect(r.twr).toBeCloseTo((1.44 / 1.2 - 1) * 100);
  });
});
