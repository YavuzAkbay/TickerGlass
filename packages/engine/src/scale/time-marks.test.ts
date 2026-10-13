import { describe, expect, it } from 'vitest';
import {
  W_DAY,
  W_HOUR,
  W_MINUTE,
  W_MINUTE15,
  W_MINUTE30,
  W_MINUTE5,
  W_MONTH,
  W_YEAR,
  computeTimeWeights,
  formatCrosshairTime,
  formatTimeMark,
  selectTimeMarks,
} from './time-marks';
import { createTzConverter } from './timezone';

const ts = (s: string): number => Date.parse(s) / 1000;
const NY = createTzConverter('America/New_York');
const UTC = createTzConverter('UTC');

function series(start: string, step: number, count: number): Float64Array {
  const a = new Float64Array(count);
  const s = ts(start);
  for (let i = 0; i < count; i++) a[i] = s + i * step;
  return a;
}

describe('computeTimeWeights', () => {
  it('1m data across midnight and month/year end (NY)', () => {
    // 2024-12-31 23:58 NY = 2025-01-01 04:58Z
    const t = new Float64Array([
      ts('2024-12-31T23:58:00-05:00'),
      ts('2024-12-31T23:59:00-05:00'),
      ts('2025-01-01T00:00:00-05:00'),
      ts('2025-01-01T00:01:00-05:00'),
      ts('2025-01-31T23:59:00-05:00'),
      ts('2025-02-01T00:00:00-05:00'),
      ts('2025-02-02T00:00:00-05:00'),
    ]);
    const w = computeTimeWeights(t, NY);
    expect(w[1]).toBe(W_MINUTE);
    expect(w[2]).toBe(W_YEAR);
    expect(w[3]).toBe(W_MINUTE);
    expect(w[5]).toBe(W_MONTH);
    expect(w[6]).toBe(W_DAY);
  });

  it('daily data crossing month and year', () => {
    const t = new Float64Array([
      ts('2024-12-30T00:00:00Z'),
      ts('2024-12-31T00:00:00Z'),
      ts('2025-01-01T00:00:00Z'),
      ts('2025-01-02T00:00:00Z'),
      ts('2025-02-03T00:00:00Z'),
    ]);
    const w = computeTimeWeights(t, UTC);
    expect(Array.from(w)).toEqual([W_DAY, W_DAY, W_YEAR, W_DAY, W_MONTH]);
  });

  it('weekly data still yields month/year', () => {
    const t = new Float64Array([
      ts('2024-12-16T00:00:00Z'),
      ts('2024-12-23T00:00:00Z'),
      ts('2024-12-30T00:00:00Z'),
      ts('2025-01-06T00:00:00Z'),
      ts('2025-01-13T00:00:00Z'),
      ts('2025-02-03T00:00:00Z'),
    ]);
    const w = computeTimeWeights(t, UTC);
    expect(Array.from(w).slice(1)).toEqual([W_DAY, W_DAY, W_YEAR, W_DAY, W_MONTH]);
  });

  it('5m data: 30-minute marks', () => {
    const t = series('2024-03-12T13:30:00Z', 300, 20); // 09:30 NY (EDT)
    const w = computeTimeWeights(t, NY);
    expect(w[0]).toBe(W_MINUTE30);
    expect(w[1]).toBe(W_MINUTE5);
    expect(w[6]).toBe(W_HOUR); // 10:00
    expect(w[12]).toBe(W_MINUTE30);
    expect(w[18]).toBe(W_HOUR); // 11:00
    expect(w[3]).toBe(W_MINUTE15); // 09:45
  });

  it('reuses out buffer', () => {
    const out = new Uint8Array(10);
    const w = computeTimeWeights(series('2024-01-01T00:00:00Z', 60, 5), UTC, out);
    expect(w).toBe(out);
  });

  it('is fast for 100k 1m bars in NY', () => {
    const t = series('2024-01-01T14:30:00Z', 60, 100_000);
    const s = performance.now();
    computeTimeWeights(t, NY);
    expect(performance.now() - s).toBeLessThan(150);
  });
});

describe('selectTimeMarks', () => {
  const t = new Float64Array([
    ts('2024-12-29T00:00:00Z'),
    ts('2024-12-30T00:00:00Z'),
    ts('2024-12-31T00:00:00Z'),
    ts('2025-01-01T00:00:00Z'),
    ts('2025-01-02T00:00:00Z'),
    ts('2025-01-03T00:00:00Z'),
  ]);
  const w = computeTimeWeights(t, UTC);
  const base = { times: t, weights: w, from: 0, to: 5, indexToX: (i: number) => i * 10, tz: UTC };

  it('year mark wins over a nearby day mark and output is sorted', () => {
    const m = selectTimeMarks({ ...base, minSpacingPx: 25 });
    expect(m.some((x) => x.label === '2025' && x.index === 3)).toBe(true);
    expect(m.some((x) => x.index === 2 || x.index === 4)).toBe(false);
    for (let i = 1; i < m.length; i++) {
      expect((m[i] as { x: number }).x).toBeGreaterThan((m[i - 1] as { x: number }).x);
    }
  });

  it('honors spacing', () => {
    const m = selectTimeMarks({ ...base, minSpacingPx: 15 });
    for (let i = 1; i < m.length; i++) {
      expect((m[i] as { x: number }).x - (m[i - 1] as { x: number }).x).toBeGreaterThanOrEqual(15);
    }
  });

  it('is fast for 5000 visible bars', () => {
    const big = series('2024-01-02T14:30:00Z', 60, 5000);
    const bw = computeTimeWeights(big, UTC);
    const params = {
      times: big,
      weights: bw,
      from: 0,
      to: 4999,
      indexToX: (i: number) => i * 0.2,
      minSpacingPx: 60,
      tz: UTC,
    };
    selectTimeMarks(params);
    const s = performance.now();
    selectTimeMarks(params);
    expect(performance.now() - s).toBeLessThan(2);
  });
});

describe('formats', () => {
  const t = ts('2024-03-12T18:30:00Z'); // 14:30 NY
  it('formatTimeMark', () => {
    expect(formatTimeMark(t, W_YEAR, NY)).toBe('2024');
    expect(formatTimeMark(t, W_MONTH, NY)).toBe('Mar');
    expect(formatTimeMark(t, W_DAY, NY)).toBe('12');
    expect(formatTimeMark(t, W_MINUTE30, NY)).toBe('14:30');
  });
  it('formatCrosshairTime', () => {
    expect(formatCrosshairTime(t, 'minute', NY)).toBe("Tue 12 Mar '24 14:30");
    expect(formatCrosshairTime(t, 'hour', NY)).toBe("Tue 12 Mar '24 14:30");
    expect(formatCrosshairTime(t, 'day', NY)).toBe("Tue 12 Mar '24");
    expect(formatCrosshairTime(t, 'week', NY)).toBe("Tue 12 Mar '24");
    expect(formatCrosshairTime(t, 'month', NY)).toBe("Mar '24");
  });
});
