/** Performance ranges: slicing the daily TWR series and rebasing it to the range start. Pure. */
import type { PerformancePoint } from '@tickerglass/portfolio';

export const RANGES = ['1M', '3M', 'YTD', '1Y', 'All'] as const;
export type RangeId = (typeof RANGES)[number];

const DAY_S = 86_400;

/** Unix seconds of the range start, counted back from the last point `last` (unix seconds). */
export function rangeStart(range: RangeId, last: number): number {
  const d = new Date(last * 1000);
  switch (range) {
    case '1M':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate()) / 1000;
    case '3M':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, d.getUTCDate()) / 1000;
    case 'YTD':
      // The year's first point is the base, so the base is the last close of the year before.
      return Date.UTC(d.getUTCFullYear() - 1, 11, 31) / 1000;
    case '1Y':
      return Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate()) / 1000;
    case 'All':
      return -Infinity;
  }
}

export interface RangePoint {
  t: number;
  /** Percent since the range start. */
  portfolio: number;
  benchmark?: number;
}

export interface RangeResult {
  points: RangePoint[];
  /** Percent over the range. */
  twr: number;
  benchmarkReturn?: number;
  /** Largest peak-to-trough fall inside the range, percent (positive). */
  maxDrawdownPct: number;
}

const growth = (pct: number) => 1 + pct / 100;
const rebased = (pct: number, basePct: number) => (growth(pct) / growth(basePct) - 1) * 100;

/**
 * Points of `range`, each return restated from the range start (the first point at or after the
 * range start, or the last point before it for the base so the first day's move counts).
 * Benchmark values are rebased only when every point of the range has one.
 */
export function sliceRange(
  points: readonly PerformancePoint[],
  range: RangeId,
): RangeResult | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1]!.t;
  const start = rangeStart(range, last);
  // Base = last point at or before the start; if none, the first point.
  let baseIdx = 0;
  if (Number.isFinite(start))
    for (let i = 0; i < points.length; i++) {
      if (points[i]!.t <= start) baseIdx = i;
      else break;
    }
  const slice = points.slice(baseIdx);
  const base = slice[0]!;
  const withBench = slice.every((p) => p.benchmark !== undefined);
  const out: RangePoint[] = slice.map((p) => ({
    t: p.t,
    portfolio: rebased(p.twr, base.twr),
    ...(withBench ? { benchmark: rebased(p.benchmark as number, base.benchmark as number) } : {}),
  }));
  let peak = 1;
  let maxDd = 0;
  for (const p of out) {
    const g = growth(p.portfolio);
    if (g > peak) peak = g;
    else if (peak > 0) maxDd = Math.max(maxDd, (1 - g / peak) * 100);
  }
  const lastPt = out[out.length - 1]!;
  return {
    points: out,
    twr: lastPt.portfolio,
    ...(withBench && lastPt.benchmark !== undefined ? { benchmarkReturn: lastPt.benchmark } : {}),
    maxDrawdownPct: maxDd,
  };
}

/** Days spanned by `points` (for "need more history" hints). */
export const spanDays = (points: readonly PerformancePoint[]): number =>
  points.length < 2 ? 0 : (points[points.length - 1]!.t - points[0]!.t) / DAY_S;
