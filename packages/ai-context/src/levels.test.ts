import { describe, expect, it } from 'vitest';
import { findLevels } from './levels';
import { macdLine, rsi } from './oscillators';
import type { BriefBars } from './types';

const DAY = 86_400;

function bars(closes: number[]): BriefBars {
  return {
    length: closes.length,
    time: closes.map((_, i) => 1_700_000_000 + i * DAY),
    open: closes,
    high: closes,
    low: closes,
    close: closes,
    volume: closes.map(() => 0),
  };
}

/** A zig-zag through the given turning points, `step` bars between them. */
function path(points: number[], step = 8): number[] {
  const out: number[] = [];
  for (let p = 1; p < points.length; p++) {
    const a = points[p - 1]!;
    const b = points[p]!;
    for (let i = 0; i < step; i++) out.push(a + ((b - a) * i) / step);
  }
  out.push(points.at(-1)!);
  return out;
}

describe('findLevels', () => {
  it('finds prices touched twice on both sides of the close', () => {
    // Highs near 200 twice, lows near 100 twice, then a drop below 100 to 80 and a bounce to 90.
    const closes = path([150, 200, 120, 199, 101, 160, 100, 130, 80, 90]);
    const levels = findLevels(bars(closes), { strength: 3 });
    const resist = levels.find((l) => l.role === 'resistance' && Math.abs(l.price - 200) < 3);
    const flip = levels.find((l) => Math.abs(l.price - 100) < 3);
    expect(resist?.touches.length).toBe(2);
    expect(flip?.role).toBe('resistance'); // old support, now above the close
    expect(levels.every((l) => l.touches.length >= 2)).toBe(true);
    expect(levels.map((l) => l.id)).toEqual(levels.map((_, i) => `L${i + 1}`));
  });

  it('returns nothing for very short data', () => {
    expect(findLevels(bars([1, 2, 3]))).toEqual([]);
  });
});

describe('oscillators', () => {
  it('computes Wilder RSI', () => {
    const up = rsi(
      Array.from({ length: 30 }, (_, i) => i),
      14,
    );
    expect(Number.isNaN(up[13]!)).toBe(true);
    expect(up[20]).toBe(100);
    const flatThenDown = rsi([...Array.from({ length: 15 }, () => 10), 9, 8, 7], 14);
    expect(flatThenDown[17]).toBe(0);
  });

  it('computes the MACD line', () => {
    const m = macdLine(Array.from({ length: 40 }, () => 5));
    expect(Number.isNaN(m[24]!)).toBe(true);
    expect(m[30]).toBeCloseTo(0);
  });
});
