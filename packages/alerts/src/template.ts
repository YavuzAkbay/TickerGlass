/**
 * Message templates (docs/alerts.md §4.3). `{{name}}` placeholders, no nesting
 * and no expressions; unknown placeholders and an unmatched `{{` stay literal.
 * The output is truncated to 2000 characters (with `…`).
 */
import { defaultRegistry, type IndicatorRegistry } from '@tickerglass/indicators';
import { isChannelOp, isMovingOp } from './condition';
import { describeCondition, type DescribeNames } from './describe';
import type { AlertIn, SampleValues, SeriesOperand, ValueOperand } from './types';

export const DEFAULT_TEMPLATE = '{{ticker}} {{condition}}';
export const MAX_MESSAGE_LENGTH = 2000;
/** Price decimals when the symbol's price hint is unknown. */
const DEFAULT_PRICE_HINT = 2;
/** Indicator values without a definition `precision`: this many decimals beyond the price hint. */
const INDICATOR_EXTRA_DECIMALS = 2;

export interface MessageContext {
  alert: Pick<AlertIn, 'name' | 'symbol' | 'interval' | 'spec'>;
  /** From `resolveSymbol`; null/absent fields render as '' (exchange, currency) or the default hint. */
  symbol?: { exchange?: string | null; currency?: string | null; priceHint?: number | null } | null;
  /** The firing sample: bar open time (unix s) and values. */
  barTime: number;
  values: SampleValues;
  /** Fire time, ms. */
  firedAt: number;
  /** Names for `{{condition}}` (drawing names); precision defaults to the price hint. */
  names?: DescribeNames;
  registry?: IndicatorRegistry;
}

/** ISO 8601 UTC without milliseconds: `2026-10-15T14:30:00Z`. */
export function isoSeconds(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fixed(v: number | undefined, decimals: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(decimals) : '';
}

function priceHintOf(ctx: MessageContext): number {
  const h = ctx.symbol?.priceHint;
  return typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 20 ? h : DEFAULT_PRICE_HINT;
}

/** Decimals of an operand's values: price hint for prices, definition precision for indicators. */
function operandDecimals(
  op: SeriesOperand | ValueOperand,
  priceHint: number,
  registry: IndicatorRegistry,
): number | null {
  if (op.kind !== 'indicator') return op.kind === 'price' ? priceHint : null;
  const inst = op.ref.instances.find((i) => i.id === op.ref.instanceId);
  const def = inst ? registry.get(inst.type) : undefined;
  if (def?.format === 'volume') return 0;
  return def?.precision ?? Math.min(20, priceHint + INDICATOR_EXTRA_DECIMALS);
}

/** Truncate to `max` code points, ending with `…` when cut. */
export function truncateMessage(s: string, max = MAX_MESSAGE_LENGTH): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`;
}

/** Render `template` ('' = DEFAULT_TEMPLATE) for a fire. */
export function renderMessage(template: string, ctx: MessageContext): string {
  const registry = ctx.registry ?? defaultRegistry;
  const hint = priceHintOf(ctx);
  const spec = ctx.alert.spec;
  const c = spec.condition;
  const v = ctx.values;
  const leftDec = operandDecimals(spec.left, hint, registry) ?? hint;
  const rightDec = 'right' in c ? (operandDecimals(c.right, hint, registry) ?? leftDec) : leftDec;

  let target = '';
  let upper = '';
  let lower = '';
  let change = '';
  if (isChannelOp(c.op)) {
    upper = fixed(v.upper, leftDec);
    lower = fixed(v.lower, leftDec);
    target = upper && lower ? `${lower}–${upper}` : '';
  } else if (isMovingOp(c.op) && 'amount' in c) {
    const pct = c.op === 'movingUpPercent' || c.op === 'movingDownPercent';
    target = pct ? `${fixed(c.amount, 2)}%` : fixed(c.amount, leftDec);
    if (Number.isFinite(v.x) && typeof v.ref === 'number' && Number.isFinite(v.ref)) {
      if (pct) change = v.ref !== 0 ? `${fixed(((v.x - v.ref) / Math.abs(v.ref)) * 100, 2)}%` : '';
      else change = fixed(v.x - v.ref, leftDec);
    }
  } else target = fixed(v.y, rightDec);

  const values: Record<string, () => string> = {
    ticker: () => ctx.alert.symbol,
    exchange: () => ctx.symbol?.exchange ?? '',
    currency: () => ctx.symbol?.currency ?? '',
    interval: () => ctx.alert.interval,
    open: () => fixed(v.open, hint),
    high: () => fixed(v.high, hint),
    low: () => fixed(v.low, hint),
    close: () => fixed(v.close, hint),
    price: () => fixed(v.close, hint),
    volume: () => fixed(v.volume, 0),
    value: () => fixed(v.x, leftDec),
    target: () => target,
    upper: () => upper,
    lower: () => lower,
    change: () => change,
    time: () => isoSeconds(ctx.barTime * 1000),
    timenow: () => isoSeconds(ctx.firedAt),
    name: () => ctx.alert.name,
    condition: () => describeCondition(ctx.alert, { precision: hint, ...ctx.names }),
  };
  const tpl = template === '' ? DEFAULT_TEMPLATE : template;
  const out = tpl.replace(/\{\{([A-Za-z]+)\}\}/g, (m, name: string) => {
    const f = Object.hasOwn(values, name) ? values[name] : undefined;
    return f ? f() : m;
  });
  return truncateMessage(out);
}
