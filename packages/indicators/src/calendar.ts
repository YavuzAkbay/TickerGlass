/**
 * Calendar periods of bar times in the exchange timezone (VWAP anchors and
 * any other period-anchored indicator). Pure, no DOM: uses Intl only.
 */

const DAY = 86_400;
const HOUR = 3600;
/** Offset cache granularity: every real DST transition falls on a 15-minute UTC boundary. */
const SLOT = 900;

/** Calendar unit of a period. 'session' = trading day (see `calendarPeriod`). */
export type CalendarUnit = 'session' | 'week' | 'month' | 'quarter' | 'year' | 'decade' | 'century';

/**
 * UTC offsets of one IANA zone, memoized per 15 UTC minutes. Hour slots are
 * not enough: half-hour zones such as Australia/Lord_Howe (+10:30 / +11, DST at
 * 02:00 local = 15:30 UTC) and India-style offsets change on half hours. 100k
 * one-minute bars cost ~6.7k Intl calls.
 */
class ZoneOffsets {
  private readonly fmt: Intl.DateTimeFormat;
  private readonly cache = new Map<number, number>();

  constructor(timeZone: string) {
    this.fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }

  /** Offset in seconds (local - UTC) at unix time `t`. */
  offset(t: number): number {
    const key = Math.floor(t / SLOT);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const at = key * SLOT;
    const parts: Record<string, number> = {};
    for (const p of this.fmt.formatToParts(new Date(at * 1000)))
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    const off =
      Date.UTC(
        parts.year ?? 1970,
        (parts.month ?? 1) - 1,
        parts.day ?? 1,
        (parts.hour ?? 0) % 24,
        parts.minute ?? 0,
        parts.second ?? 0,
      ) /
        1000 -
      at;
    this.cache.set(key, off);
    return off;
  }
}

const zones = new Map<string, ZoneOffsets | null>();

function isUtc(tz: string): boolean {
  return tz === '' || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT';
}

/** Offset of `tz` at `t` in seconds; unknown zones count as UTC. */
export function tzOffset(t: number, tz: string): number {
  if (isUtc(tz)) return 0;
  let z = zones.get(tz);
  if (z === undefined) {
    try {
      z = new ZoneOffsets(tz);
    } catch (err) {
      // Intl throws RangeError for unknown zones: UTC is a usable degradation.
      if (!(err instanceof RangeError)) throw err;
      z = null;
    }
    zones.set(tz, z);
  }
  return z ? z.offset(t) : 0;
}

/** Start of an overnight session ("1800-1700" -> 18:00) in seconds of day, else 0. */
function sessionShift(session: string | null): number {
  if (!session) return 0;
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(session.trim());
  if (!m) return 0;
  const start = Number(m[1]) * HOUR + Number(m[2]) * 60;
  const end = Number(m[3]) * HOUR + Number(m[4]) * 60;
  // Only sessions that wrap midnight start the trading day on the previous date.
  return start > end && end > 0 ? DAY - start : 0;
}

/**
 * Period number of bar time `time` (unix s) for `unit`, in timezone `tz`
 * (IANA; '' / 'UTC' / unknown = UTC). Consecutive bars with the same number
 * are in the same period. 'session' is the exchange calendar day; when
 * `session` ("HHMM-HHMM", exchange time) wraps midnight (futures, FX), the
 * trading day starts at the session open of the previous calendar day, and so
 * do weeks, months, quarters, ... (a Sunday 18:00 open is Monday's trading
 * day, so it starts the new week). Weeks start on Monday.
 */
export function calendarPeriod(
  time: number,
  unit: CalendarUnit,
  tz = 'UTC',
  session: string | null = null,
): number {
  const local = time + tzOffset(time, tz) + sessionShift(session);
  const day = Math.floor(local / DAY);
  if (unit === 'session') return day;
  // 1970-01-01 was a Thursday; +3 makes weeks start on Monday.
  if (unit === 'week') return Math.floor((day + 3) / 7);
  const d = new Date(local * 1000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  switch (unit) {
    case 'month':
      return y * 12 + mo;
    case 'quarter':
      return y * 4 + Math.floor(mo / 3);
    case 'year':
      return y;
    case 'decade':
      return Math.floor(y / 10);
    case 'century':
      return Math.floor(y / 100);
  }
}
