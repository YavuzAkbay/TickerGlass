import type { UTCTimestamp } from '../types';

/** IANA zone name, `'UTC'`, or `'local'` (the browser zone). */
export type TimeZoneSpec = string;

export interface TzConverter {
  readonly tz: string;
  /** Offset from UTC in seconds at the given instant (local = utc + offset). */
  offsetSeconds(t: UTCTimestamp): number;
  /** `t + offset`: shift so that getUTC* methods yield local wall-clock parts. */
  toLocal(t: UTCTimestamp): number;
}

const DAY = 86_400;
/**
 * Offset sampling step. Two transitions within one step would be missed; no
 * zone has had that in the date ranges a chart shows.
 */
const STEP = DAY;
/** A miss this close to a cached interval extends it instead of starting a new one. */
const MAX_FILL = 8 * STEP;

const converters = new Map<string, TzConverter>();
const offsetCaches = new Map<string, ZoneOffsets>();

function resolveZone(tz: TimeZoneSpec): string {
  if (tz === 'local') {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  return tz;
}

function isUtc(zone: string): boolean {
  return zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT';
}

/** Exact offset (seconds) at whole second `t` from Intl. Throws RangeError for unknown zones. */
function createFormatterOffset(zone: string): (t: number) => number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  return (t: number): number => {
    let y = 0;
    let mo = 1;
    let d = 1;
    let h = 0;
    let mi = 0;
    let s = 0;
    for (const p of dtf.formatToParts(new Date(t * 1000))) {
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
    return Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - t;
  };
}

/**
 * UTC offsets of one IANA zone as cached `[start, end) -> offset` intervals.
 * A miss samples the offset once per day around the queried time; where two
 * samples differ, the transition is located by bisection to the second, so
 * half-hour DST shifts (Australia/Lord_Howe) and odd offsets (Asia/Kathmandu)
 * are exact. Misses near a cached interval extend it, so a zone settles into
 * one interval per offset period. Lookups are a binary search, O(1) amortized
 * for monotonic access (the last hit and its successor are tried first).
 */
export class ZoneOffsets {
  private readonly compute: (t: number) => number;
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private readonly offs: number[] = [];
  private last = 0;

  /** Throws RangeError for zones Intl does not know. */
  constructor(timeZone: string) {
    this.compute = createFormatterOffset(timeZone);
  }

  /** Offset (seconds, local - UTC) at UTC time `t`. */
  offset(t: number): number {
    let i = this.find(t);
    if (i < 0) {
      this.cover(t);
      i = this.find(t);
    }
    return this.offs[i]!;
  }

  /** Number of cached intervals (tests). @internal */
  get intervalCount(): number {
    return this.starts.length;
  }

  /** Index of the cached interval containing `t`, or -1. */
  private find(t: number): number {
    const { starts, ends } = this;
    const n = starts.length;
    let i = this.last;
    if (i < n && t >= starts[i]! && t < ends[i]!) return i;
    i++;
    if (i < n && t >= starts[i]! && t < ends[i]!) return (this.last = i);
    i = this.before(t);
    if (i >= 0 && t < ends[i]!) return (this.last = i);
    return -1;
  }

  /** Last interval with start <= t, or -1. */
  private before(t: number): number {
    const starts = this.starts;
    let lo = 0;
    let hi = starts.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Cache the offsets of a span around uncached `t`, bridging to close neighbors. */
  private cover(t: number): void {
    const i = this.before(t);
    let a = Math.floor(t / STEP) * STEP;
    let b = a + STEP;
    if (i >= 0) {
      const prevEnd = this.ends[i]!;
      if (t - prevEnd < MAX_FILL || a < prevEnd) a = prevEnd;
    }
    if (i + 1 < this.starts.length) {
      const nextStart = this.starts[i + 1]!;
      if (nextStart - t < MAX_FILL || b > nextStart) b = nextStart;
    }
    this.scan(a, b);
  }

  /** Sample [a, b) every STEP; bisect each change down to the second. */
  private scan(a: number, b: number): void {
    let start = a;
    let off = this.compute(a);
    for (let t0 = a; t0 < b;) {
      const t1 = Math.min(t0 + STEP, b);
      if (this.compute(t1) !== off) {
        let lo = t0;
        let hi = t1;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (this.compute(mid) === off) lo = mid;
          else hi = mid;
        }
        this.add(start, hi, off);
        start = hi;
        off = this.compute(hi);
      }
      t0 = t1;
    }
    this.add(start, b, off);
  }

  /** Insert [a, b) (disjoint from the cache), merging equal-offset neighbors. */
  private add(a: number, b: number, off: number): void {
    if (b <= a) return;
    const { starts, ends, offs } = this;
    const i = this.before(a);
    const joinPrev = i >= 0 && ends[i] === a && offs[i] === off;
    const joinNext = i + 1 < starts.length && starts[i + 1] === b && offs[i + 1] === off;
    if (joinPrev && joinNext) {
      ends[i] = ends[i + 1]!;
      starts.splice(i + 1, 1);
      ends.splice(i + 1, 1);
      offs.splice(i + 1, 1);
    } else if (joinPrev) ends[i] = b;
    else if (joinNext) starts[i + 1] = a;
    else {
      starts.splice(i + 1, 0, a);
      ends.splice(i + 1, 0, b);
      offs.splice(i + 1, 0, off);
    }
    this.last = 0;
  }
}

/** Shared offset cache of an IANA zone. Throws RangeError for unknown zones. */
export function zoneOffsets(zone: string): ZoneOffsets {
  let z = offsetCaches.get(zone);
  if (!z) {
    z = new ZoneOffsets(zone);
    offsetCaches.set(zone, z);
  }
  return z;
}

export function createTzConverter(tz: TimeZoneSpec): TzConverter {
  const cached = converters.get(tz);
  if (cached) return cached;

  const zone = resolveZone(tz);
  let conv: TzConverter;
  if (isUtc(zone)) {
    conv = {
      tz,
      offsetSeconds: () => 0,
      toLocal: (t) => t,
    };
  } else {
    const z = zoneOffsets(zone);
    conv = {
      tz,
      offsetSeconds: (t) => z.offset(t),
      toLocal: (t) => t + z.offset(t),
    };
  }
  converters.set(tz, conv);
  return conv;
}
