import { describe, expect, it } from 'vitest';
import { barAtOrBefore } from './tool';

describe('barAtOrBefore', () => {
  const t = Float64Array.from([10, 20, 30, 999]); // the last slot is beyond `length`
  it('finds the newest bar at or before the time', () => {
    expect(barAtOrBefore(t, 3, 20)).toBe(20);
    expect(barAtOrBefore(t, 3, 25)).toBe(20);
    expect(barAtOrBefore(t, 3, 500)).toBe(30);
  });
  it('is null before the first bar', () => {
    expect(barAtOrBefore(t, 3, 9)).toBeNull();
    expect(barAtOrBefore(t, 0, 50)).toBeNull();
  });
});
