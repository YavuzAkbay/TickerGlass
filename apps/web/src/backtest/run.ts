/**
 * Run a strategy on a chart (docs/backtest.md §5): rules read the chart's
 * computed study outputs, fills use the raw time bars, trades become chart
 * markers.
 */
import {
  buildSignals,
  runBacktest,
  type BacktestBars,
  type IndicatorOperand,
  type Strategy,
  type Trade,
} from '@tickerglass/backtest';
import { BRICK_TYPES, type Chart, type ChartMarker } from '@tickerglass/engine';
import type { IndicatorState } from '../indicators/model';
import type { BacktestRun } from './store';

export const BACKTEST_MARKER_GROUP = 'backtest-trades';
const UP = '#34c38f';
const DOWN = '#f2626b';
/** Newest trades drawn on the chart (each draws two markers). */
const MAX_MARKED_TRADES = 400;

/** Stable JSON with sorted keys, to compare indicator inputs. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * Chart study id for an operand: the same instance id, else an instance of
 * the same type with the same inputs (the strategy was built on another chart).
 */
export function findInstance(
  op: Pick<IndicatorOperand, 'instanceId' | 'type' | 'inputs'>,
  instances: readonly Pick<IndicatorState, 'id' | 'type' | 'inputs'>[],
): string | null {
  const same = instances.find((i) => i.id === op.instanceId && i.type === op.type);
  if (same) return same.id;
  const want = stableJson(op.inputs);
  return instances.find((i) => i.type === op.type && stableJson(i.inputs) === want)?.id ?? null;
}

export class BacktestError extends Error {}

function chartBars(chart: Chart): BacktestBars {
  if (BRICK_TYPES.has(chart.chartType))
    throw new BacktestError(
      'Strategies need time bars. Switch the chart to candles, bars, line or Heikin Ashi.',
    );
  // Heikin Ashi bars are index-aligned with the time bars: rules see what the chart shows,
  // fills use real prices.
  const s = chart.rawStore;
  if (chart.store.length !== s.length)
    throw new BacktestError('The chart is still loading. Try again in a moment.');
  const n = s.length;
  if (n < 2) throw new BacktestError('Not enough bars on the chart.');
  return {
    length: n,
    time: s.time.subarray(0, n),
    open: s.open.subarray(0, n),
    high: s.high.subarray(0, n),
    low: s.low.subarray(0, n),
    close: s.close.subarray(0, n),
  };
}

export interface RunDeps {
  chart: Chart;
  instances: readonly IndicatorState[];
  decimals: number;
  now?: () => number;
}

export function runOnChart(strategy: Strategy, deps: RunDeps): BacktestRun {
  const { chart, instances } = deps;
  const bars = chartBars(chart);
  const resolve = (op: IndicatorOperand): ArrayLike<number> | null => {
    const id = findInstance(op, instances);
    const data = id ? chart.getStudyData(id) : null;
    if (!data || !data.current) return null;
    const values = data.values[op.outputId];
    return values ? values.subarray(0, Math.min(data.length, bars.length)) : null;
  };
  const { signals, missing } = buildSignals(strategy, bars, resolve);
  const result = runBacktest(bars, signals, strategy.settings);
  return {
    strategyId: strategy.id,
    symbol: chart.getSymbol(),
    interval: chart.getInterval(),
    ranAt: (deps.now ?? Date.now)(),
    result,
    missing,
    decimals: deps.decimals,
    timezone: chart.timezone,
  };
}

function fmt(v: number, d: number): string {
  return Number.isFinite(v) ? v.toFixed(d) : '—';
}

export function tradeMarkers(trades: readonly Trade[], decimals: number): ChartMarker[] {
  const out: ChartMarker[] = [];
  for (const t of trades.slice(-MAX_MARKED_TRADES)) {
    const long = t.side === 'long';
    out.push({
      id: `bt-${t.n}-in`,
      time: t.entryTime,
      position: long ? 'belowBar' : 'aboveBar',
      color: long ? UP : DOWN,
      shape: long ? 'arrowUp' : 'arrowDown',
      tooltip: `#${t.n} ${long ? 'Long' : 'Short'} ${t.qty} @ ${fmt(t.entryPrice, decimals)}`,
    });
    if (t.exitReason === 'open') continue;
    out.push({
      id: `bt-${t.n}-out`,
      time: t.exitTime,
      position: 'price',
      price: t.exitPrice,
      color: t.pnl >= 0 ? UP : DOWN,
      shape: 'circle',
      tooltip: `#${t.n} exit (${t.exitReason}) @ ${fmt(t.exitPrice, decimals)}: ${t.pnl >= 0 ? '+' : ''}${fmt(t.pnl, 2)}`,
    });
  }
  return out;
}

/** Draw (or clear, with null) a run's trades on the chart. */
export function showRun(chart: Chart | null, run: BacktestRun | null): void {
  if (!chart) return;
  if (!run) {
    chart.setMarkers(BACKTEST_MARKER_GROUP, []);
    return;
  }
  const all = run.result.openTrade
    ? [...run.result.trades, run.result.openTrade]
    : run.result.trades;
  chart.setMarkers(BACKTEST_MARKER_GROUP, tradeMarkers(all, run.decimals));
}
