/**
 * Strategy tester wire types (docs/backtest.md). JSON-serialisable: strategies
 * are stored as the synced user setting `backtest.strategies`. Change additively.
 */
import type { MovingOp, PriceField } from '@tickerglass/alerts';

export const STRATEGY_SCHEMA_VERSION = 1;

export type { PriceField };

export interface PriceOperand {
  kind: 'price';
  field: PriceField;
}

/**
 * One output of an indicator on the chart. Resolved by `instanceId` first,
 * then by `type` + `inputs` (another chart with the same indicator).
 */
export interface IndicatorOperand {
  kind: 'indicator';
  instanceId: string;
  type: string;
  inputs: Record<string, unknown>;
  outputId: string;
  /** Legend-style label at creation ("RSI 14 close"), for display only. */
  title: string;
}

export interface ConstOperand {
  kind: 'value';
  value: number;
}

export type Operand = PriceOperand | IndicatorOperand;

export type CompareOp = 'crossingUp' | 'crossingDown' | 'crossing' | 'greater' | 'less';

export const COMPARE_OPS: readonly CompareOp[] = [
  'crossingUp',
  'crossingDown',
  'crossing',
  'greater',
  'less',
];

export const MOVE_OPS: readonly MovingOp[] = [
  'movingUp',
  'movingDown',
  'movingUpPercent',
  'movingDownPercent',
];

export type { MovingOp };

export interface CompareCondition {
  kind: 'compare';
  left: Operand;
  op: CompareOp;
  right: Operand | ConstOperand;
}

export interface MovingRuleCondition {
  kind: 'moving';
  left: Operand;
  op: MovingOp;
  /** Points, or percent for the *Percent ops. */
  amount: number;
  /** Compare with the value this many bars back (>= 1). */
  bars: number;
}

/** True on bars where the output has a value (a shape mark of a built-in or a script). */
export interface SignalCondition {
  kind: 'signal';
  left: IndicatorOperand;
}

export type RuleCondition = CompareCondition | MovingRuleCondition | SignalCondition;

/** Conditions joined by all / any. No conditions = never fires. */
export interface Rule {
  match: 'all' | 'any';
  conditions: RuleCondition[];
}

export type RuleKey = 'longEntry' | 'longExit' | 'shortEntry' | 'shortExit';

export const RULE_KEYS: readonly RuleKey[] = ['longEntry', 'longExit', 'shortEntry', 'shortExit'];

export type SizingMode = 'percentEquity' | 'fixedQty' | 'fixedCash';
export type CommissionMode = 'percent' | 'perOrder' | 'perShare';
/** Where a signal decided on bar i's close is filled. */
export type FillAt = 'nextOpen' | 'close';

export interface StrategySettings {
  initialCapital: number;
  sizing: { mode: SizingMode; value: number };
  /** Whole units unless true. */
  fractional: boolean;
  commission: { mode: CommissionMode; value: number };
  /** Percent, adverse, on market and stop fills. */
  slippagePct: number;
  fillAt: FillAt;
  /** Percent from the entry price; 0 = off. */
  stopLossPct: number;
  /** Percent from the entry price; 0 = off. */
  takeProfitPct: number;
}

export const DEFAULT_SETTINGS: Readonly<StrategySettings> = Object.freeze({
  initialCapital: 10_000,
  sizing: Object.freeze({ mode: 'percentEquity', value: 100 }) as StrategySettings['sizing'],
  fractional: false,
  commission: Object.freeze({ mode: 'percent', value: 0.05 }) as StrategySettings['commission'],
  slippagePct: 0,
  fillAt: 'nextOpen',
  stopLossPct: 0,
  takeProfitPct: 0,
});

export interface Strategy {
  schemaVersion: 1;
  id: string;
  name: string;
  longEntry: Rule;
  longExit: Rule;
  shortEntry: Rule;
  shortExit: Rule;
  settings: StrategySettings;
  /** ISO time of the last edit. */
  updatedAt: string;
}

// ---------------------------------------------------------------- engine

export interface BacktestBars {
  length: number;
  /** Unix seconds, bar open. */
  time: ArrayLike<number>;
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
}

/** Non-zero = the rule holds on that bar's close. */
export interface Signals {
  longEntry: ArrayLike<number>;
  longExit: ArrayLike<number>;
  shortEntry: ArrayLike<number>;
  shortExit: ArrayLike<number>;
}

export type Side = 'long' | 'short';
export type ExitReason = 'signal' | 'reverse' | 'stop' | 'target' | 'open';

export interface Trade {
  /** 1-based, in entry order. */
  n: number;
  side: Side;
  qty: number;
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  /** For an open trade: the last bar. */
  exitIndex: number;
  exitTime: number;
  /** For an open trade: the last close. */
  exitPrice: number;
  exitReason: ExitReason;
  /** Net of both commissions. */
  pnl: number;
  /** pnl / entry value * 100. */
  pnlPct: number;
  commission: number;
  /** exitIndex - entryIndex. */
  bars: number;
  /** Max adverse / favourable excursion while held, % of entry price (>= 0). */
  mae: number;
  mfe: number;
}

export interface BacktestStats {
  initialCapital: number;
  finalEquity: number;
  /** Closed trades. */
  netProfit: number;
  netProfitPct: number;
  /** Open trade at the last close. */
  openPnl: number;
  grossProfit: number;
  /** Positive number. */
  grossLoss: number;
  /** NaN without trades, Infinity without losses. */
  profitFactor: number;
  totalTrades: number;
  winners: number;
  losers: number;
  /** Percent; NaN without trades. */
  winRate: number;
  avgTrade: number;
  avgWin: number;
  avgLoss: number;
  /** avgWin / |avgLoss|. */
  payoffRatio: number;
  largestWin: number;
  largestLoss: number;
  avgBarsInTrade: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  commissionPaid: number;
  /** Equity peak to trough (positive numbers). */
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** Percent, first to last close. */
  buyHoldPct: number;
  /** Percent per year; NaN when the span is under a day. */
  cagrPct: number;
  /** Annualised from per-bar equity returns (risk-free 0). */
  sharpe: number;
  sortino: number;
  /** Percent of bars with a position. */
  exposurePct: number;
  longTrades: number;
  shortTrades: number;
}

export interface BacktestResult {
  trades: Trade[];
  openTrade: Trade | null;
  /** Mark-to-market equity at each bar's close. */
  equity: Float64Array;
  /** Percent below the running equity peak at each bar (<= 0). */
  drawdown: Float64Array;
  stats: BacktestStats;
}
