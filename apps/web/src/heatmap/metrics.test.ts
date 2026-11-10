import { describe, expect, it } from 'vitest';
import type { LiveQuote } from '../quotes/types';
import {
  COLOR_METRICS,
  HEATMAP_LIVE_CAP,
  isLiveSize,
  pickLargest,
  quantize,
  sizesMoved,
  resolveSizes,
  sizeValue,
  type HeatSymbol,
} from './metrics';

const sym = (symbol: string, over: Partial<HeatSymbol> = {}): HeatSymbol => ({
  symbol,
  name: symbol,
  group: '',
  cap: null,
  snap: undefined,
  ...over,
});
const quote = (over: Partial<LiveQuote>): LiveQuote => ({
  symbol: 'X',
  last: 100,
  prevClose: 99,
  change: 1,
  changePercent: 1,
  volume: 1000,
  dayHigh: null,
  dayLow: null,
  currency: 'USD',
  marketState: null,
  ext: null,
  lastTickMs: null,
  snapshotMs: null,
  flash: null,
  ...over,
});

describe('sizeValue', () => {
  it('market cap: live quote first, then snapshot, then the static cap', () => {
    const s = sym('A', { snap: { mcap: 2e12 }, cap: 1e12 });
    expect(sizeValue('marketCap', s, quote({ marketCap: 3e12 }))).toBe(3e12);
    expect(sizeValue('marketCap', s, undefined)).toBe(2e12);
    expect(sizeValue('marketCap', sym('B', { cap: 5e9 }), undefined)).toBe(5e9);
    expect(sizeValue('marketCap', sym('C'), undefined)).toBeNull();
    expect(sizeValue('marketCap', sym('D', { snap: { mcap: -1 } }), undefined)).toBeNull();
  });

  it('volume and average dollar volume', () => {
    expect(sizeValue('volume', sym('A'), quote({ volume: 5000 }))).toBe(5000);
    expect(sizeValue('volume', sym('A', { snap: { volume: 70 } }), undefined)).toBe(70);
    expect(sizeValue('dollarVolume', sym('A', { snap: { avgDollarVol30: 9e6 } }), undefined)).toBe(
      9e6,
    );
    expect(sizeValue('dollarVolume', sym('A'), quote({ volume: 10, last: 5 }))).toBe(50);
    expect(sizeValue('dollarVolume', sym('A'), undefined)).toBeNull();
  });

  it('equal is always 1', () => {
    expect(sizeValue('equal', sym('A'), undefined)).toBe(1);
  });

  it('volume and market cap sizes follow live quotes', () => {
    expect(isLiveSize('volume')).toBe(true);
    expect(isLiveSize('dollarVolume')).toBe(true);
    expect(isLiveSize('marketCap')).toBe(true);
    expect(isLiveSize('equal')).toBe(false);
  });
});

describe('resolveSizes', () => {
  it('gives symbols without a size the smallest known one', () => {
    const out = resolveSizes(
      'marketCap',
      [sym('A', { cap: 300 }), sym('B'), sym('C', { cap: 100 })],
      {},
    );
    expect(out).toEqual({ sizes: [300, 100, 100], equalFallback: false });
  });

  it('falls back to equal tiles when no symbol has a size (and says so)', () => {
    const out = resolveSizes('marketCap', [sym('A'), sym('B')], {});
    expect(out).toEqual({ sizes: [1, 1], equalFallback: true });
    expect(resolveSizes('equal', [sym('A')], {}).equalFallback).toBe(false);
  });
});

describe('quantize', () => {
  it('keeps three significant digits so tiny changes do not move the layout', () => {
    expect(quantize(3_012_345_678_901)).toBe(quantize(3_012_999_000_000 - 800_000_000));
    expect(quantize(123456)).toBe(123000);
    expect(quantize(0.0123456)).toBeCloseTo(0.0123);
    expect(quantize(0)).toBe(0);
    expect(quantize(NaN)).toBe(0);
  });
});

describe('pickLargest (live subscription cap)', () => {
  const many = Array.from({ length: 500 }, (_, i) => sym(`S${i}`, { cap: i + 1 }));

  it('subscribes everything up to the cap', () => {
    const few = many.slice(0, HEATMAP_LIVE_CAP);
    expect(pickLargest(few, (s) => s.cap, HEATMAP_LIVE_CAP)).toHaveLength(HEATMAP_LIVE_CAP);
  });

  it('keeps the largest tiles beyond it', () => {
    const picked = pickLargest(many, (s) => s.cap, HEATMAP_LIVE_CAP);
    expect(picked).toHaveLength(200);
    expect(picked[0]).toBe('S499');
    expect(picked).toContain('S300');
    expect(picked).not.toContain('S299');
  });

  it('ranks unknown sizes last and keeps list order among equals', () => {
    const list = [sym('A'), sym('B', { cap: 2 }), sym('C'), sym('D', { cap: 1 })];
    expect(pickLargest(list, (s) => s.cap, 3)).toEqual(['B', 'D', 'A']);
  });
});

describe('colour metric readers', () => {
  it('1D change: live quote first, snapshot second', () => {
    const s = sym('A', { snap: { chg1d: 2 } });
    expect(COLOR_METRICS.change1d.read(s, quote({ changePercent: -1 }))).toBe(-1);
    expect(COLOR_METRICS.change1d.read(s, undefined)).toBe(2);
    expect(COLOR_METRICS.change1d.read(sym('B'), undefined)).toBeNull();
  });

  it('performance, RSI and relative volume come from the snapshot', () => {
    const s = sym('A', { snap: { perf1w: 1, perf1m: 2, perfYtd: 3, rsi14: 41, relVol: 1.5 } });
    expect(COLOR_METRICS.perf1w.read(s, undefined)).toBe(1);
    expect(COLOR_METRICS.perf1m.read(s, undefined)).toBe(2);
    expect(COLOR_METRICS.perfYtd.read(s, undefined)).toBe(3);
    expect(COLOR_METRICS.rsi.read(s, undefined)).toBe(41);
    expect(COLOR_METRICS.relVol.read(s, undefined)).toBe(1.5);
    expect(COLOR_METRICS.relVol.read(s, quote({ volume: 3000, averageVolume: 1000 }))).toBe(3);
  });
});

describe('sizesMoved', () => {
  const m = (o: Record<string, number>) => new Map(Object.entries(o));
  it('ignores small moves and reacts to big ones or another symbol set', () => {
    const held = m({ A: 100, B: 200 });
    expect(sizesMoved(held, m({ A: 101, B: 197 }))).toBe(false);
    expect(sizesMoved(held, m({ A: 100, B: 211 }))).toBe(true);
    expect(sizesMoved(held, m({ A: 94, B: 200 }))).toBe(true);
    expect(sizesMoved(held, m({ A: 100 }))).toBe(true);
    expect(sizesMoved(held, m({ A: 100, C: 200 }))).toBe(true);
  });
});
