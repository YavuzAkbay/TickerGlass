import { describe, expect, it } from 'vitest';
import {
  decimalsForMinTick,
  formatPercent,
  formatPrice,
  formatVolume,
  linearTicks,
  logTicks,
  niceStep,
} from './price-ticks';

describe('niceStep', () => {
  it('returns 1/2/2.5/5 x 10^k', () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(100, 4)).toBe(25);
    expect(niceStep(50, 10)).toBe(5);
    expect(niceStep(0.5, 5)).toBeCloseTo(0.1, 12);
  });
});

describe('linearTicks', () => {
  it('has no float drift', () => {
    const t = linearTicks(0.1234, 0.1567, 5);
    expect(t.length).toBeGreaterThan(2);
    for (const v of t) {
      expect(String(v).length).toBeLessThanOrEqual(7);
      expect(v).toBeGreaterThanOrEqual(0.1234);
      expect(v).toBeLessThanOrEqual(0.1567);
    }
  });
  it('(95,105) steps by 1 or 2', () => {
    const t = linearTicks(95, 105, 8);
    const step = (t[1] as number) - (t[0] as number);
    expect([1, 2]).toContain(step);
  });
});

describe('logTicks', () => {
  it('(1,1000) contains decades', () => {
    const t = logTicks(1, 1000, 6);
    for (const v of [1, 10, 100, 1000]) expect(t).toContain(v);
  });
  it('wide range uses 1/2/5 when room', () => {
    expect(logTicks(1, 100, 10)).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });
  it('narrow range falls back to linear', () => {
    const t = logTicks(100, 120, 5);
    expect(t).toEqual(linearTicks(100, 120, 5));
  });
});

describe('formatting', () => {
  it('decimalsForMinTick', () => {
    expect(decimalsForMinTick(0.01)).toBe(2);
    expect(decimalsForMinTick(0.0001)).toBe(4);
    expect(decimalsForMinTick(1)).toBe(0);
    expect(decimalsForMinTick(0.25)).toBe(2);
  });
  it('formatPrice', () => {
    expect(formatPrice(1234.5, 2)).toBe('1234.50');
    expect(formatPrice(-3.456, 2)).toBe('−3.46');
    expect(formatPrice(-0.001, 2)).toBe('0.00');
  });
  it('formatVolume', () => {
    expect(formatVolume(999)).toBe('999');
    expect(formatVolume(1500)).toBe('1.5K');
    expect(formatVolume(2_350_000)).toBe('2.35M');
    expect(formatVolume(1.2e9)).toBe('1.2B');
    expect(formatVolume(1_000_000)).toBe('1M');
  });
  it('formatPercent', () => {
    expect(formatPercent(1.234)).toBe('+1.23%');
    expect(formatPercent(-0.5)).toBe('−0.50%');
    expect(formatPercent(0)).toBe('0.00%');
  });
});
