import { describe, expect, it } from 'vitest';
import { DEFAULT_RIGHT_OFFSET, MAX_BAR_SPACING, MIN_BAR_SPACING, TimeScale } from './time-scale';

function scale(bars = 1000, width = 800): TimeScale {
  const ts = new TimeScale();
  ts.width = width;
  ts.reset(bars - 1);
  return ts;
}

describe('TimeScale', () => {
  it('places the last bar rightOffset slots from the right edge', () => {
    const ts = scale();
    const x = ts.indexToX(999);
    expect(x).toBeCloseTo(800 - (DEFAULT_RIGHT_OFFSET + 0.5) * ts.barSpacing);
    expect(ts.xToIndex(x)).toBe(999);
  });

  it('round-trips x <-> logical index', () => {
    const ts = scale();
    for (const i of [0, 500, 990.25]) expect(ts.xToLogical(ts.indexToX(i))).toBeCloseTo(i);
  });

  it('zoom keeps the bar under the anchor fixed', () => {
    const ts = scale();
    const anchor = 300;
    const before = ts.xToLogical(anchor);
    ts.zoom(anchor, 1.7);
    expect(ts.xToLogical(anchor)).toBeCloseTo(before);
    ts.zoom(anchor, 0.3);
    expect(ts.xToLogical(anchor)).toBeCloseTo(before);
  });

  it('clamps bar spacing', () => {
    const ts = scale();
    ts.zoom(400, 1e6);
    expect(ts.barSpacing).toBe(MAX_BAR_SPACING);
    ts.zoom(400, 1e-6);
    expect(ts.barSpacing).toBe(MIN_BAR_SPACING);
  });

  it('pan moves content with the pointer and is clamped', () => {
    const ts = scale();
    const x0 = ts.indexToX(900);
    ts.pan(70);
    expect(ts.indexToX(900)).toBeCloseTo(x0 + 70);
    ts.pan(1e9);
    expect(ts.indexToX(0)).toBeLessThanOrEqual(ts.width);
    ts.pan(-1e9);
    expect(ts.indexToX(999)).toBeGreaterThanOrEqual(0);
  });

  it('prepending history does not move the view', () => {
    const ts = scale();
    const x = ts.indexToX(999);
    ts.onPrepend(500);
    expect(ts.indexToX(1499)).toBeCloseTo(x);
  });

  it('appending auto-scrolls only when the last bar is visible', () => {
    const ts = scale();
    const x = ts.indexToX(999);
    ts.onAppend();
    expect(ts.indexToX(1000)).toBeCloseTo(x);

    ts.pan(2000); // scroll back into history
    const xHist = ts.indexToX(500);
    ts.onAppend();
    expect(ts.indexToX(500)).toBeCloseTo(xHist);
  });

  it('visibleRange is clamped to data', () => {
    const ts = scale(50);
    const r = ts.visibleRange();
    expect(r.from).toBe(0);
    expect(r.to).toBe(49);
  });

  it('setVisibleLogicalRange is the inverse of logicalRange', () => {
    const ts = scale();
    expect(ts.setVisibleLogicalRange(100, 300)).toBe(true);
    expect(ts.barSpacing).toBeCloseTo(4); // 800 px / 200 bars
    const r = ts.logicalRange();
    expect(r.from).toBeCloseTo(100);
    expect(r.to).toBeCloseTo(300);
  });

  it('setVisibleLogicalRange clamps the spacing and centres the range', () => {
    const ts = scale();
    ts.setVisibleLogicalRange(500, 502); // 400 px per bar -> MAX_BAR_SPACING
    expect(ts.barSpacing).toBe(MAX_BAR_SPACING);
    const half = 800 / MAX_BAR_SPACING / 2;
    expect(ts.logicalRange().from).toBeCloseTo(501 - half);
    expect(ts.logicalRange().to).toBeCloseTo(501 + half);
  });

  it('setVisibleLogicalRange ignores empty or non-finite ranges', () => {
    const ts = scale();
    const before = ts.logicalRange();
    expect(ts.setVisibleLogicalRange(5, 5)).toBe(false);
    expect(ts.setVisibleLogicalRange(9, 3)).toBe(false);
    expect(ts.setVisibleLogicalRange(NaN, 3)).toBe(false);
    expect(ts.logicalRange()).toEqual(before);
  });
});
