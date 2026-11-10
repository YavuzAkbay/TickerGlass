import { describe, expect, it } from 'vitest';
import { LEGEND_GRADIENT, divergingColor, scalePosition } from './color';
import { COLOR_METRICS } from './metrics';

const rgb = (s: string): number[] => (s.match(/\d+/g) ?? []).map(Number);

describe('scalePosition', () => {
  it('maps the centre to 0 and clamps at the range', () => {
    expect(scalePosition(0, 0, 3)).toBe(0);
    expect(scalePosition(1.5, 0, 3)).toBeCloseTo(0.5);
    expect(scalePosition(-1.5, 0, 3)).toBeCloseTo(-0.5);
    expect(scalePosition(9, 0, 3)).toBe(1);
    expect(scalePosition(-9, 0, 3)).toBe(-1);
  });

  it('respects an off-zero centre (RSI, relative volume)', () => {
    expect(scalePosition(50, 50, 20)).toBe(0);
    expect(scalePosition(30, 50, 20)).toBe(-1);
    expect(scalePosition(70, 50, 20)).toBe(1);
    expect(scalePosition(2, 1, 1)).toBe(1);
    expect(scalePosition(0, 1, 1)).toBe(-1);
  });

  it('treats junk as neutral', () => {
    expect(scalePosition(NaN, 0, 3)).toBe(0);
    expect(scalePosition(1, 0, 0)).toBe(0);
  });
});

describe('divergingColor', () => {
  it('is red for losses, green for gains, graphite at the centre', () => {
    const [r1, g1] = rgb(divergingColor(-1));
    const [r2, g2] = rgb(divergingColor(1));
    expect(r1!).toBeGreaterThan(g1!);
    expect(g2!).toBeGreaterThan(r2!);
    const mid = rgb(divergingColor(0));
    expect(Math.abs(mid[0]! - mid[1]!)).toBeLessThan(15);
  });

  it('moves monotonically away from the centre', () => {
    const steps = [0, 0.25, 0.5, 0.75, 1].map((t) => rgb(divergingColor(t)));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]![1]!).toBeGreaterThanOrEqual(steps[i - 1]![1]! - 0); // green channel rises
      expect(steps[i]![0]!).toBeLessThanOrEqual(steps[i - 1]![0]!); // red channel falls
    }
  });

  it('clamps outside [-1, 1] and ignores NaN', () => {
    expect(divergingColor(5)).toBe(divergingColor(1));
    expect(divergingColor(-5)).toBe(divergingColor(-1));
    expect(divergingColor(NaN)).toBe(divergingColor(0));
  });

  it('keeps white text readable on every shade (WCAG contrast >= 4.5)', () => {
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    for (let t = -1; t <= 1.0001; t += 0.1)
      expect(1.05 / (lum(rgb(divergingColor(t))) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('builds a legend gradient from the same scale', () => {
    expect(LEGEND_GRADIENT).toContain(divergingColor(-1));
    expect(LEGEND_GRADIENT).toContain(divergingColor(1));
    expect(LEGEND_GRADIENT.startsWith('linear-gradient(90deg')).toBe(true);
  });
});

describe('colour metrics', () => {
  it('clamp the 1-day change at +-3 % and the 1-month performance at +-10 %', () => {
    expect(COLOR_METRICS.change1d.range).toBe(3);
    expect(COLOR_METRICS.perf1m.range).toBe(10);
    expect(COLOR_METRICS.change1d.center).toBe(0);
    expect(COLOR_METRICS.rsi.center).toBe(50);
    expect(COLOR_METRICS.relVol.center).toBe(1);
  });

  it('print the sign so colour is never the only cue', () => {
    expect(COLOR_METRICS.change1d.format(1.234)).toBe('+1.23%');
    expect(COLOR_METRICS.change1d.format(-0.5)).toBe('−0.50%');
    expect(COLOR_METRICS.change1d.format(0)).toBe('0.00%');
    expect(COLOR_METRICS.rsi.format(28)).toBe('RSI 28.0');
    expect(COLOR_METRICS.relVol.format(1.8)).toBe('1.80×');
  });
});
