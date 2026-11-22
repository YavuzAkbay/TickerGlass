import { newStrategy, type Strategy } from '@tickerglass/backtest';
import type { Chart } from '@tickerglass/engine';
import { describe, expect, it, vi } from 'vitest';
import type { IndicatorState } from '../indicators/model';
import { BacktestError, findInstance, runOnChart, showRun, stableJson, tradeMarkers } from './run';

const closes = [10, 10, 11, 12, 13, 12, 11, 10, 11, 12];
const f64 = (a: number[]) => Float64Array.from(a);
const store = {
  length: closes.length,
  time: f64(closes.map((_, i) => 1_700_000_000 + i * 86_400)),
  open: f64(closes),
  high: f64(closes.map((c) => c + 0.5)),
  low: f64(closes.map((c) => c - 0.5)),
  close: f64(closes),
};

/** "Cross" study: a mark (any value) on bars 1 and 6. */
const marks = f64(closes.map((_, i) => (i === 1 || i === 6 ? 1 : NaN)));

function fakeChart(patch: Partial<Record<string, unknown>> = {}): Chart {
  return {
    chartType: 'candles',
    store,
    rawStore: store,
    timezone: 'UTC',
    getSymbol: () => 'AAPL',
    getInterval: () => '1D',
    getStudyData: (id: string) =>
      id === 'live1'
        ? { spec: { outputs: [] }, length: closes.length, current: true, values: { up: marks } }
        : null,
    setMarkers: vi.fn(),
    ...patch,
  } as unknown as Chart;
}

const inst = (id: string, inputs: Record<string, unknown> = { length: 9 }): IndicatorState =>
  ({ id, type: 'user:x', inputs }) as unknown as IndicatorState;

function strategy(): Strategy {
  const s = newStrategy('s1', 'Test');
  s.settings.commission = { mode: 'percent', value: 0 };
  s.settings.sizing = { mode: 'fixedQty', value: 1 };
  s.longEntry = {
    match: 'all',
    conditions: [
      {
        kind: 'signal',
        left: {
          kind: 'indicator',
          instanceId: 'old',
          type: 'user:x',
          inputs: { length: 9 },
          outputId: 'up',
          title: 'X',
        },
      },
    ],
  };
  s.longExit = {
    match: 'all',
    conditions: [
      {
        kind: 'compare',
        left: { kind: 'price', field: 'close' },
        op: 'greater',
        right: { kind: 'value', value: 12.5 },
      },
    ],
  };
  return s;
}

describe('stableJson / findInstance', () => {
  it('ignores key order', () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
      stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }),
    );
  });

  it('prefers the same instance id, then type + inputs', () => {
    const list = [inst('a', { length: 5 }), inst('b', { length: 9 })];
    expect(findInstance({ instanceId: 'a', type: 'user:x', inputs: {} }, list)).toBe('a');
    expect(findInstance({ instanceId: 'gone', type: 'user:x', inputs: { length: 9 } }, list)).toBe(
      'b',
    );
    expect(
      findInstance({ instanceId: 'gone', type: 'user:x', inputs: { length: 7 } }, list),
    ).toBeNull();
  });
});

describe('runOnChart', () => {
  it('resolves operands from chart studies and simulates', () => {
    const run = runOnChart(strategy(), {
      chart: fakeChart(),
      instances: [inst('live1')],
      decimals: 2,
      now: () => 5,
    });
    expect(run.missing).toEqual([]);
    // Mark on bar 1 -> buy bar 2 open (11); close 13 > 12.5 on bar 4 -> sell bar 5 open (12).
    // Mark on bar 6 -> buy bar 7 open (10), held to the end.
    expect(run.result.trades.map((t) => [t.entryPrice, t.exitPrice])).toEqual([[11, 12]]);
    expect(run.result.openTrade?.entryPrice).toBe(10);
    expect(run).toMatchObject({ symbol: 'AAPL', interval: '1D', ranAt: 5 });
  });

  it('reports operands that are not on the chart', () => {
    const run = runOnChart(strategy(), { chart: fakeChart(), instances: [], decimals: 2 });
    expect(run.missing.map((m) => m.title)).toEqual(['X']);
    expect(run.result.trades).toEqual([]);
  });

  it('refuses brick chart types', () => {
    expect(() =>
      runOnChart(strategy(), {
        chart: fakeChart({ chartType: 'renko' }),
        instances: [],
        decimals: 2,
      }),
    ).toThrow(BacktestError);
  });

  it('draws entry and exit markers and clears them', () => {
    const chart = fakeChart();
    const run = runOnChart(strategy(), { chart, instances: [inst('live1')], decimals: 2 });
    showRun(chart, run);
    const drawn = (chart.setMarkers as ReturnType<typeof vi.fn>).mock.calls[0]![1] as unknown[];
    // Closed trade: in + out; open trade: in only.
    expect(drawn).toHaveLength(3);
    showRun(chart, null);
    expect((chart.setMarkers as ReturnType<typeof vi.fn>).mock.calls[1]![1]).toEqual([]);
    expect(tradeMarkers(run.result.trades, 2)[0]).toMatchObject({
      shape: 'arrowUp',
      position: 'belowBar',
    });
  });
});
