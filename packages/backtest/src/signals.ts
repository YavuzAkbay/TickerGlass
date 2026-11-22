/**
 * Rules -> per-bar signals. Each condition samples its operands at bar i
 * (and i - 1 for crossings) and reuses the alert condition semantics
 * (`evaluateCondition`), so "crossing up" means the same here as in an alert.
 */
import { evaluateCondition, priceValue, type SampleValues } from '@tickerglass/alerts';
import type {
  BacktestBars,
  IndicatorOperand,
  Operand,
  Rule,
  RuleCondition,
  RuleKey,
  Signals,
  Strategy,
} from './types';
import { RULE_KEYS } from './types';

/** Values of an indicator operand aligned to the bars, or null when it is not available. */
export type IndicatorResolver = (op: IndicatorOperand) => ArrayLike<number> | null;

const NO_OHLC = { open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN };

function priceSeries(bars: BacktestBars, field: Operand & { kind: 'price' }): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++)
    out[i] = priceValue(field.field, {
      open: bars.open[i]!,
      high: bars.high[i]!,
      low: bars.low[i]!,
      close: bars.close[i]!,
    });
  return out;
}

export interface SignalBuild {
  signals: Signals;
  /** Indicator operands the resolver could not provide (their conditions never hold). */
  missing: IndicatorOperand[];
}

function operandKey(op: IndicatorOperand): string {
  return `${op.instanceId}|${op.type}|${op.outputId}`;
}

/** Evaluate every rule of `strategy` on `bars`. */
export function buildSignals(
  strategy: Pick<Strategy, RuleKey>,
  bars: BacktestBars,
  resolve: IndicatorResolver,
): SignalBuild {
  const n = bars.length;
  const prices = new Map<string, Float64Array>();
  const indicators = new Map<string, ArrayLike<number> | null>();
  const missing = new Map<string, IndicatorOperand>();

  const series = (op: Operand): ArrayLike<number> | null => {
    if (op.kind === 'price') {
      let s = prices.get(op.field);
      if (!s) prices.set(op.field, (s = priceSeries(bars, op)));
      return s;
    }
    const key = operandKey(op);
    if (!indicators.has(key)) {
      const s = resolve(op);
      indicators.set(key, s);
      if (!s) missing.set(key, op);
    }
    return indicators.get(key) ?? null;
  };

  const at = (s: ArrayLike<number>, i: number): number =>
    i >= 0 && i < s.length ? (s[i] ?? NaN) : NaN;

  const evalCondition = (c: RuleCondition): Uint8Array => {
    const out = new Uint8Array(n);
    const x = series(c.left);
    if (!x) return out;
    switch (c.kind) {
      case 'signal':
        for (let i = 0; i < n; i++) out[i] = Number.isFinite(at(x, i)) ? 1 : 0;
        return out;
      case 'compare': {
        const right = c.right;
        const y = right.kind === 'value' ? null : series(right);
        if (right.kind !== 'value' && !y) return out;
        const cond = { op: c.op, right: { kind: 'value' as const, value: 0 } };
        const sample = (i: number): SampleValues => ({
          ...NO_OHLC,
          x: at(x, i),
          y: y ? at(y, i) : right.kind === 'value' ? right.value : NaN,
        });
        let prev: SampleValues | null = null;
        for (let i = 0; i < n; i++) {
          const cur = sample(i);
          out[i] = evaluateCondition(cond, prev, cur) ? 1 : 0;
          prev = cur;
        }
        return out;
      }
      case 'moving': {
        const bars = Math.max(1, Math.floor(c.bars));
        const cond = { op: c.op, amount: c.amount, bars };
        for (let i = 0; i < n; i++)
          out[i] = evaluateCondition(cond, null, { ...NO_OHLC, x: at(x, i), ref: at(x, i - bars) })
            ? 1
            : 0;
        return out;
      }
    }
  };

  const evalRule = (rule: Rule): Uint8Array => {
    const out = new Uint8Array(n);
    if (!rule.conditions.length) return out;
    const parts = rule.conditions.map(evalCondition);
    const all = rule.match === 'all';
    for (let i = 0; i < n; i++) {
      let v = all;
      for (const p of parts) {
        if (all && !p[i]) {
          v = false;
          break;
        }
        if (!all && p[i]) {
          v = true;
          break;
        }
      }
      out[i] = v ? 1 : 0;
    }
    return out;
  };

  const signals = {} as Record<RuleKey, Uint8Array>;
  for (const k of RULE_KEYS) signals[k] = evalRule(strategy[k]);
  return { signals, missing: [...missing.values()] };
}

/** Every indicator operand a strategy uses (for "add missing indicators"). */
export function strategyOperands(strategy: Pick<Strategy, RuleKey>): IndicatorOperand[] {
  const seen = new Map<string, IndicatorOperand>();
  const add = (op: Operand | { kind: 'value' }) => {
    if (op.kind === 'indicator') seen.set(operandKey(op), op);
  };
  for (const k of RULE_KEYS)
    for (const c of strategy[k].conditions) {
      add(c.left);
      if (c.kind === 'compare') add(c.right);
    }
  return [...seen.values()];
}
