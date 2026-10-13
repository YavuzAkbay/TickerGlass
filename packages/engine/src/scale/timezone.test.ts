import { describe, expect, it } from 'vitest';
import { createTzConverter } from './timezone';

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

  it('local resolves without throwing', () => {
    const c = createTzConverter('local');
    expect(Number.isFinite(c.offsetSeconds(ts('2024-06-01T00:00:00Z')))).toBe(true);
  });
});
