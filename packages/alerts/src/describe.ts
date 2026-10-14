/**
 * Human-readable condition text (`describeCondition`, e.g. "Crossing Up 190.00",
 * "RSI 14 close Entering Channel") and `buildIndicatorRef` (the pure part of
 * the dialog's indicator operand).
 */
import {
  defaultRegistry,
  isOutputRef,
  resolveInputs,
  type AnyIndicatorDefinition,
  type IndicatorRegistry,
  type InputValueMap,
} from '@investopen/indicators';
import type {
  AlertIn,
  ConditionOp,
  IndicatorRef,
  IndicatorRefInstance,
  PriceField,
  ValueOperand,
} from './types';

export const OP_LABELS: Readonly<Record<ConditionOp, string>> = {
  crossing: 'Crossing',
  crossingUp: 'Crossing Up',
  crossingDown: 'Crossing Down',
  greater: 'Greater Than',
  less: 'Less Than',
  enteringChannel: 'Entering Channel',
  exitingChannel: 'Exiting Channel',
  insideChannel: 'Inside Channel',
  outsideChannel: 'Outside Channel',
  movingUp: 'Moving Up',
  movingDown: 'Moving Down',
  movingUpPercent: 'Moving Up %',
  movingDownPercent: 'Moving Down %',
};

export const PRICE_FIELD_LABELS: Readonly<Record<PriceField, string>> = {
  close: 'Close',
  open: 'Open',
  high: 'High',
  low: 'Low',
  hl2: 'HL2',
  hlc3: 'HLC3',
  ohlc4: 'OHLC4',
};

/** Names `describeCondition` cannot know on its own. */
export interface DescribeNames {
  /** Display name of a drawing operand, e.g. "Trend line" (default "Drawing"). */
  drawing?: (drawingId: string) => string | undefined;
  /** Decimals for constants and absolute moving amounts (default 2). */
  precision?: number;
}

function fmt(v: number, precision: number): string {
  return Number.isFinite(v) ? v.toFixed(precision) : String(v);
}

function operandText(op: ValueOperand, names: DescribeNames, precision: number): string {
  switch (op.kind) {
    case 'price':
      return PRICE_FIELD_LABELS[op.field];
    case 'indicator':
      return op.ref.title;
    case 'value':
      return fmt(op.value, precision);
    case 'drawing': {
      const name = names.drawing?.(op.drawingId) ?? 'Drawing';
      return op.part === 'line' ? name : `${name} ${op.part}`;
    }
  }
}

/**
 * Condition text. The left operand is omitted for `close` (the default) and
 * prefixed otherwise ("RSI 14 close Crossing 70.00", "High Greater Than 10.00").
 */
export function describeCondition(alert: Pick<AlertIn, 'spec'>, names: DescribeNames = {}): string {
  const precision = names.precision ?? 2;
  const { left, condition: c } = alert.spec;
  const parts: string[] = [];
  if (!(left.kind === 'price' && left.field === 'close'))
    parts.push(operandText(left, names, precision));
  parts.push(OP_LABELS[c.op]);
  if ('right' in c) parts.push(operandText(c.right, names, precision));
  else if ('channel' in c) {
    const ch = c.channel;
    if (ch.kind === 'bounds') {
      if (ch.upper.kind === 'value' && ch.lower.kind === 'value') {
        const hi = Math.max(ch.upper.value, ch.lower.value);
        const lo = Math.min(ch.upper.value, ch.lower.value);
        parts.push(`${fmt(lo, precision)}–${fmt(hi, precision)}`);
      } else
        parts.push(
          `${operandText(ch.lower, names, precision)} – ${operandText(ch.upper, names, precision)}`,
        );
    } else {
      const name = names.drawing?.(ch.drawingId);
      if (name) parts.push(name);
    }
  } else {
    const pct = c.op === 'movingUpPercent' || c.op === 'movingDownPercent';
    // "Moving Up % 5%" reads badly: the percent label already says it.
    parts[parts.length - 1] = pct ? OP_LABELS[c.op].replace(' %', '') : OP_LABELS[c.op];
    const amount = pct ? `${fmt(c.amount, 2).replace(/\.?0+$/, '')}%` : fmt(c.amount, precision);
    parts.push(`${amount} in ${c.bars} ${c.bars === 1 ? 'bar' : 'bars'}`);
  }
  return parts.join(' ');
}

/** Default alert name: symbol + condition ("AAPL Crossing 190.00"). */
export function defaultAlertName(
  alert: Pick<AlertIn, 'symbol' | 'spec'>,
  names: DescribeNames = {},
): string {
  return `${alert.symbol} ${describeCondition(alert, names)}`;
}

/** Legend-style inputs title ("14 close"), as `apps/web` `inputsTitle`. */
function inputsTitle(
  def: AnyIndicatorDefinition,
  inputs: InputValueMap,
  label: (id: string, outputId: string) => string,
): string {
  const parts: string[] = [];
  for (const [key, d] of Object.entries(def.inputs)) {
    if (d.hideInTitle) continue;
    const v = inputs[key];
    if (v === undefined) continue;
    switch (d.kind) {
      case 'int':
      case 'float':
        parts.push(String(v));
        break;
      case 'source':
        parts.push(isOutputRef(v) ? label(v.instanceId, v.outputId) : String(v));
        break;
      case 'enum':
        parts.push(d.optionLabels?.[v as string] ?? String(v));
        break;
      case 'timeframe':
        if (v) parts.push(v === 'auto' ? 'Auto' : String(v));
        break;
      case 'time':
        if (typeof v === 'number' && v > 0)
          parts.push(new Date(v * 1000).toISOString().slice(0, 16).replace('T', ' '));
        break;
      case 'bool':
      case 'color':
        break;
    }
  }
  return parts.join(' ');
}

/** A chart indicator instance as the dialog sees it (`InstanceSpec`-shaped). */
export interface ChartInstance {
  id: string;
  type: string;
  inputs?: InputValueMap;
}

/**
 * Indicator operand for output `outputId` of chart instance `instanceId`: the
 * closure of upstream instances with fully resolved inputs, and a legend-style
 * title ("RSI 14 close"; multi-plot indicators add the plot title, "BB 20 close 2 Upper").
 * Throws on a missing instance, an unknown type, a non-plot output or a cycle.
 */
export function buildIndicatorRef(
  instances: readonly ChartInstance[],
  instanceId: string,
  outputId: string,
  registry: IndicatorRegistry = defaultRegistry,
): IndicatorRef {
  const byId = new Map(instances.map((i) => [i.id, i]));
  const resolved = new Map<string, IndicatorRefInstance>();
  const visiting = new Set<string>();
  const defOf = (inst: ChartInstance): AnyIndicatorDefinition => {
    const def = registry.get(inst.type);
    if (!def) throw new Error(`unknown indicator '${inst.type}'`);
    return def;
  };
  const visit = (id: string): void => {
    if (resolved.has(id)) return;
    if (visiting.has(id)) throw new Error(`indicator cycle at '${id}'`);
    const inst = byId.get(id);
    if (!inst) throw new Error(`indicator instance '${id}' not found`);
    visiting.add(id);
    const inputs = resolveInputs(defOf(inst), inst.inputs ?? {});
    for (const v of Object.values(inputs)) if (isOutputRef(v)) visit(v.instanceId);
    visiting.delete(id);
    resolved.set(id, { id, type: inst.type, inputs });
  };
  visit(instanceId);
  const target = resolved.get(instanceId);
  if (!target) throw new Error(`indicator instance '${instanceId}' not found`);
  const def = defOf(target);
  const plots = def.outputs.filter((o) => o.type === 'plot');
  const out = plots.find((o) => o.id === outputId);
  if (!out) throw new Error(`'${outputId}' is not a plot of ${target.type}`);
  const label = (id: string, oid: string): string => {
    const up = resolved.get(id);
    const upDef = up ? registry.get(up.type) : undefined;
    if (!upDef) return 'removed source';
    const o = upDef.outputs.find((x) => x.id === oid);
    return `${upDef.shortName}: ${o?.title ?? oid}`;
  };
  const rest = inputsTitle(def, target.inputs, label);
  const study = rest ? `${def.shortName} ${rest}` : def.shortName;
  return {
    instances: [...resolved.values()],
    instanceId,
    outputId,
    title: plots.length > 1 ? `${study} ${out.title}` : study,
  };
}
