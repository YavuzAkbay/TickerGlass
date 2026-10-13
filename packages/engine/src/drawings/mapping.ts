import { intervalSeconds } from '../feed/intervals';
import type { Interval } from '../types';
import type { TradingCalendar } from './calendar';
import type { DrawingPoint } from './types';

/**
 * The displayed series as seen by anchor mapping. Logical index i = displayed
 * bar i (a brick on brick types); fractional and out-of-data indices are
 * valid positions on the time scale.
 */
export interface AnchorTimeline {
  /** Displayed bar times, non-decreasing (bricks may share a time). Read [0, length). */
  readonly time: ArrayLike<number>;
  readonly length: number;
  readonly interval: Interval;
  /** Displayed indices are bricks, not one bar per interval. */
  readonly bricks: boolean;
  /** Open time of the newest underlying (raw) bar; time[length - 1] on time charts. */
  readonly endTime: number;
  /**
   * Session-aware slots past `endTime` (skip weekends and non-trading hours).
   * Absent/null: plain interval steps (overnight gaps count as slots).
   */
  readonly calendar?: TradingCalendar | null;
}

const MONTH = 30 * 86_400;

/** `t` moved by `k` whole intervals (calendar months for M intervals). */
export function stepTime(t: number, k: number, iv: Interval): number {
  if (iv.unit !== 'month') return t + k * intervalSeconds(iv);
  const d = new Date(t * 1000);
  return (
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + k * iv.count,
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
    ) / 1000
  );
}

/** Intervals from `a` to `b` (fractional; inverse of `stepTime` for whole k). */
export function stepsBetween(a: number, b: number, iv: Interval): number {
  if (iv.unit !== 'month') return (b - a) / intervalSeconds(iv);
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  const months =
    (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
  const rest = (b - stepTime(a, months, { unit: 'month', count: 1 })) / MONTH;
  return (months + rest) / iv.count;
}

/** Largest index in [0, n) with time <= t, or -1. */
function indexAtOrBefore(time: ArrayLike<number>, n: number, t: number): number {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** First index of the run of equal times that contains index i. */
function runStart(time: ArrayLike<number>, i: number): number {
  const t = time[i]!;
  let lo = 0;
  let hi = i;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Anchor -> logical bar index (NaN without bars). Rules (docs/drawings.md §3):
 * - before the first bar: extrapolated back by the interval;
 * - inside the data: the bar containing `time` (open <= time < open + interval),
 *   or the next bar when `time` falls into a gap (weekend, overnight);
 * - brick types: the run of bricks at the last brick time <= `time`, offset by `brick`;
 * - from the newest raw bar on: last index + intervals since `endTime` (whole
 *   slots for anchors created there; anything inside the last bar maps to it).
 */
export function timeToLogical(tl: AnchorTimeline, p: Pick<DrawingPoint, 'time' | 'brick'>): number {
  const n = tl.length;
  if (!n) return NaN;
  const t = p.time;
  const time = tl.time;
  if (t < time[0]!) return -stepsBetween(t, time[0]!, tl.interval);
  const i = indexAtOrBefore(time, n, t);
  const cal = tl.calendar;
  // Past the newest raw bar's own span (a calendar may end it early: the short
  // last bar of a day on a 7m grid); a calendar maps non-trading gaps to the next slot.
  if (i === n - 1) {
    let next = stepTime(tl.endTime, 1, tl.interval);
    if (cal) next = Math.min(next, cal.step(tl.endTime, 1));
    if (t >= next)
      return n - 1 + (cal ? cal.slots(tl.endTime, t) : stepsBetween(tl.endTime, t, tl.interval));
  }
  if (tl.bricks) return Math.min(runStart(time, i) + (p.brick ?? 0), i);
  if (i === n - 1 || t < stepTime(time[i]!, 1, tl.interval)) return i;
  return i + 1;
}

/** Logical index (rounded to a bar slot) -> anchor time (+ brick offset), or null without bars. */
export function logicalToTime(
  tl: AnchorTimeline,
  logical: number,
): Pick<DrawingPoint, 'time' | 'brick'> | null {
  const n = tl.length;
  if (!n || !Number.isFinite(logical)) return null;
  const i = Math.round(logical);
  if (i < 0) return { time: stepTime(tl.time[0]!, i, tl.interval) };
  if (i > n - 1) {
    const k = i - (n - 1);
    return {
      time: tl.calendar ? tl.calendar.step(tl.endTime, k) : stepTime(tl.endTime, k, tl.interval),
    };
  }
  const time = tl.time[i]!;
  if (!tl.bricks) return { time };
  const k = i - runStart(tl.time, i);
  return k > 0 ? { time, brick: k } : { time };
}
