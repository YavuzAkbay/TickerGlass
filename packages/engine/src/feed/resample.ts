import type { BarColumns, Interval, UTCTimestamp } from '../types';
import { intervalSeconds } from './intervals';

const DAY = 86_400;
const HOUR = 3600;

export interface BucketOptions {
  /** IANA exchange timezone; null means UTC. */
  timezone: string | null;
  /** Regular session "HHMM-HHMM" in exchange time; null if unknown. */
  session: string | null;
}

// ---------------------------------------------------------------------------
// Timezone offsets
// ---------------------------------------------------------------------------

/**
 * UTC offsets of one IANA zone, memoized per UTC hour. DST transitions happen on
 * (UTC) hour boundaries for practically every zone, so one Intl call per hour of
 * data is enough; 100k 1m bars need ~1.7k Intl calls instead of 100k.
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

  /** Offset (seconds, local - UTC) in effect during the UTC hour `key`. */
  offsetForHour(key: number): number {
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const t = key * HOUR;
    let y = 1970;
    let mo = 1;
    let d = 1;
    let h = 0;
    let mi = 0;
    let s = 0;
    for (const p of this.fmt.formatToParts(new Date(t * 1000))) {
      switch (p.type) {
        case 'year':
          y = Number(p.value);
          break;
        case 'month':
          mo = Number(p.value);
          break;
        case 'day':
          d = Number(p.value);
          break;
        case 'hour':
          h = Number(p.value) % 24;
          break;
        case 'minute':
          mi = Number(p.value);
          break;
        case 'second':
          s = Number(p.value);
          break;
        default:
          break;
      }
    }
    const off = Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - t;
    this.cache.set(key, off);
    return off;
  }
}

const zones = new Map<string, ZoneOffsets | null>();

/** Shared per-zone cache. Unknown zones resolve to null, i.e. UTC. */
function zoneOffsets(timeZone: string | null): ZoneOffsets | null {
  if (timeZone === null || timeZone === 'UTC' || timeZone === 'Etc/UTC') return null;
  let z = zones.get(timeZone);
  if (z === undefined) {
    try {
      z = new ZoneOffsets(timeZone);
    } catch (err) {
      // Intl throws RangeError for zones it does not know. Bucketing in UTC is a
      // usable degradation for charting; anything else is a real bug.
      if (!(err instanceof RangeError)) throw err;
      z = null;
    }
    zones.set(timeZone, z);
  }
  return z;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface Session {
  /** Local seconds of day. */
  start: number;
  /** Local seconds of day, exclusive. May be < start for overnight sessions. */
  end: number;
  /** Round-the-clock market: anchor at local midnight. */
  allDay: boolean;
}

const SESSION_RE = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/;

function parseSession(s: string | null): Session | null {
  if (s === null) return null;
  const m = SESSION_RE.exec(s.trim());
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if (sh > 23 || eh > 24 || sm > 59 || em > 59) return null;
  const start = sh * HOUR + sm * 60;
  // "2359" (and "2400") mean "until midnight".
  const end = (eh === 23 && em === 59) || eh === 24 ? DAY : eh * HOUR + em * 60;
  const allDay = start === end % DAY || (start === 0 && end === DAY);
  return { start, end, allDay };
}

function inSession(sess: Session, tod: number): boolean {
  if (sess.allDay) return true;
  return sess.start < sess.end
    ? tod >= sess.start && tod < sess.end
    : tod >= sess.start || tod < sess.end;
}

// ---------------------------------------------------------------------------
// Bucket context
// ---------------------------------------------------------------------------

/**
 * Timezone/session plus caches for `bucketStart`. Create one per series (it
 * remembers per-day anchors for out-of-session bars, so feed bars in time order).
 */
export class BucketContext {
  readonly timezone: string | null;
  readonly session: string | null;
  /** @internal */
  readonly sess: Session | null;
  /**
   * Local-day number -> local time (seconds) the out-of-session intraday grid of
   * that day is anchored to: the first such bar seen on that day.
   * @internal
   */
  readonly dayAnchors = new Map<number, number>();
  private readonly zone: ZoneOffsets | null;
  private lastKey = NaN;
  private lastOff = 0;

  constructor(opts: BucketOptions) {
    this.timezone = opts.timezone;
    this.session = opts.session;
    this.sess = parseSession(opts.session);
    this.zone = zoneOffsets(opts.timezone);
  }

  /** UTC offset (seconds, local - UTC) at UTC time `t`. */
  offset(t: number): number {
    if (this.zone === null) return 0;
    const key = Math.floor(t / HOUR);
    if (key === this.lastKey) return this.lastOff;
    const off = this.zone.offsetForHour(key);
    this.lastKey = key;
    this.lastOff = off;
    return off;
  }

  /** UTC time of a local wall-clock time (seconds). Gaps resolve forward. */
  localToUtc(local: number): number {
    if (this.zone === null) return local;
    const off1 = this.offset(local - this.offset(local));
    const u = local - off1;
    const off2 = this.offset(u);
    return off2 === off1 ? u : local - off2;
  }
}

export function createBucketContext(opts: BucketOptions): BucketContext {
  return new BucketContext(opts);
}

// ---------------------------------------------------------------------------
// Calendar helpers (proleptic Gregorian, days since 1970-01-01)
// ---------------------------------------------------------------------------

/** Month index (year * 12 + month0) of a day number. */
function monthIndexOfDay(z0: number): number {
  const z = z0 + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const m = mp < 10 ? mp + 3 : mp - 9; // 1..12
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return y * 12 + (m - 1);
}

/** Day number of the first day of a month index. */
function dayOfMonthIndex(mi: number): number {
  const m = (((mi % 12) + 12) % 12) + 1;
  let y = Math.floor(mi / 12);
  if (m <= 2) y -= 1;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5);
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/** Month index of UTC time `t` in the context's timezone. */
export function localMonthIndex(t: UTCTimestamp, ctx: BucketContext): number {
  return monthIndexOfDay(Math.floor((t + ctx.offset(t)) / DAY));
}

/** UTC time of local midnight on the first day of month index `mi`. */
export function monthIndexStart(mi: number, ctx: BucketContext): UTCTimestamp {
  return ctx.localToUtc(dayOfMonthIndex(mi) * DAY);
}

/**
 * Start (UTC seconds) of the `target` bucket containing UTC time `t`.
 *
 * - Intraday: anchored per trading day. In-session bars use the session start;
 *   other bars (no session, pre/post market) use the first such bar seen that
 *   local day (recorded in `ctx`), and post-market buckets never start before the
 *   session end. Round-the-clock sessions anchor at local midnight.
 * - Days: floor(localDay / N). Weeks: ISO (Monday) weeks, N-week groups counted
 *   from the epoch. Months: calendar months, N-month groups from January.
 */
export function bucketStart(t: UTCTimestamp, target: Interval, ctx: BucketContext): UTCTimestamp {
  const local = t + ctx.offset(t);
  const day = Math.floor(local / DAY);
  const n = target.count;
  switch (target.unit) {
    case 'minute':
    case 'hour':
      return ctx.localToUtc(intradayBucketLocal(local, day, intervalSeconds(target), ctx));
    case 'day':
      return ctx.localToUtc(Math.floor(day / n) * n * DAY);
    case 'week': {
      // Day 0 (1970-01-01) is a Thursday; Monday-based week index.
      const w = Math.floor((day + 3) / 7);
      return ctx.localToUtc((Math.floor(w / n) * n * 7 - 3) * DAY);
    }
    case 'month': {
      const mi = monthIndexOfDay(day);
      return ctx.localToUtc(dayOfMonthIndex(Math.floor(mi / n) * n) * DAY);
    }
  }
}

function intradayBucketLocal(local: number, day: number, sec: number, ctx: BucketContext): number {
  const dayStart = day * DAY;
  const tod = local - dayStart;
  const sess = ctx.sess;
  if (sess !== null && inSession(sess, tod)) {
    let anchor: number;
    if (sess.allDay) anchor = dayStart;
    else if (sess.start < sess.end || tod >= sess.start) anchor = dayStart + sess.start;
    else anchor = dayStart - DAY + sess.start; // overnight session, after midnight
    return anchor + Math.floor((local - anchor) / sec) * sec;
  }
  let anchor = ctx.dayAnchors.get(day);
  if (anchor === undefined) {
    anchor = local;
    ctx.dayAnchors.set(day, anchor);
  }
  let b = anchor + Math.floor((local - anchor) / sec) * sec;
  if (b < dayStart) b = dayStart;
  if (sess !== null && tod >= sess.end % DAY && sess.end % DAY !== 0) {
    // Post-market: do not let the bucket reach back into the regular session.
    const sessEnd = dayStart + (sess.end % DAY);
    if (b < sessEnd) b = sessEnd;
  }
  return b;
}

/**
 * Tell `ctx` that `t` is a known bucket start (e.g. the chart's last bar) so that
 * later out-of-session intraday bars on the same local day continue its grid.
 * No-op for in-session times or days that already have an anchor.
 */
export function seedBucketAnchor(t: UTCTimestamp, ctx: BucketContext): void {
  const local = t + ctx.offset(t);
  const day = Math.floor(local / DAY);
  if (ctx.sess !== null && inSession(ctx.sess, local - day * DAY)) return;
  if (!ctx.dayAnchors.has(day)) ctx.dayAnchors.set(day, local);
}

/**
 * Whether `t` falls in the regular session: 'in', 'out', or 'unknown' when the
 * context has no session. Round-the-clock sessions are always 'in'.
 */
export function sessionState(t: UTCTimestamp, ctx: BucketContext): 'in' | 'out' | 'unknown' {
  if (ctx.sess === null) return 'unknown';
  const local = t + ctx.offset(t);
  return inSession(ctx.sess, local - Math.floor(local / DAY) * DAY) ? 'in' : 'out';
}

/** True if `t` is an intraday time whose bucket depends on data-derived anchors. */
export function usesDataAnchor(t: UTCTimestamp, ctx: BucketContext): boolean {
  return sessionState(t, ctx) !== 'in';
}

/** Local calendar day number of `t`. */
export function localDay(t: UTCTimestamp, ctx: BucketContext): number {
  return Math.floor((t + ctx.offset(t)) / DAY);
}

// ---------------------------------------------------------------------------
// Resample
// ---------------------------------------------------------------------------

export function emptyColumns(n = 0): BarColumns {
  return {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
}

/**
 * Aggregate ascending `base` bars into `target` buckets: first open, max high,
 * min low, last close, summed volume; bucket time is the bucket start. A bucket
 * that would start before the previous one (only possible with odd data) is
 * folded into the previous bucket so the output stays ascending.
 */
export function resample(base: BarColumns, target: Interval, opts: BucketOptions): BarColumns {
  const ctx = createBucketContext(opts);
  const n = base.time.length;
  const out = emptyColumns(n);
  const { time: bt, open: bo, high: bh, low: bl, close: bc, volume: bv } = base;
  const { time: ot, open: oo, high: oh, low: ol, close: oc, volume: ov } = out;
  let k = -1;
  let cur = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = bt[i] as number;
    const b = bucketStart(t, target, ctx);
    const h = bh[i] as number;
    const l = bl[i] as number;
    if (b > cur) {
      k++;
      cur = b;
      ot[k] = b;
      oo[k] = bo[i] as number;
      oh[k] = h;
      ol[k] = l;
      oc[k] = bc[i] as number;
      ov[k] = bv[i] as number;
    } else {
      if (h > (oh[k] as number)) oh[k] = h;
      if (l < (ol[k] as number)) ol[k] = l;
      oc[k] = bc[i] as number;
      ov[k] = (ov[k] as number) + (bv[i] as number);
    }
  }
  const len = k + 1;
  return {
    time: ot.slice(0, len),
    open: oo.slice(0, len),
    high: oh.slice(0, len),
    low: ol.slice(0, len),
    close: oc.slice(0, len),
    volume: ov.slice(0, len),
  };
}
