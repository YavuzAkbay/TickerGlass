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

const HOUR = 3600;
const converters = new Map<string, TzConverter>();

function resolveZone(tz: TimeZoneSpec): string {
  if (tz === 'local') {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  return tz;
}

function isUtc(zone: string): boolean {
  return zone === 'UTC' || zone === 'Etc/UTC' || zone === 'GMT';
}

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
    const compute = createFormatterOffset(zone);
    const memo = new Map<number, number>();
    let lastBucket = Number.NaN;
    let lastOffset = 0;
    const offsetSeconds = (t: UTCTimestamp): number => {
      const bucket = Math.floor(t / HOUR);
      if (bucket === lastBucket) return lastOffset;
      let off = memo.get(bucket);
      if (off === undefined) {
        off = compute(bucket * HOUR);
        memo.set(bucket, off);
      }
      lastBucket = bucket;
      lastOffset = off;
      return off;
    };
    conv = {
      tz,
      offsetSeconds,
      toLocal: (t) => t + offsetSeconds(t),
    };
  }
  converters.set(tz, conv);
  return conv;
}
