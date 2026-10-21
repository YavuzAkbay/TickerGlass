import { logicalToTime, stepTime, timeToLogical, type AnchorTimeline } from '../drawings/mapping';
import { calendarContext } from '../feed/expression/align';
import { intervalSeconds, isIntraday } from '../feed/intervals';
import { localDay } from '../feed/resample';
import type { Interval } from '../types';

const DAY = 86_400;
/** Tolerance for whole slots computed in floating point. */
const EPS = 1e-9;

/** A bar time on one chart, to be shown on another chart (crosshair, view edge). */
export interface SyncTimeRef {
  /** Open time (unix s) of the source bar. */
  time: number;
  /** Interval of the source chart. */
  interval: Interval;
  /** Exchange timezone (IANA) of the source symbol; null = UTC. */
  timezone: string | null;
}

/** Number of indices in [0, n) whose key is <= `target` (keys ascending). */
function countAtOrBefore(n: number, key: (i: number) => number, target: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(mid) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in [0, n) whose key is >= `target` (n if none). */
function firstAtOrAfter(n: number, key: (i: number) => number, target: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Logical bar index on chart `dst` for the source bar `src` (NaN when `dst`
 * has no bars or the time is not finite). The result is a whole slot index;
 * it may lie before the first or after the last bar.
 *
 * 1. Both intervals daily or longer: bars are matched by calendar date, each
 *    in its own exchange timezone (the compare-series keys: a leg whose stamps
 *    are all UTC midnights is dated in UTC). A Tokyo session and a New York
 *    session of the same date line up even though they are hours apart.
 *    Otherwise bars are matched by instant (unix time).
 * 2. `dst` interval >= `src` interval: the `dst` bar containing the time, i.e.
 *    the last bar opening at or before it (a weekend maps to Friday's bar).
 * 3. `dst` interval < `src` interval: the first `dst` bar opening at or after
 *    the time, if it opens before the source bar ends; else rule 2.
 * 4. Outside the loaded bars: extrapolated by `timeToLogical` (calendar-aware
 *    slots into the future, plain interval steps into the past), then snapped
 *    to a whole slot by rules 2 and 3.
 *
 * Brick charts (no fixed time per slot) get the first brick of the run at or
 * before the time, by instant.
 */
export function mapSyncTime(
  src: SyncTimeRef,
  dst: AnchorTimeline,
  dstTimezone: string | null,
): number {
  const n = dst.length;
  if (!n || !Number.isFinite(src.time)) return NaN;
  const time = dst.time;
  const coarser = intervalSeconds(dst.interval) >= intervalSeconds(src.interval);
  const byDate = !dst.bricks && !isIntraday(src.interval) && !isIntraday(dst.interval);

  // Keys of dst bars, the source key range [target, targetEnd), and the dst
  // times (`probe`, `probeEnd`) standing for them, used past the loaded bars.
  let key: (i: number) => number;
  let target: number;
  let targetEnd: number;
  let probe: number;
  let probeEnd: number;
  if (byDate) {
    const ctx = calendarContext(dstTimezone, time, n);
    const srcCtx = calendarContext(src.timezone, [src.time], 1);
    key = (i) => localDay(time[i]!, ctx);
    target = localDay(src.time, srcCtx);
    targetEnd = stepTime(target * DAY, 1, src.interval) / DAY;
    // dst bars of a date open at the same local time of day as the last one.
    const last = time[n - 1]!;
    const tod = last + ctx.offset(last) - localDay(last, ctx) * DAY;
    probe = ctx.localToUtc(target * DAY + tod);
    probeEnd = ctx.localToUtc(targetEnd * DAY + tod);
  } else {
    key = (i) => time[i]!;
    target = src.time;
    targetEnd = stepTime(src.time, 1, src.interval);
    probe = target;
    probeEnd = targetEnd;
  }

  if (dst.bricks) return Math.floor(timeToLogical(dst, { time: probe }) + EPS);

  /** Whole slot for an extrapolated (fractional) index, by rules 2 and 3. */
  const snap = (l: number): number => {
    if (!Number.isFinite(l)) return NaN;
    if (!coarser) {
      const k = Math.ceil(l - EPS);
      const t = logicalToTime(dst, k)?.time;
      if (t !== undefined && t < probeEnd) return k;
    }
    // Containing slot; a time in a non-trading gap (mapped to the next slot)
    // belongs to the slot before it.
    let k = Math.floor(l + EPS);
    const t = logicalToTime(dst, k)?.time;
    if (t !== undefined && t > probe && k > n - 1) k = Math.max(n - 1, k - 1);
    return k;
  };

  if (target < key(0)) return snap(timeToLogical(dst, { time: probe }));
  const i = countAtOrBefore(n, key, target) - 1;
  if (i === n - 1) {
    const l = timeToLogical(dst, { time: probe });
    // Past the newest bar's own span: extrapolate. Inside it: the newest bar.
    if (l > n - 1 + EPS) return snap(l);
  }
  if (coarser) return i;
  const j = firstAtOrAfter(n, key, target);
  return j < n && key(j) < targetEnd ? j : i;
}
