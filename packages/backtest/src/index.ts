/**
 * @tickerglass/backtest: strategy rules, signal evaluation, bar-by-bar fill
 * simulation and performance stats (docs/backtest.md). Pure TS, no DOM.
 */
export * from './types';
export { buildSignals, strategyOperands } from './signals';
export type { IndicatorResolver, SignalBuild } from './signals';
export { commissionOf, runBacktest } from './engine';
export { computeStats } from './stats';
export type { StatsInput } from './stats';
export { emptyRule, newStrategy, parseStrategy, parseStrategies } from './parse';
