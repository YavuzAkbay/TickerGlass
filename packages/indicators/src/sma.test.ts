import { describe, expect, it } from 'vitest';
import { sma } from './index';

describe('sma', () => {
  it('averages a sliding window and pads the warm-up with NaN', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(Array.from(out.slice(0, 2)).every(Number.isNaN)).toBe(true);
    expect(Array.from(out.slice(2))).toEqual([2, 3, 4]);
  });
});
