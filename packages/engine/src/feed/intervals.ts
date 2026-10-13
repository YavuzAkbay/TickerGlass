import type { Interval, IntervalUnit } from '../types';

const UNIT_SECONDS: Record<IntervalUnit, number> = {
  minute: 60,
  hour: 3600,
  day: 86_400,
  week: 7 * 86_400,
  /** Nominal month length. Real month buckets are calendar-based (see resample.ts). */
  month: 30 * 86_400,
};

const UNIT_SUFFIX: Record<IntervalUnit, string> = {
  minute: 'm',
  hour: 'h',
  day: 'D',
  week: 'W',
  month: 'M',
};

/** Upper bound on `count`; guards against absurd strings like "99999999m". */
const MAX_COUNT = 100_000;

const INTERVAL_RE = /^(\d+)([mhHdDwWM])$/;

/**
 * Parse an interval string: `<n><unit>` where unit is `m` (minute, lowercase only),
 * `h`/`H` (hour), `D` (day), `W` (week) or `M` (month, uppercase only). `d`/`w` are
 * accepted as aliases since they are unambiguous. Throws on anything else.
 */
export function parseInterval(s: string): Interval {
  const m = INTERVAL_RE.exec(s.trim());
  if (!m) throw new Error(`invalid interval: ${JSON.stringify(s)}`);
  const count = Number(m[1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new Error(`invalid interval count: ${JSON.stringify(s)}`);
  }
  const unit = suffixToUnit(m[2] ?? '');
  return { unit, count };
}

function suffixToUnit(suffix: string): IntervalUnit {
  switch (suffix) {
    case 'm':
      return 'minute';
    case 'h':
    case 'H':
      return 'hour';
    case 'd':
    case 'D':
      return 'day';
    case 'w':
    case 'W':
      return 'week';
    case 'M':
      return 'month';
    default:
      throw new Error(`invalid interval unit: ${JSON.stringify(suffix)}`);
  }
}

/**
 * Canonical form: whole-hour minute counts are written in hours ("60m" -> "1h"),
 * everything else as `<count><suffix>`.
 */
export function formatInterval(i: Interval): string {
  const n = normalizeInterval(i);
  return `${n.count}${UNIT_SUFFIX[n.unit]}`;
}

/** Minute counts that are whole hours become hours; other units unchanged. */
export function normalizeInterval(i: Interval): Interval {
  if (i.unit === 'minute' && i.count % 60 === 0) return { unit: 'hour', count: i.count / 60 };
  return { unit: i.unit, count: i.count };
}

/** Nominal length in seconds (month = 30 days). */
export function intervalSeconds(i: Interval): number {
  return UNIT_SECONDS[i.unit] * i.count;
}

export function isIntraday(i: Interval): boolean {
  return i.unit === 'minute' || i.unit === 'hour';
}

/** Equal after normalization, so 60m equals 1h. 7D and 1W are different (bucketing differs). */
export function intervalsEqual(a: Interval, b: Interval): boolean {
  const na = normalizeInterval(a);
  const nb = normalizeInterval(b);
  return na.unit === nb.unit && na.count === nb.count;
}

/** Native API intraday intervals, in minutes. */
const NATIVE_MINUTES: ReadonlySet<number> = new Set([1, 2, 5, 15, 30, 60, 90]);

/** API interval string if the backend serves `i` directly, else null. Never returns "5d". */
export function toApiInterval(i: Interval): string | null {
  if (isIntraday(i)) {
    const minutes = i.unit === 'hour' ? i.count * 60 : i.count;
    return NATIVE_MINUTES.has(minutes) ? `${minutes}m` : null;
  }
  switch (i.unit) {
    case 'day':
      return i.count === 1 ? '1d' : null;
    case 'week':
      return i.count === 1 ? '1wk' : null;
    case 'month':
      return i.count === 1 ? '1mo' : i.count === 3 ? '3mo' : null;
    default:
      return null;
  }
}

export function isNativeInterval(i: Interval): boolean {
  return toApiInterval(i) !== null;
}

/**
 * Intraday bases tried in order (largest first). 90m is deliberately excluded: it
 * has a much shorter history than 60m and only divides a few targets.
 */
const BASE_MINUTES = [60, 30, 15, 5, 2, 1] as const;

/**
 * Best native interval to build `i` from, and how many base bars make one target
 * bar (nominally). Native intervals return themselves with factor 1.
 */
export function resampleBase(i: Interval): { base: Interval; factor: number } {
  if (isNativeInterval(i)) return { base: { unit: i.unit, count: i.count }, factor: 1 };
  switch (i.unit) {
    case 'minute':
    case 'hour': {
      const minutes = i.unit === 'hour' ? i.count * 60 : i.count;
      for (const b of BASE_MINUTES) {
        if (minutes % b === 0) {
          const base: Interval =
            b === 60 ? { unit: 'hour', count: 1 } : { unit: 'minute', count: b };
          return { base, factor: minutes / b };
        }
      }
      // Unreachable: 1 divides everything.
      return { base: { unit: 'minute', count: 1 }, factor: minutes };
    }
    case 'day':
      return { base: { unit: 'day', count: 1 }, factor: i.count };
    case 'week':
      return { base: { unit: 'week', count: 1 }, factor: i.count };
    case 'month':
      // Always from 1M: Yahoo's 3mo bars aren't guaranteed calendar-quarter aligned.
      return { base: { unit: 'month', count: 1 }, factor: i.count };
  }
}
