/**
 * Validation of stored strategies (the synced setting may come from another
 * version or an import). Invalid conditions are dropped; invalid settings
 * fall back to the defaults field by field.
 */
import { PRICE_FIELDS } from '@tickerglass/alerts';
import type {
  CommissionMode,
  ConstOperand,
  FillAt,
  IndicatorOperand,
  Operand,
  PriceField,
  Rule,
  RuleCondition,
  SizingMode,
  Strategy,
  StrategySettings,
} from './types';
import { COMPARE_OPS, DEFAULT_SETTINGS, MOVE_OPS, RULE_KEYS } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

export const MAX_STRATEGIES = 200;
export const MAX_CONDITIONS = 16;

export const emptyRule = (): Rule => ({ match: 'all', conditions: [] });

export function newStrategy(id: string, name: string, now = new Date()): Strategy {
  return {
    schemaVersion: 1,
    id,
    name,
    longEntry: emptyRule(),
    longExit: emptyRule(),
    shortEntry: emptyRule(),
    shortExit: emptyRule(),
    settings: structuredClone(DEFAULT_SETTINGS) as StrategySettings,
    updatedAt: now.toISOString(),
  };
}

function parseIndicator(v: Obj): IndicatorOperand | null {
  if (!isStr(v.instanceId) || !isStr(v.type) || !isStr(v.outputId)) return null;
  return {
    kind: 'indicator',
    instanceId: v.instanceId,
    type: v.type,
    inputs: isObj(v.inputs) ? v.inputs : {},
    outputId: v.outputId,
    title: typeof v.title === 'string' ? v.title.slice(0, 200) : v.type,
  };
}

function parseOperand(v: unknown): Operand | null {
  if (!isObj(v)) return null;
  if (v.kind === 'price')
    return (PRICE_FIELDS as readonly unknown[]).includes(v.field)
      ? { kind: 'price', field: v.field as PriceField }
      : null;
  if (v.kind === 'indicator') return parseIndicator(v);
  return null;
}

function parseCondition(v: unknown): RuleCondition | null {
  if (!isObj(v)) return null;
  if (v.kind === 'signal') {
    const left = isObj(v.left) && v.left.kind === 'indicator' ? parseIndicator(v.left) : null;
    return left ? { kind: 'signal', left } : null;
  }
  const left = parseOperand(v.left);
  if (!left) return null;
  if (v.kind === 'compare') {
    if (!(COMPARE_OPS as readonly unknown[]).includes(v.op)) return null;
    const right: Operand | ConstOperand | null =
      isObj(v.right) && v.right.kind === 'value'
        ? isNum(v.right.value)
          ? { kind: 'value', value: v.right.value }
          : null
        : parseOperand(v.right);
    return right
      ? { kind: 'compare', left, op: v.op as (typeof COMPARE_OPS)[number], right }
      : null;
  }
  if (v.kind === 'moving') {
    if (!(MOVE_OPS as readonly unknown[]).includes(v.op) || !isNum(v.amount) || !isNum(v.bars))
      return null;
    return {
      kind: 'moving',
      left,
      op: v.op as (typeof MOVE_OPS)[number],
      amount: v.amount,
      bars: Math.max(1, Math.min(5000, Math.floor(v.bars))),
    };
  }
  return null;
}

function parseRule(v: unknown): Rule {
  if (!isObj(v)) return emptyRule();
  const list = Array.isArray(v.conditions) ? v.conditions : [];
  return {
    match: v.match === 'any' ? 'any' : 'all',
    conditions: list
      .slice(0, MAX_CONDITIONS)
      .map(parseCondition)
      .filter((c): c is RuleCondition => c !== null),
  };
}

const SIZING: readonly SizingMode[] = ['percentEquity', 'fixedQty', 'fixedCash'];
const COMMISSION: readonly CommissionMode[] = ['percent', 'perOrder', 'perShare'];
const FILLS: readonly FillAt[] = ['nextOpen', 'close'];

const nonNeg = (v: unknown, d: number, max = Number.MAX_SAFE_INTEGER) =>
  isNum(v) && v >= 0 && v <= max ? v : d;

export function parseSettings(v: unknown): StrategySettings {
  const d = DEFAULT_SETTINGS;
  const o = isObj(v) ? v : {};
  const sz = isObj(o.sizing) ? o.sizing : {};
  const cm = isObj(o.commission) ? o.commission : {};
  const capital =
    isNum(o.initialCapital) && o.initialCapital > 0 ? o.initialCapital : d.initialCapital;
  return {
    initialCapital: capital,
    sizing: {
      mode: (SIZING as readonly unknown[]).includes(sz.mode)
        ? (sz.mode as SizingMode)
        : d.sizing.mode,
      value: isNum(sz.value) && sz.value > 0 ? sz.value : d.sizing.value,
    },
    fractional: typeof o.fractional === 'boolean' ? o.fractional : d.fractional,
    commission: {
      mode: (COMMISSION as readonly unknown[]).includes(cm.mode)
        ? (cm.mode as CommissionMode)
        : d.commission.mode,
      value: nonNeg(cm.value, d.commission.value),
    },
    slippagePct: nonNeg(o.slippagePct, d.slippagePct, 50),
    fillAt: (FILLS as readonly unknown[]).includes(o.fillAt) ? (o.fillAt as FillAt) : d.fillAt,
    stopLossPct: nonNeg(o.stopLossPct, d.stopLossPct, 99),
    takeProfitPct: nonNeg(o.takeProfitPct, d.takeProfitPct, 10_000),
  };
}

export function parseStrategy(v: unknown): Strategy | null {
  if (!isObj(v) || !isStr(v.id, 64) || !isStr(v.name, 200)) return null;
  const s = newStrategy(v.id, v.name);
  for (const k of RULE_KEYS) s[k] = parseRule(v[k]);
  s.settings = parseSettings(v.settings);
  if (typeof v.updatedAt === 'string' && !Number.isNaN(Date.parse(v.updatedAt)))
    s.updatedAt = v.updatedAt;
  return s;
}

export function parseStrategies(v: unknown): Strategy[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Strategy[] = [];
  for (const raw of v.slice(0, MAX_STRATEGIES)) {
    const s = parseStrategy(raw);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  return out;
}
