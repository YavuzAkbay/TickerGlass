import { intervalSeconds, isIntraday, type Interval } from '@investopen/engine';

const DAY = 86_400;

/**
 * How far back the API serves each native intraday interval, in days. Mirrors
 * api/src/investopen_api/intervals.py (lookback_days - 1: a day of margin).
 * Keep in sync by hand.
 */
const LOOKBACK_DAYS: Record<number, number> = {
  1: 29,
  2: 59,
  5: 59,
  15: 59,
  30: 59,
  60: 729,
  90: 59,
};

/** Lookback in seconds for `interval`, or null when history is unlimited (daily and up). */
export function apiLookbackSeconds(interval: Interval): number | null {
  if (!isIntraday(interval)) return null;
  const days = LOOKBACK_DAYS[intervalSeconds(interval) / 60];
  // Non-native intraday intervals are resampled from a native one; treat as unlimited here.
  return days === undefined ? null : days * DAY;
}
