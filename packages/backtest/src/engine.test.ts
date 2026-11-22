import { describe, expect, it } from 'vitest';
import { runBacktest } from './engine';
import type { BacktestBars, Signals, StrategySettings } from './types';
import { DEFAULT_SETTINGS } from './types';

const DAY = 86_400;

/** Bars from [open, high, low, close] rows, one per day. */
function bars(rows: [number, number, number, number][]): BacktestBars {
  return {
    length: rows.length,
    time: rows.map((_, i) => 1_700_000_000 + i * DAY),
    open: rows.map((r) => r[0]),
    high: rows.map((r) => r[1]),
    low: rows.map((r) => r[2]),
    close: rows.map((r) => r[3]),
  };
}

function sig(n: number, on: Partial<Record<keyof Signals, number[]>>): Signals {
  const make = (idx: number[] = []) => {
    const a = new Uint8Array(n);
    for (const i of idx) a[i] = 1;
    return a;
  };
  return {
    longEntry: make(on.longEntry),
    longExit: make(on.longExit),
    shortEntry: make(on.shortEntry),
    shortExit: make(on.shortExit),
  };
}

const settings = (patch: Partial<StrategySettings> = {}): StrategySettings => ({
  ...structuredClone(DEFAULT_SETTINGS),
  commission: { mode: 'percent', value: 0 },
  ...patch,
});

const flat = (p: number): [number, number, number, number] => [p, p, p, p];

describe('runBacktest', () => {
  it('fills at the next open, never on the signal bar', () => {
    const b = bars([flat(10), [11, 12, 11, 12], [13, 14, 13, 14], [15, 15, 15, 15]]);
    const r = runBacktest(b, sig(4, { longEntry: [0], longExit: [1] }), settings());
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.entryIndex).toBe(1);
    expect(t.entryPrice).toBe(11);
    expect(t.exitIndex).toBe(2);
    expect(t.exitPrice).toBe(13);
    // 10_000 / 11 = 909 whole shares.
    expect(t.qty).toBe(909);
    expect(t.pnl).toBeCloseTo(909 * 2);
    expect(t.exitReason).toBe('signal');
  });

  it('fills at the close in close mode', () => {
    const b = bars([flat(10), flat(12), flat(15)]);
    const r = runBacktest(
      b,
      sig(3, { longEntry: [0], longExit: [1] }),
      settings({ fillAt: 'close' }),
    );
    expect(r.trades[0]!.entryPrice).toBe(10);
    expect(r.trades[0]!.exitPrice).toBe(12);
  });

  it('reverses on an opposite entry and shorts profit from a fall', () => {
    const b = bars([flat(100), flat(100), flat(90), flat(80), flat(80)]);
    const r = runBacktest(
      b,
      sig(5, { longEntry: [0], shortEntry: [1], shortExit: [3] }),
      settings({ sizing: { mode: 'fixedQty', value: 10 } }),
    );
    expect(r.trades.map((t) => [t.side, t.exitReason])).toEqual([
      ['long', 'reverse'],
      ['short', 'signal'],
    ]);
    const short = r.trades[1]!;
    expect(short.entryPrice).toBe(90);
    expect(short.exitPrice).toBe(80);
    expect(short.pnl).toBeCloseTo(100);
    expect(r.stats.finalEquity).toBeCloseTo(10_000 - 100 + 100);
  });

  it('takes neither entry when long and short fire together while flat', () => {
    const b = bars([flat(10), flat(10), flat(10)]);
    const r = runBacktest(b, sig(3, { longEntry: [0], shortEntry: [0] }), settings());
    expect(r.trades).toHaveLength(0);
    expect(r.openTrade).toBeNull();
  });

  it('hits the stop intrabar, the stop winning a tie with the target', () => {
    // Entry at 100 (open of bar 1); bar 2 spans 94..106 -> both levels, stop first.
    const b = bars([flat(100), flat(100), [100, 106, 94, 100], flat(100)]);
    const r = runBacktest(
      b,
      sig(4, { longEntry: [0] }),
      settings({ stopLossPct: 5, takeProfitPct: 5, sizing: { mode: 'fixedQty', value: 1 } }),
    );
    expect(r.trades[0]!.exitReason).toBe('stop');
    expect(r.trades[0]!.exitPrice).toBeCloseTo(95);
  });

  it('fills a gap through the stop at the open', () => {
    const b = bars([flat(100), flat(100), [90, 91, 89, 90]]);
    const r = runBacktest(
      b,
      sig(3, { longEntry: [0] }),
      settings({ stopLossPct: 5, sizing: { mode: 'fixedQty', value: 1 } }),
    );
    expect(r.trades[0]!.exitPrice).toBe(90);
  });

  it('takes the target', () => {
    const b = bars([flat(100), flat(100), [101, 111, 100, 105]]);
    const r = runBacktest(
      b,
      sig(3, { longEntry: [0] }),
      settings({ takeProfitPct: 10, sizing: { mode: 'fixedQty', value: 1 } }),
    );
    expect(r.trades[0]!.exitReason).toBe('target');
    expect(r.trades[0]!.exitPrice).toBeCloseTo(110);
  });

  it('charges commission and slippage on both sides', () => {
    const b = bars([flat(100), flat(100), flat(100)]);
    const r = runBacktest(
      b,
      sig(3, { longEntry: [0], longExit: [1] }),
      settings({
        sizing: { mode: 'fixedQty', value: 10 },
        commission: { mode: 'perOrder', value: 1 },
        slippagePct: 1,
      }),
    );
    const t = r.trades[0]!;
    expect(t.entryPrice).toBeCloseTo(101);
    expect(t.exitPrice).toBeCloseTo(99);
    expect(t.commission).toBe(2);
    expect(t.pnl).toBeCloseTo(-20 - 2);
    expect(r.stats.finalEquity).toBeCloseTo(10_000 - 22);
  });

  it('reports an open trade marked at the last close', () => {
    const b = bars([flat(10), flat(10), flat(12)]);
    const r = runBacktest(
      b,
      sig(3, { longEntry: [0] }),
      settings({ sizing: { mode: 'fixedQty', value: 5 } }),
    );
    expect(r.trades).toHaveLength(0);
    expect(r.openTrade?.exitReason).toBe('open');
    expect(r.openTrade?.pnl).toBeCloseTo(10);
    expect(r.stats.openPnl).toBeCloseTo(10);
    expect(r.equity[2]).toBeCloseTo(10_010);
  });

  it('builds the equity and drawdown curves', () => {
    const b = bars([flat(100), flat(100), flat(120), flat(90), flat(90)]);
    const r = runBacktest(
      b,
      sig(5, { longEntry: [0] }),
      settings({ sizing: { mode: 'fixedQty', value: 10 } }),
    );
    expect(Array.from(r.equity)).toEqual([10_000, 10_000, 10_200, 9_900, 9_900]);
    expect(r.stats.maxDrawdown).toBeCloseTo(300);
    expect(r.drawdown[3]).toBeCloseTo((-300 / 10_200) * 100);
    expect(r.stats.exposurePct).toBeCloseTo(80);
  });

  it('sizes with fractional units and leaves room for a percent commission', () => {
    const b = bars([flat(100), flat(100), flat(100)]);
    const r = runBacktest(
      b,
      sig(3, { longEntry: [0], longExit: [1] }),
      settings({ fractional: true, commission: { mode: 'percent', value: 1 } }),
    );
    const t = r.trades[0]!;
    expect(t.qty * 100 * 1.01).toBeCloseTo(10_000);
  });
});
