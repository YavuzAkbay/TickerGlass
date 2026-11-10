import { describe, expect, it } from 'vitest';
import { virtualRange } from './virtualRows';

describe('virtualRange', () => {
  it('covers the viewport plus overscan on both sides', () => {
    // 100 rows of 36px, viewport 360px (10 rows), overscan 6.
    expect(virtualRange(0, 360, 100, 36, 6)).toEqual({ start: 0, end: 17 });
  });

  it('slides with scrollTop', () => {
    const r = virtualRange(36 * 20, 360, 100, 36, 6);
    expect(r.start).toBe(14); // row 20 minus 6 overscan
    expect(r.end).toBe(37);
  });

  it('clamps to the last row', () => {
    const r = virtualRange(36 * 99, 360, 100, 36, 6);
    expect(r.start).toBe(93);
    expect(r.end).toBe(100);
  });

  it('never returns rows past the count with a tall viewport', () => {
    expect(virtualRange(0, 10_000, 5, 36, 6)).toEqual({ start: 0, end: 5 });
  });

  it('handles an empty list and degenerate inputs', () => {
    expect(virtualRange(0, 360, 0, 36)).toEqual({ start: 0, end: 0 });
    expect(virtualRange(0, 360, 10, 0)).toEqual({ start: 0, end: 0 });
  });
});
