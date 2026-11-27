import { describe, expect, it } from 'vitest';
import { macdHistogram, macdLine } from './oscillators';

describe('macdHistogram', () => {
  it('is the MACD line minus its 9-period EMA', () => {
    const close = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 6));
    const line = macdLine(close);
    const hist = macdHistogram(close);
    expect(Number.isNaN(hist[24]!)).toBe(true);
    // The signal EMA starts at the first MACD value, so the histogram starts at 0.
    expect(hist[25]).toBeCloseTo(0, 10);
    const k = 2 / 10;
    let sig = line[25]!;
    for (let i = 26; i < 80; i++) sig = line[i]! * k + sig * (1 - k);
    expect(hist[79]).toBeCloseTo(line[79]! - sig, 10);
  });
});
