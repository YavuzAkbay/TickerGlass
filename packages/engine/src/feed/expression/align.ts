import type { Interval, IntervalUnit } from '../../types';
import { intervalSeconds, isIntraday } from '../intervals';
import { createBucketContext, localDay, type BucketContext } from '../resample';

const DAY = 86_400;

/** 'instant': key = UTC open time. 'calendar': key = local trading date. */
export type AlignMode = 'instant' | 'calendar';

export function alignModeFor(interval: Interval): AlignMode {
  return isIntraday(interval) ? 'instant' : 'calendar';
}

/**
 * Context for calendar keys of one leg. Legs whose stamps are all UTC midnights
 * (e.g. crypto) are keyed in UTC regardless of `timezone`.
 */
export function calendarContext(
  timezone: string | null,
  times: ArrayLike<number>,
  n: number,
): BucketContext {
  let utc = true;
  for (let i = 0; i < n; i++) {
    if ((times[i] ?? 0) % DAY !== 0) {
      utc = false;
      break;
    }
  }
  return createBucketContext({ timezone: utc ? null : timezone, session: null });
}

/** Join keys for `n` ascending times. */
export function alignKeys(
  times: ArrayLike<number>,
  n: number,
  mode: AlignMode,
  ctx: BucketContext,
  out?: Float64Array,
): Float64Array {
  const keys = out ?? new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = times[i] ?? NaN;
    keys[i] = mode === 'instant' ? t : localDay(t, ctx) * DAY;
  }
  return keys;
}

const BASE_STALE: Record<IntervalUnit, number> = {
  minute: 4 * DAY,
  hour: 4 * DAY,
  day: 10 * DAY,
  week: 21 * DAY,
  month: 93 * DAY,
};

/** Longest gap (seconds) a leg value is carried forward. */
export function maxStaleSeconds(interval: Interval): number {
  return Math.max(BASE_STALE[interval.unit], 3 * intervalSeconds(interval));
}

/**
 * Left as-of join: for each target key, the last leg row with key <= target
 * (duplicates: last wins) if no older than `maxStale`, else -1. O(tn + ln);
 * both inputs ascending.
 */
export function asOfIndex(
  target: ArrayLike<number>,
  tn: number,
  leg: ArrayLike<number>,
  ln: number,
  maxStale: number,
  out?: Int32Array,
): Int32Array {
  const res = out ?? new Int32Array(tn);
  let j = -1;
  for (let i = 0; i < tn; i++) {
    const t = target[i] ?? NaN;
    while (j + 1 < ln && (leg[j + 1] ?? NaN) <= t) j++;
    res[i] = j >= 0 && t - (leg[j] ?? NaN) <= maxStale ? j : -1;
  }
  return res;
}

/** asOfIndex for a single key, by binary search. */
export function asOfIndexAt(
  key: number,
  leg: ArrayLike<number>,
  ln: number,
  maxStale: number,
): number {
  // First index with leg[i] > key, minus one.
  let lo = 0;
  let hi = ln;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((leg[mid] ?? NaN) <= key) lo = mid + 1;
    else hi = mid;
  }
  const j = lo - 1;
  return j >= 0 && key - (leg[j] ?? NaN) <= maxStale ? j : -1;
}

/** First index with keys[i] >= key (n if none). */
export function lowerBound(keys: ArrayLike<number>, n: number, key: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((keys[mid] ?? NaN) < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
