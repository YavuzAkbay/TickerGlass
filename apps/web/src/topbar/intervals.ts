import {
  formatInterval,
  intervalSeconds,
  intervalsEqual,
  parseInterval,
  type Interval,
  type IntervalUnit,
} from '@investopen/engine';

export interface IntervalGroup {
  unit: IntervalUnit;
  title: string;
  intervals: string[];
}

/** Built-in intervals offered in the interval menu, grouped by unit. */
export const INTERVAL_GROUPS: IntervalGroup[] = [
  { unit: 'minute', title: 'Minutes', intervals: ['1m', '3m', '5m', '15m', '30m', '45m'] },
  { unit: 'hour', title: 'Hours', intervals: ['1h', '2h', '3h', '4h'] },
  { unit: 'day', title: 'Days', intervals: ['1D'] },
  { unit: 'week', title: 'Weeks', intervals: ['1W'] },
  { unit: 'month', title: 'Months', intervals: ['1M', '3M', '6M', '12M'] },
];

export const UNIT_NAMES: Record<IntervalUnit, [singular: string, plural: string]> = {
  minute: ['minute', 'minutes'],
  hour: ['hour', 'hours'],
  day: ['day', 'days'],
  week: ['week', 'weeks'],
  month: ['month', 'months'],
};

/** Parse without throwing. */
export function tryParseInterval(s: string): Interval | null {
  try {
    return parseInterval(s);
  } catch {
    return null;
  }
}

/** Canonical string ("60m" -> "1h"), or null if invalid. */
export function canonicalInterval(s: string): string | null {
  const i = tryParseInterval(s);
  return i ? formatInterval(i) : null;
}

/** "5 minutes", "1 hour", "1 day". Falls back to the raw string. */
export function intervalLabel(s: string): string {
  const i = tryParseInterval(s);
  if (!i) return s;
  const n = parseInterval(formatInterval(i));
  const [one, many] = UNIT_NAMES[n.unit];
  return `${n.count} ${n.count === 1 ? one : many}`;
}

export function sameInterval(a: string, b: string): boolean {
  const ia = tryParseInterval(a);
  const ib = tryParseInterval(b);
  return !!ia && !!ib && intervalsEqual(ia, ib);
}

export function unitOf(s: string): IntervalUnit | null {
  const i = tryParseInterval(s);
  return i ? parseInterval(formatInterval(i)).unit : null;
}

export function sortIntervals(list: string[]): string[] {
  const secs = (s: string) => {
    const i = tryParseInterval(s);
    return i ? intervalSeconds(i) : Number.MAX_SAFE_INTEGER;
  };
  return [...list].sort((a, b) => secs(a) - secs(b));
}

export function isBuiltinInterval(s: string): boolean {
  return INTERVAL_GROUPS.some((g) => g.intervals.some((x) => sameInterval(x, s)));
}

/**
 * Parse what the user typed in the interval box: bare numbers are minutes,
 * a lone unit letter means 1 of that unit, `h`/`D`/`W`/`M` suffixes accepted.
 */
export function parseTypedInterval(text: string): string | null {
  const t = text.trim().replace(/\s+/g, '');
  const m = /^(\d*)([mhHdDwWM]?)$/.exec(t);
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const count = m[1] === '' ? '1' : m[1];
  const unit = m[2] === '' ? 'm' : m[2];
  return canonicalInterval(`${count}${unit}`);
}
