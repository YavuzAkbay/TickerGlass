import { describe, expect, it } from 'vitest';
import { createTzConverter, ZoneOffsets } from './timezone';

const ts = (s: string): number => Date.parse(s) / 1000;

describe('createTzConverter', () => {
  it('UTC is offset 0 and cached', () => {
    const c = createTzConverter('UTC');
    expect(c.offsetSeconds(ts('2024-06-01T00:00:00Z'))).toBe(0);
    expect(c.toLocal(1000)).toBe(1000);
    expect(createTzConverter('UTC')).toBe(c);
  });

  it('America/New_York across both 2024 DST transitions', () => {
    const c = createTzConverter('America/New_York');
    const h = 3600;
    expect(c.offsetSeconds(ts('2024-01-15T12:00:00Z'))).toBe(-5 * h);
    // Spring forward: 2024-03-10 07:00Z
    expect(c.offsetSeconds(ts('2024-03-10T06:59:59Z'))).toBe(-5 * h);
    expect(c.offsetSeconds(ts('2024-03-10T07:00:00Z'))).toBe(-4 * h);
    expect(c.offsetSeconds(ts('2024-07-01T12:00:00Z'))).toBe(-4 * h);
    // Fall back: 2024-11-03 06:00Z
    expect(c.offsetSeconds(ts('2024-11-03T05:59:59Z'))).toBe(-4 * h);
    expect(c.offsetSeconds(ts('2024-11-03T06:00:00Z'))).toBe(-5 * h);
    expect(c.toLocal(ts('2024-07-01T12:00:00Z'))).toBe(ts('2024-07-01T08:00:00Z'));
  });

  it('Asia/Kolkata is +5:30', () => {
    const c = createTzConverter('Asia/Kolkata');
    expect(c.offsetSeconds(ts('2024-06-01T00:00:00Z'))).toBe(19800);
    expect(c.offsetSeconds(ts('2024-12-01T00:00:00Z'))).toBe(19800);
  });

  it('Australia/Lord_Howe half-hour DST shifts are exact to the second', () => {
    const c = createTzConverter('Australia/Lord_Howe');
    const h = 3600;
    // DST ends 2024-04-07 02:00 local (+11:00 -> +10:30) = 2024-04-06 15:00Z.
    expect(c.offsetSeconds(ts('2024-04-06T14:59:59Z'))).toBe(11 * h);
    expect(c.offsetSeconds(ts('2024-04-06T15:00:00Z'))).toBe(10.5 * h);
    // DST starts 2024-10-06 02:00 local (+10:30 -> +11:00) = 2024-10-05 15:30Z,
    // in the middle of a UTC hour.
    expect(c.offsetSeconds(ts('2024-10-05T15:29:59Z'))).toBe(10.5 * h);
    expect(c.offsetSeconds(ts('2024-10-05T15:30:00Z'))).toBe(11 * h);
    expect(c.offsetSeconds(ts('2024-10-05T15:45:00Z'))).toBe(11 * h);
    expect(c.toLocal(ts('2024-10-05T15:45:00Z'))).toBe(ts('2024-10-06T02:45:00Z'));
  });

  it('Asia/Kathmandu is +5:45, switched from +5:30 at 1985-12-31 18:30Z', () => {
    const c = createTzConverter('Asia/Kathmandu');
    expect(c.offsetSeconds(ts('2024-06-01T00:00:00Z'))).toBe(20_700);
    expect(c.offsetSeconds(ts('1985-12-31T18:29:59Z'))).toBe(19_800);
    expect(c.offsetSeconds(ts('1985-12-31T18:30:00Z'))).toBe(20_700);
    expect(c.offsetSeconds(ts('1985-12-31T18:45:00Z'))).toBe(20_700);
  });

  it('caches one interval per offset period, in any access order', () => {
    const z = new ZoneOffsets('America/New_York');
    const h = 3600;
    // Backward, then forward, then scattered: same answers.
    expect(z.offset(ts('2024-11-03T06:00:00Z'))).toBe(-5 * h);
    expect(z.offset(ts('2024-11-03T05:59:59Z'))).toBe(-4 * h);
    expect(z.offset(ts('2024-03-10T06:59:59Z'))).toBe(-5 * h);
    expect(z.offset(ts('2024-03-10T07:00:00Z'))).toBe(-4 * h);
    // Hourly queries over the year join into EST | EDT | EST.
    for (let t = ts('2024-01-01T00:00:00Z'); t < ts('2025-01-01T00:00:00Z'); t += h) z.offset(t);
    expect(z.intervalCount).toBe(3);
    expect(z.offset(ts('2024-03-10T06:59:59Z'))).toBe(-5 * h);
    expect(z.offset(ts('2024-03-10T07:00:00Z'))).toBe(-4 * h);
    expect(z.offset(ts('2024-11-03T05:59:59Z'))).toBe(-4 * h);
    expect(z.offset(ts('2024-11-03T06:00:00Z'))).toBe(-5 * h);
  });

  it('throws RangeError for unknown zones', () => {
    expect(() => new ZoneOffsets('Not/AZone')).toThrow(RangeError);
  });

  it('local resolves without throwing', () => {
    const c = createTzConverter('local');
    expect(Number.isFinite(c.offsetSeconds(ts('2024-06-01T00:00:00Z')))).toBe(true);
  });
});
