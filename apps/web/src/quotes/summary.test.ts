import { describe, expect, it } from 'vitest';
import type { LiveQuote } from './types';
import { emptyQuote } from './merge';
import { summarize } from './summary';

const q = (symbol: string, changePercent: number | null): LiveQuote => ({
  ...emptyQuote(symbol),
  changePercent,
});

describe('summarize', () => {
  it('counts up / down / flat and averages', () => {
    const s = summarize(['A', 'B', 'C', 'D', 'E'], {
      A: q('A', 2),
      B: q('B', -1),
      C: q('C', 0),
      D: q('D', 4),
      E: q('E', -3),
    });
    expect(s.count).toBe(5);
    expect(s.total).toBe(5);
    expect(s.up).toBe(2);
    expect(s.down).toBe(2);
    expect(s.flat).toBe(1);
    expect(s.missing).toBe(0);
    expect(s.avgChange).toBeCloseTo(0.4);
    expect(s.top).toEqual({ symbol: 'D', changePercent: 4 });
    expect(s.bottom).toEqual({ symbol: 'E', changePercent: -3 });
  });

  it('treats symbols without a usable quote as missing', () => {
    const s = summarize(['A', 'B', 'C'], {
      A: q('A', 1),
      B: q('B', null),
      C: undefined,
    });
    expect(s.count).toBe(1);
    expect(s.missing).toBe(2);
    expect(s.avgChange).toBe(1);
    // The single counted symbol is both extremes.
    expect(s.top).toEqual({ symbol: 'A', changePercent: 1 });
    expect(s.bottom).toEqual({ symbol: 'A', changePercent: 1 });
  });

  it('handles an empty list', () => {
    const s = summarize([], {});
    expect(s).toMatchObject({ count: 0, total: 0, avgChange: null, top: null, bottom: null });
  });

  it('ignores non-finite percentages', () => {
    const s = summarize(['A'], { A: q('A', Number.NaN) });
    expect(s.count).toBe(0);
    expect(s.missing).toBe(1);
  });
});
