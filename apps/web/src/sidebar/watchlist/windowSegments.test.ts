import { describe, expect, it } from 'vitest';
import { windowSegments } from './windowSegments';

const range = { start: 10, end: 20 };
const heights = (segs: ReturnType<typeof windowSegments>) =>
  segs.reduce((n, s) => n + (s.gap ? s.rows : s.to - s.from), 0);

describe('windowSegments', () => {
  it('is the visible range between two gaps without a pinned row', () => {
    const segs = windowSegments(100, range, null);
    expect(segs).toEqual([
      { gap: true, key: 'gap-top', rows: 10 },
      { gap: false, from: 10, to: 20 },
      { gap: true, key: 'gap-bottom', rows: 80 },
    ]);
    expect(windowSegments(100, range, 15)).toEqual(segs);
  });

  it('keeps a pinned row above the range mounted', () => {
    const segs = windowSegments(100, range, 3);
    expect(segs.filter((s) => !s.gap)).toEqual([
      { gap: false, from: 3, to: 4 },
      { gap: false, from: 10, to: 20 },
    ]);
    expect(heights(segs)).toBe(100);
  });

  it('keeps a pinned row below the range mounted', () => {
    const segs = windowSegments(100, range, 60);
    expect(segs.filter((s) => !s.gap)).toEqual([
      { gap: false, from: 10, to: 20 },
      { gap: false, from: 60, to: 61 },
    ]);
    expect(heights(segs)).toBe(100);
  });
});
