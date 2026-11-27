import { describe, expect, it } from 'vitest';
import {
  anchorRange,
  coerceInputs,
  drawableTypes,
  findIndicatorDef,
  searchIndicators,
} from './catalog';

describe('searchIndicators', () => {
  it('finds indicators by name and idea', () => {
    expect(searchIndicators('ichimoku')[0]?.name).toMatch(/Ichimoku/i);
    expect(searchIndicators('rsi')[0]?.id).toBe('rsi');
    expect(searchIndicators('')).toEqual([]);
  });
  it('resolves exact names and ids', () => {
    expect(findIndicatorDef('rsi')?.id).toBe('rsi');
    expect(findIndicatorDef('Relative Strength Index')?.id).toBe('rsi');
    expect(findIndicatorDef('no such thing')).toBeUndefined();
  });
});

describe('coerceInputs', () => {
  const rsi = findIndicatorDef('rsi')!;
  it('rounds, clamps and reports bad keys', () => {
    expect(coerceInputs(rsi, { length: 14.4 }).inputs.length).toBe(14);
    const bad = coerceInputs(rsi, { lenght: 14 });
    expect(bad.errors[0]).toMatch(/unknown input "lenght"/);
    expect(coerceInputs(rsi, 'x').errors).toEqual(['inputs must be an object']);
  });
});

describe('drawings', () => {
  it('knows anchor counts', () => {
    expect(anchorRange('fib-retracement')).toEqual({ min: 2, max: 2 });
    expect(anchorRange('fib-extension')).toEqual({ min: 3, max: 3 });
    expect(anchorRange('vertical-line')).toEqual({ min: 1, max: 1 });
    expect(anchorRange('nope')).toBeNull();
  });
  it('offers more types to Full than to Standard', () => {
    const standard = drawableTypes('standard');
    expect(standard).toContain('fib-retracement');
    expect(standard).toContain('rectangle');
    const full = drawableTypes('full');
    expect(full.length).toBeGreaterThan(standard.length);
    expect(full).toContain('pitchfork');
    expect(full).not.toContain('brush');
  });
});
