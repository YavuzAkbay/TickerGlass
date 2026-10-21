/**
 * Conditions (docs/alerts.md §2.3). Pure functions of the previous and current
 * sample values; all comparisons are plain IEEE doubles with no epsilon.
 */
import type {
  AlertSpec,
  ChannelOp,
  Condition,
  CrossOp,
  MovingOp,
  PriceField,
  SampleValues,
} from './types';
import { CHANNEL_OPS, CROSS_OPS, MOVING_OPS } from './types';

export type ConditionKind = 'edge' | 'state';

const EDGE_OPS: ReadonlySet<string> = new Set([
  'crossing',
  'crossingUp',
  'crossingDown',
  'enteringChannel',
  'exitingChannel',
]);

/** Edge conditions need a previous sample; state conditions look at the current one only. */
export function conditionKind(cond: Pick<Condition, 'op'>): ConditionKind {
  return EDGE_OPS.has(cond.op) ? 'edge' : 'state';
}

export function isCrossOp(op: string): op is CrossOp {
  return (CROSS_OPS as readonly string[]).includes(op);
}

export function isChannelOp(op: string): op is ChannelOp {
  return (CHANNEL_OPS as readonly string[]).includes(op);
}

export function isMovingOp(op: string): op is MovingOp {
  return (MOVING_OPS as readonly string[]).includes(op);
}

/** A value is valid iff it is a finite number (NaN, ±Infinity, null, undefined are not). */
export function isValid(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Price operand value of a bar (§2.1). */
export function priceValue(
  field: PriceField,
  bar: { open: number; high: number; low: number; close: number },
): number {
  const { open: o, high: h, low: l, close: c } = bar;
  switch (field) {
    case 'close':
      return c;
    case 'open':
      return o;
    case 'high':
      return h;
    case 'low':
      return l;
    case 'hl2':
      return (h + l) / 2;
    case 'hlc3':
      return (h + l + c) / 3;
    case 'ohlc4':
      return (o + h + l + c) / 4;
  }
}

/**
 * Channel `bounds` operand (§2.1): ordered so lower <= upper; both NaN if
 * either value is not finite.
 */
export function orderBounds(u: number, l: number): { upper: number; lower: number } {
  if (!isValid(u) || !isValid(l)) return { upper: NaN, lower: NaN };
  return { upper: Math.max(u, l), lower: Math.min(u, l) };
}

/** d = x - y, or null when either value is invalid. */
function diff(s: SampleValues): number | null {
  return isValid(s.x) && isValid(s.y) ? s.x - s.y : null;
}

/** `lower <= x <= upper` (inclusive), or null when a value is invalid. */
function inside(s: SampleValues): boolean | null {
  if (!isValid(s.x) || !isValid(s.upper) || !isValid(s.lower)) return null;
  return s.lower <= s.x && s.x <= s.upper;
}

function crossUp(p: SampleValues | null, c: SampleValues): boolean {
  if (!p) return false;
  const dp = diff(p);
  const dc = diff(c);
  return dp !== null && dc !== null && dp <= 0 && dc > 0;
}

function crossDown(p: SampleValues | null, c: SampleValues): boolean {
  if (!p) return false;
  const dp = diff(p);
  const dc = diff(c);
  return dp !== null && dc !== null && dp >= 0 && dc < 0;
}

/**
 * Whether `cond` holds for the current sample `cur` given the previous sample
 * `prev` of the alert's stream (null = none). A required value that is not
 * finite makes the condition false.
 */
export function evaluateCondition(
  cond: Condition,
  prev: SampleValues | null,
  cur: SampleValues,
): boolean {
  switch (cond.op) {
    case 'crossingUp':
      return crossUp(prev, cur);
    case 'crossingDown':
      return crossDown(prev, cur);
    case 'crossing':
      return crossUp(prev, cur) || crossDown(prev, cur);
    case 'greater':
      return isValid(cur.x) && isValid(cur.y) && cur.x > cur.y;
    case 'less':
      return isValid(cur.x) && isValid(cur.y) && cur.x < cur.y;
    case 'insideChannel':
      return inside(cur) === true;
    case 'outsideChannel':
      return inside(cur) === false;
    case 'enteringChannel': {
      if (!prev) return false;
      const a = inside(prev);
      const b = inside(cur);
      return a === false && b === true;
    }
    case 'exitingChannel': {
      if (!prev) return false;
      const a = inside(prev);
      const b = inside(cur);
      return a === true && b === false;
    }
    case 'movingUp':
    case 'movingDown':
    case 'movingUpPercent':
    case 'movingDownPercent':
      return moving(cond.op, cond.amount, cur);
  }
}

function moving(op: MovingOp, amount: number, c: SampleValues): boolean {
  if (!isValid(c.x) || !isValid(c.ref) || !isValid(amount)) return false;
  const x = c.x;
  const ref = c.ref;
  switch (op) {
    case 'movingUp':
      return x - ref >= amount;
    case 'movingDown':
      return ref - x >= amount;
    case 'movingUpPercent':
      return ref !== 0 && ((x - ref) / Math.abs(ref)) * 100 >= amount;
    case 'movingDownPercent':
      return ref !== 0 && ((ref - x) / Math.abs(ref)) * 100 >= amount;
  }
}

/**
 * "Price alert" (§1.2): a price left operand crossing / above / below a
 * constant. Only these get an alert line on the chart.
 */
export function isPriceAlert(spec: Pick<AlertSpec, 'left' | 'condition'>): boolean {
  const c = spec.condition;
  return spec.left.kind === 'price' && 'right' in c && c.right.kind === 'value';
}

/** Series key `symbol|interval|prepost` (§3.1); also `AlertRuntimeState.seriesKey`. */
export function seriesKey(symbol: string, interval: string, prepost: boolean): string {
  return `${symbol}|${interval}|${prepost ? 'prepost' : 'rth'}`;
}
