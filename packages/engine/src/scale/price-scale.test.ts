import { describe, expect, it } from 'vitest';
import { PriceScale } from './price-scale';

function scale(): PriceScale {
  const ps = new PriceScale();
  ps.height = 500;
  ps.setAutoRange(100, 200);
  return ps;
}

describe('PriceScale', () => {
  it('maps the auto range inside the margins', () => {
    const ps = scale();
    expect(ps.priceToY(200)).toBeCloseTo(500 * ps.marginTop);
    expect(ps.priceToY(100)).toBeCloseTo(500 * (1 - ps.marginBottom));
  });

  it('round-trips price <-> y in every mode', () => {
    for (const mode of ['linear', 'log', 'percent', 'indexed'] as const) {
      const ps = new PriceScale();
      ps.height = 400;
      ps.mode = mode;
      ps.base = 120;
      ps.setAutoRange(100, 200);
      for (const p of [100, 137.5, 200]) expect(ps.yToPrice(ps.priceToY(p))).toBeCloseTo(p, 6);
    }
  });

  it('setManualRange fits the range between the margins and turns auto-scale off', () => {
    for (const invert of [false, true]) {
      const ps = scale();
      ps.invert = invert;
      ps.setManualRange(120, 140);
      expect(ps.autoScale).toBe(false);
      // Inversion mirrors the whole axis, margins included.
      const top = 500 * ps.marginTop;
      const bottom = 500 * (1 - ps.marginBottom);
      expect(ps.priceToY(140)).toBeCloseTo(invert ? 500 - top : top, 6);
      expect(ps.priceToY(120)).toBeCloseTo(invert ? 500 - bottom : bottom, 6);
    }
    const ps = scale();
    ps.setManualRange(140, 120);
    expect(ps.autoScale).toBe(true);
  });

  it('invert flips the axis', () => {
    const ps = scale();
    const y = ps.priceToY(180);
    ps.invert = true;
    expect(ps.priceToY(180)).toBeCloseTo(500 - y);
    expect(ps.yToPrice(500 - y)).toBeCloseTo(180);
  });

  it('percent mode displays change from base', () => {
    const ps = scale();
    ps.mode = 'percent';
    ps.base = 100;
    expect(ps.toDisplay(110)).toBeCloseTo(10);
  });

  it('manual scaling disables auto-scale and ignores later auto ranges', () => {
    const ps = scale();
    ps.scaleBy(2);
    expect(ps.autoScale).toBe(false);
    expect(ps.max - ps.min).toBeCloseTo(200);
    ps.setAutoRange(0, 1);
    expect(ps.max - ps.min).toBeCloseTo(200);
  });

  it('panBy shifts the range by pixels', () => {
    const ps = scale();
    const before = ps.yToPrice(250);
    ps.panBy(50);
    expect(ps.yToPrice(300)).toBeCloseTo(before);
  });

  it('produces ticks within the visible height', () => {
    const ps = scale();
    const ticks = ps.ticks();
    expect(ticks.length).toBeGreaterThan(3);
    for (const t of ticks) {
      expect(t.y).toBeGreaterThanOrEqual(-1);
      expect(t.y).toBeLessThanOrEqual(501);
    }
  });

  it('log ticks never crowd and cover top and bottom thirds', () => {
    const ps = new PriceScale();
    ps.mode = 'log';
    ps.height = 700;
    ps.setAutoRange(34, 1650);
    const ticks = ps.ticks(34);
    for (let i = 1; i < ticks.length; i++) {
      const a = ticks[i - 1] as { y: number };
      const b = ticks[i] as { y: number };
      expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(34);
    }
    expect(ticks.some((t) => t.y < 700 / 3)).toBe(true);
    expect(ticks.some((t) => t.y > (700 * 2) / 3)).toBe(true);
  });
});
