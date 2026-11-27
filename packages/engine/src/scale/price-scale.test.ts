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

  it('reserveBottomPx widens the bottom margin and round-trips', () => {
    const ps = scale();
    const y0 = ps.priceToY(100);
    expect(y0).toBeCloseTo(500 * (1 - 0.08));
    ps.reserveBottomPx = 10; // below the 40px margin: no effect
    expect(ps.priceToY(100)).toBeCloseTo(y0);
    ps.reserveBottomPx = 80;
    expect(ps.priceToY(100)).toBeCloseTo(420);
    expect(ps.priceToY(200)).toBeCloseTo(50);
    expect(ps.yToPrice(ps.priceToY(137))).toBeCloseTo(137);
    ps.invert = true;
    // Inverted: the low end sits at the top, the reserve stays at the visual bottom.
    expect(ps.priceToY(200)).toBeCloseTo(420);
    expect(ps.yToPrice(ps.priceToY(137))).toBeCloseTo(137);
  });

  it('log ticks of a narrow range fall back to dense linear steps', () => {
    const ps = new PriceScale();
    ps.mode = 'log';
    ps.height = 700;
    ps.setAutoRange(1523.2, 1524.6);
    const set = ps.tickSet(34);
    expect(set.ticks.length).toBeGreaterThan(8);
    for (let i = 1; i < set.ticks.length; i++)
      expect(Math.abs(set.ticks[i]!.y - set.ticks[i - 1]!.y)).toBeGreaterThanOrEqual(34);
    expect(set.decimals).toBe(1);
  });

  it('log tick decimals resolve tiny prices', () => {
    const ps = new PriceScale();
    ps.mode = 'log';
    ps.height = 500;
    ps.setAutoRange(0.000148, 0.000156);
    const set = ps.tickSet(34);
    expect(set.ticks.length).toBeGreaterThan(3);
    expect(set.decimals).toBeGreaterThanOrEqual(6);
    for (const t of set.ticks) expect(t.value.toFixed(set.decimals!)).not.toMatch(/^0\.0+$/);
  });

  it('linear tick sets carry no step decimals', () => {
    expect(scale().tickSet().decimals).toBeNull();
  });

  it('keeps the price window fixed when the base changes with auto-scale off', () => {
    for (const mode of ['percent', 'indexed'] as const) {
      const ps = new PriceScale();
      ps.height = 500;
      ps.mode = mode;
      ps.setBase(100);
      ps.setAutoRange(100, 200);
      ps.scaleBy(0.8); // user zoom -> manual
      expect(ps.autoScale).toBe(false);
      const y = ps.priceToY(150);
      const lo = ps.yToPrice(500);
      ps.setBase(125); // horizontal pan changed the first visible close
      expect(ps.base).toBe(125);
      expect(ps.priceToY(150)).toBeCloseTo(y, 6);
      expect(ps.yToPrice(500)).toBeCloseTo(lo, 6);
    }
  });

  it('adopts the base as-is while auto-scale is on, and after resetBase', () => {
    const ps = new PriceScale();
    ps.mode = 'percent';
    ps.setBase(100);
    ps.setAutoRange(100, 200);
    ps.setBase(125);
    expect(ps.base).toBe(125);
    ps.scaleBy(1);
    const [min, max] = [ps.min, ps.max];
    ps.resetBase();
    ps.setBase(50);
    expect([ps.min, ps.max]).toEqual([min, max]);
  });

  it('scaleBy stays finite and ordered under repeated extreme zoom', () => {
    for (const mode of ['linear', 'log', 'percent', 'indexed'] as const) {
      for (const factor of [1e-3, 1e3]) {
        const ps = new PriceScale();
        ps.height = 500;
        ps.mode = mode;
        ps.setBase(100);
        ps.setAutoRange(100, 200);
        for (let i = 0; i < 400; i++) ps.scaleBy(factor);
        expect(Number.isFinite(ps.min)).toBe(true);
        expect(Number.isFinite(ps.max)).toBe(true);
        expect(ps.max).toBeGreaterThan(ps.min);
        expect(Number.isFinite(ps.yToPrice(0))).toBe(true);
        expect(Number.isFinite(ps.yToPrice(500))).toBe(true);
        if (mode === 'log') expect(ps.yToPrice(0)).toBeGreaterThan(0);
        // Still recoverable: zooming back changes the span.
        const span = ps.max - ps.min;
        ps.scaleBy(factor < 1 ? 2 : 0.5);
        expect(ps.max - ps.min).not.toBe(span);
      }
    }
  });

  it('scaleBy ignores invalid factors', () => {
    const ps = scale();
    ps.scaleBy(NaN);
    ps.scaleBy(-2);
    ps.scaleBy(0);
    expect([ps.min, ps.max]).toEqual([100, 200]);
  });
});
