/**
 * Warm-up lengths (docs/alerts.md §2.7): how many bars of history must precede
 * the evaluated bar so recursive indicators match a long-history computation
 * (EMA/RMA seed error decays like (1 - 2/(L+1))^k, below 1e-8 after ~10·L bars).
 */
import { defaultRegistry, type IndicatorRegistry } from '@investopen/indicators';
import { isMovingOp } from './condition';
import type { AlertSpec, IndicatorRef, IndicatorRefInstance, ValueOperand } from './types';

/** `ALERTS_MAX_BARS` default. */
export const DEFAULT_MAX_BARS = 5000;
/** Minimum warm-up of any instance. */
export const MIN_WARMUP_BARS = 300;
/** Timeframe bars loaded before the chart's first bar for MTF instances (web controller `TF_WARMUP`). */
export const TIMEFRAME_WARMUP_BARS = 300;

const PARABOLIC_SAR_BARS = 500;
/** Indicators whose level depends on the start bar (no converging warm-up). */
const CUMULATIVE: ReadonlySet<string> = new Set(['obv']);
const VWAP_TYPES: ReadonlySet<string> = new Set(['vwap', 'vwap-bands']);

const DAY = 86_400;
/** Nominal (upper bound) length of a VWAP anchor period. */
const ANCHOR_SECONDS: Readonly<Record<string, number>> = {
  Session: DAY,
  Week: 7 * DAY,
  Month: 31 * DAY,
  Quarter: 92 * DAY,
  Year: 366 * DAY,
  Decade: 3653 * DAY,
  Century: 36_525 * DAY,
};

export interface WarmupOptions {
  /** `ALERTS_MAX_BARS` (default 5000): cumulative indicators load this many. */
  maxBars?: number;
  /** Interval of the alert's bars in seconds, for time-based warm-ups (VWAP); 0/absent = unknown. */
  intervalSeconds?: number;
  registry?: IndicatorRegistry;
}

function intInputsMax(inst: IndicatorRefInstance, registry: IndicatorRegistry): number {
  const def = registry.get(inst.type);
  let m = 1;
  if (!def) return m;
  for (const [key, d] of Object.entries(def.inputs)) {
    if (d.kind !== 'int') continue;
    const v = inst.inputs[key];
    const n = typeof v === 'number' && Number.isFinite(v) ? v : d.default;
    if (n > m) m = n;
  }
  return m;
}

function intInput(inst: IndicatorRefInstance, key: string, fallback: number): number {
  const v = inst.inputs[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Own warm-up of one instance, ignoring upstream instances. */
export function instanceWarmup(inst: IndicatorRefInstance, opts: WarmupOptions = {}): number {
  const registry = opts.registry ?? defaultRegistry;
  const maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
  const base = 10 * intInputsMax(inst, registry) + 50;
  let own: number;
  if (CUMULATIVE.has(inst.type)) own = maxBars;
  else if (inst.type === 'parabolic-sar') own = PARABOLIC_SAR_BARS;
  else if (inst.type === 'ichimoku') {
    const lengths = Math.max(
      intInput(inst, 'conversion', 9),
      intInput(inst, 'base', 26),
      intInput(inst, 'spanB', 52),
    );
    own = 10 * lengths + intInput(inst, 'displacement', 26);
  } else if (VWAP_TYPES.has(inst.type)) {
    // Since the start of the anchor period before the current one.
    const anchor = inst.inputs['anchor'];
    const period = ANCHOR_SECONDS[typeof anchor === 'string' ? anchor : 'Session'] ?? DAY;
    const iv = opts.intervalSeconds ?? 0;
    own = iv > 0 ? Math.max(base, Math.ceil((2 * period) / iv) + 1) : maxBars;
  } else own = base;
  // anchored-vwap loads by time (`warmupSince`); pivot-points' needs are timeframe bars.
  return Math.max(MIN_WARMUP_BARS, own);
}

/** Upstream instances referenced by an instance's source inputs (within the ref). */
function upstreamIds(inst: IndicatorRefInstance): string[] {
  const ids: string[] = [];
  for (const v of Object.values(inst.inputs)) {
    if (typeof v === 'object' && v !== null && typeof v.instanceId === 'string')
      ids.push(v.instanceId);
  }
  return ids;
}

/**
 * Warm-up of the ref's target instance: its own plus the largest warm-up among
 * its upstream instances, recursively (sources add up along a chain).
 * Throws on a cycle or an unknown upstream id.
 */
export function warmupBars(ref: IndicatorRef, opts: WarmupOptions = {}): number {
  const byId = new Map(ref.instances.map((i) => [i.id, i]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const walk = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const inst = byId.get(id);
    if (!inst) throw new Error(`unknown instance '${id}'`);
    if (visiting.has(id)) throw new Error(`indicator cycle at '${id}'`);
    visiting.add(id);
    let up = 0;
    for (const u of upstreamIds(inst)) up = Math.max(up, walk(u));
    visiting.delete(id);
    const w = instanceWarmup(inst, opts) + up;
    memo.set(id, w);
    return w;
  };
  return walk(ref.instanceId);
}

/** Earliest anchored-VWAP anchor time (unix s) among the ref's instances, or null (none or unset). */
export function warmupSince(ref: IndicatorRef): number | null {
  let min: number | null = null;
  for (const inst of ref.instances) {
    if (inst.type !== 'anchored-vwap') continue;
    const t = inst.inputs['anchor'];
    if (typeof t === 'number' && Number.isFinite(t) && t > 0)
      min = min === null ? t : Math.min(min, t);
  }
  return min;
}

/** Indicator refs used anywhere in a spec (left, right, channel bounds). */
export function specRefs(spec: AlertSpec): IndicatorRef[] {
  const refs: IndicatorRef[] = [];
  const add = (op: ValueOperand) => {
    if (op.kind === 'indicator') refs.push(op.ref);
  };
  add(spec.left);
  const c = spec.condition;
  if ('right' in c) add(c.right);
  if ('channel' in c && c.channel.kind === 'bounds') {
    add(c.channel.upper);
    add(c.channel.lower);
  }
  return refs;
}

/**
 * Bars one alert needs: the largest warm-up of its indicator refs, plus `bars`
 * for moving conditions, plus 2, capped at `maxBars`. The series window W is the
 * maximum over its alerts (further limited by the provider's history).
 */
export function alertBars(spec: AlertSpec, opts: WarmupOptions = {}): number {
  const maxBars = opts.maxBars ?? DEFAULT_MAX_BARS;
  let w = 0;
  for (const ref of specRefs(spec)) w = Math.max(w, warmupBars(ref, opts));
  const c = spec.condition;
  const moving = isMovingOp(c.op) && 'bars' in c ? c.bars : 0;
  return Math.min(maxBars, w + moving + 2);
}
