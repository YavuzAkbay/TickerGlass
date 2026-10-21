import { describe, expect, it } from 'vitest';
import type { BarColumns } from '../types';
import { parseInterval } from './intervals';
import { bucketStart, createBucketContext, resample } from './resample';

const NY = { timezone: 'America/New_York', session: '0930-1600' };
const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

const z = (iso: string): number => Date.parse(iso) / 1000;
const iso = (t: number): string => new Date(t * 1000).toISOString().replace('.000', '');

/** Bars at the given times; bar i has open=i, high=i+0.5, low=i-0.5, close=i+0.25, volume=1. */
function cols(times: number[]): BarColumns {
  const n = times.length;
  const c: BarColumns = {
    time: Float64Array.from(times),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    c.open[i] = i;
    c.high[i] = i + 0.5;
    c.low[i] = i - 0.5;
    c.close[i] = i + 0.25;
    c.volume[i] = 1;
  }
  return c;
}

/** Regular-session bars every `step` seconds from `openUtc` for `minutes` minutes. */
function sessionBars(openUtc: number, step: number, minutes = 390): number[] {
  const out: number[] = [];
  for (let t = openUtc; t < openUtc + minutes * MIN; t += step) out.push(t);
  return out;
}

describe('resample', () => {
  it('builds 3m from 1m with correct OHLCV', () => {
    const base = cols(sessionBars(z('2024-01-02T14:30:00Z'), MIN, 9));
    const r = resample(base, parseInterval('3m'), NY);
    expect([...r.time].map(iso)).toEqual([
      '2024-01-02T14:30:00Z',
      '2024-01-02T14:33:00Z',
      '2024-01-02T14:36:00Z',
    ]);
    expect([...r.open]).toEqual([0, 3, 6]);
    expect([...r.high]).toEqual([2.5, 5.5, 8.5]);
    expect([...r.low]).toEqual([-0.5, 2.5, 5.5]);
    expect([...r.close]).toEqual([2.25, 5.25, 8.25]);
    expect([...r.volume]).toEqual([3, 3, 3]);
  });

  it('anchors 4h at 09:30 NY across a DST change', () => {
    // DST started Sunday 2024-03-10: 09:30 is 14:30Z on Friday and 13:30Z on Monday.
    const times = [
      ...sessionBars(z('2024-03-08T14:30:00Z'), HOUR),
      ...sessionBars(z('2024-03-11T13:30:00Z'), HOUR),
    ];
    const r = resample(cols(times), parseInterval('4h'), NY);
    expect([...r.time].map(iso)).toEqual([
      '2024-03-08T14:30:00Z', // 09:30 EST
      '2024-03-08T18:30:00Z', // 13:30 EST
      '2024-03-11T13:30:00Z', // 09:30 EDT
      '2024-03-11T17:30:00Z', // 13:30 EDT
    ]);
    expect([...r.volume]).toEqual([4, 3, 4, 3]);
    expect([...r.open]).toEqual([0, 4, 7, 11]);
    expect([...r.close]).toEqual([3.25, 6.25, 10.25, 13.25]);
  });

  it('anchors 45m at 09:30 and steps by 45m', () => {
    const r = resample(
      cols(sessionBars(z('2024-01-02T14:30:00Z'), 15 * MIN)),
      parseInterval('45m'),
      NY,
    );
    expect(r.time.length).toBe(9);
    expect([...r.time.slice(0, 3)].map(iso)).toEqual([
      '2024-01-02T14:30:00Z', // 09:30
      '2024-01-02T15:15:00Z', // 10:15
      '2024-01-02T16:00:00Z', // 11:00
    ]);
    expect(iso(r.time[8] as number)).toBe('2024-01-02T20:30:00Z'); // 15:30, partial
    expect([...r.volume]).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 2]);
  });

  it('anchors crypto 4h at midnight', () => {
    const start = z('2024-01-01T00:00:00Z');
    const times = Array.from({ length: 48 }, (_, i) => start + i * HOUR);
    const r = resample(cols(times), parseInterval('4h'), { timezone: 'UTC', session: null });
    expect(r.time.length).toBe(12);
    expect([...r.time].every((t) => t % (4 * HOUR) === 0)).toBe(true);

    // A 24h session string anchors at midnight even when data starts mid-day.
    const late = times.slice(2);
    const r2 = resample(cols(late), parseInterval('4h'), { timezone: 'UTC', session: '0000-2359' });
    expect(iso(r2.time[0] as number)).toBe('2024-01-01T00:00:00Z');
    expect(r2.volume[0]).toBe(2);
  });

  it('groups 2D by floor(localDay / 2)', () => {
    // NY daily bars stamped at local midnight, Mon 2024-01-01 .. Fri 2024-01-05.
    const times = [1, 2, 3, 4, 5].map((d) => z(`2024-01-0${d}T05:00:00Z`));
    const r = resample(cols(times), parseInterval('2D'), NY);
    // Day 19723 (Jan 1) is odd, so its group starts on Dec 31.
    expect([...r.time].map(iso)).toEqual([
      '2023-12-31T05:00:00Z',
      '2024-01-02T05:00:00Z',
      '2024-01-04T05:00:00Z',
    ]);
    expect([...r.volume]).toEqual([1, 2, 2]);
  });

  it('builds 2W from 1W on ISO weeks', () => {
    const times = [1, 8, 15, 22].map((d) => z(`2024-01-${String(d).padStart(2, '0')}T05:00:00Z`));
    const r = resample(cols(times), parseInterval('2W'), NY);
    expect([...r.time].map(iso)).toEqual(['2024-01-01T05:00:00Z', '2024-01-15T05:00:00Z']);
    expect([...r.volume]).toEqual([2, 2]);
  });

  it('builds 6M from 1M in the exchange timezone (Jan/Jul buckets)', () => {
    const times: number[] = [];
    for (let m = 0; m < 12; m++) {
      // Local midnight of the 1st in New York.
      const ctx = createBucketContext(NY);
      times.push(ctx.localToUtc(Date.UTC(2023, m, 1) / 1000));
    }
    expect(iso(times[6] as number)).toBe('2023-07-01T04:00:00Z');
    const r = resample(cols(times), parseInterval('6M'), NY);
    expect([...r.time].map(iso)).toEqual(['2023-01-01T05:00:00Z', '2023-07-01T04:00:00Z']);
    expect([...r.volume]).toEqual([6, 6]);
    expect([...r.open]).toEqual([0, 6]);
    expect([...r.close]).toEqual([5.25, 11.25]);
  });

  it('cuts NY days at local midnight on both 2024 DST edges (23h and 25h days)', () => {
    const hourly = (from: string, to: string): number[] => {
      const out: number[] = [];
      for (let t = z(from); t < z(to); t += HOUR) out.push(t);
      return out;
    };
    const spring = resample(
      cols(hourly('2024-03-09T05:00:00Z', '2024-03-11T04:00:00Z')),
      parseInterval('1D'),
      NY,
    );
    expect([...spring.time].map(iso)).toEqual(['2024-03-09T05:00:00Z', '2024-03-10T05:00:00Z']);
    expect([...spring.volume]).toEqual([24, 23]);
    const fall = resample(
      cols(hourly('2024-11-02T04:00:00Z', '2024-11-04T05:00:00Z')),
      parseInterval('1D'),
      NY,
    );
    expect([...fall.time].map(iso)).toEqual(['2024-11-02T04:00:00Z', '2024-11-03T04:00:00Z']);
    expect([...fall.volume]).toEqual([24, 25]);
  });

  it('keeps the half-hour grid across the Lord Howe DST start (+10:30 -> +11:00 at 15:30Z)', () => {
    // 15m bars 00:30..03:15 local on 2024-10-06; local 02:00-02:29 does not exist.
    const start = z('2024-10-05T14:00:00Z');
    const times = Array.from({ length: 10 }, (_, i) => start + i * 15 * MIN);
    const r = resample(cols(times), parseInterval('30m'), {
      timezone: 'Australia/Lord_Howe',
      session: '0000-2359',
    });
    expect([...r.time].map(iso)).toEqual([
      '2024-10-05T14:00:00Z', // 00:30 +10:30
      '2024-10-05T14:30:00Z', // 01:00
      '2024-10-05T15:00:00Z', // 01:30
      '2024-10-05T15:30:00Z', // 02:30 +11:00
      '2024-10-05T16:00:00Z', // 03:00
    ]);
    expect([...r.volume]).toEqual([2, 2, 2, 2, 2]);
  });

  it('buckets days and hours in Asia/Kathmandu (+5:45)', () => {
    const ctx = createBucketContext({ timezone: 'Asia/Kathmandu', session: '0000-2359' });
    const t = z('2024-01-01T18:20:00Z'); // 00:05 local on Jan 2
    expect(iso(bucketStart(t, parseInterval('1D'), ctx))).toBe('2024-01-01T18:15:00Z');
    expect(iso(bucketStart(t, parseInterval('1h'), ctx))).toBe('2024-01-01T18:15:00Z');
    expect(iso(bucketStart(t - 10 * MIN, parseInterval('1h'), ctx))).toBe('2024-01-01T17:15:00Z');
  });

  it('keeps post-market buckets after the session close', () => {
    // Premarket from 04:00 (09:00Z), regular session, post-market to 20:00 (01:00Z).
    const start = z('2024-01-02T09:00:00Z');
    const times = Array.from({ length: 16 }, (_, i) => start + i * HOUR);
    const r = resample(cols(times), parseInterval('5h'), NY);
    const t = [...r.time];
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1] as number);
    // 16:00 local post-market bucket starts at the session end, not inside the session.
    expect(t.map(iso)).toContain('2024-01-02T21:00:00Z');
  });

  it('returns empty columns for empty input', () => {
    const r = resample(cols([]), parseInterval('3m'), NY);
    expect(r.time.length).toBe(0);
  });
});

describe('bucketStart', () => {
  it('matches resample for live use', () => {
    const ctx = createBucketContext(NY);
    const t = z('2024-03-11T19:47:12Z'); // 15:47 EDT
    expect(iso(bucketStart(t, parseInterval('4h'), ctx))).toBe('2024-03-11T17:30:00Z');
    expect(iso(bucketStart(t, parseInterval('1D'), ctx))).toBe('2024-03-11T04:00:00Z');
    expect(iso(bucketStart(t, parseInterval('1W'), ctx))).toBe('2024-03-11T04:00:00Z');
    expect(iso(bucketStart(t, parseInterval('1M'), ctx))).toBe('2024-03-01T05:00:00Z');
    expect(iso(bucketStart(t, parseInterval('12M'), ctx))).toBe('2024-01-01T05:00:00Z');
  });

  it('falls back to UTC for unknown timezones', () => {
    const ctx = createBucketContext({ timezone: 'Not/AZone', session: null });
    expect(bucketStart(z('2024-01-02T13:00:00Z'), parseInterval('1D'), ctx)).toBe(
      z('2024-01-02T00:00:00Z'),
    );
  });
});

describe('resample performance', () => {
  it('resamples 100k 1m bars to 5m in under 200ms', () => {
    const times: number[] = [];
    let day = z('2023-01-03T14:30:00Z');
    while (times.length < 100_000) {
      const dow = new Date(day * 1000).getUTCDay();
      if (dow !== 0 && dow !== 6) {
        for (let i = 0; i < 390 && times.length < 100_000; i++) times.push(day + i * MIN);
      }
      day += DAY;
    }
    const base = cols(times);
    const target = parseInterval('5m');
    resample(base, target, NY); // warm up JIT and tz cache
    const t0 = performance.now();
    const r = resample(base, target, NY);
    const ms = performance.now() - t0;
    expect(r.time.length).toBeGreaterThan(19_000);
    expect(ms).toBeLessThan(200);
  });
});
