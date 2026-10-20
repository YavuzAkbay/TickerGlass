/**
 * What the alert dialog may offer as operands (docs/alerts.md §5.2): price
 * fields, indicator outputs of the chart, drawings that support the
 * condition. Pure: everything it reads from the chart comes in `AlertContext`
 * (built from the live stores by `./context`).
 */
import {
  buildIndicatorRef,
  CHANNEL_TOOLS,
  isChannelOp,
  isCrossOp,
  LINE_TOOLS,
  PRICE_FIELDS,
  PRICE_FIELD_LABELS,
  TOOL_POINTS,
  type AlertIn,
  type ChartInstance,
  type ConditionOp,
  type DrawingLineOperand,
  type DrawingPart,
  type DrawingScaleMode,
  type IndicatorRef,
  type SampleValues,
  type SeriesOperand,
  type ValueOperand,
} from '@investopen/alerts';
import { BRICK_TYPES, type ChartType } from '@investopen/engine';
import { defaultRegistry, isUserScriptType } from '@investopen/indicators';
import { toolName } from '../../drawings/model';

/** The fields of a stored drawing the dialog reads. */
export interface DrawingSummary {
  id: string;
  type: string;
  paneId: string;
  pointCount: number;
  scope: 'symbol' | 'all';
  symbol: string;
}

export interface LastBar {
  /** Unix s. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Chart state the dialog and the defaults depend on. */
export interface AlertContext {
  symbol: string;
  interval: string;
  prepost: boolean;
  chartType: ChartType | string;
  /** Price decimals of the chart symbol. */
  decimals: number;
  /** Indicators on the chart in legend order (any visibility). */
  indicators: readonly ChartInstance[];
  /** Engine pane of each indicator instance. */
  paneOf: (instanceId: string) => string | undefined;
  /** Last-bar value of an indicator output. */
  indicatorValue: (instanceId: string, outputId: string) => number | undefined;
  /** Drawings of the chart symbol (and synced ones). */
  drawings: readonly DrawingSummary[];
  /** Price-scale mode of a pane, snapshotted into drawing operands (percent/indexed -> linear). */
  scaleOf: (paneId: string) => DrawingScaleMode;
  /** Last price: of the chart symbol from its bars, of another symbol from the quote stream. */
  lastPrice: (symbol: string) => number | undefined;
  lastBar: LastBar | null;
}

export const isBrickType = (chartType: string): boolean => BRICK_TYPES.has(chartType as ChartType);

/** Drawing sources are disabled on brick chart types (§0). */
export const drawingsAllowed = (ctx: Pick<AlertContext, 'chartType'>): boolean =>
  !isBrickType(ctx.chartType);

/** Indicators exist on the chart symbol only. */
export const indicatorsAllowed = (ctx: Pick<AlertContext, 'symbol'>, symbol: string): boolean =>
  symbol === ctx.symbol;

/** Heikin Ashi: values use regular candles (§0). */
export const usesHeikinAshi = (ctx: Pick<AlertContext, 'chartType'>): boolean =>
  ctx.chartType === 'heikinAshi';

// ---------------------------------------------------------------- operands

export function operandKey(op: SeriesOperand | ValueOperand): string {
  switch (op.kind) {
    case 'price':
      return `price:${op.field}`;
    case 'indicator':
      return `ind:${op.ref.instanceId}:${op.ref.outputId}`;
    case 'drawing':
      return `drw:${op.drawingId}:${op.part}`;
    case 'value':
      return 'value';
  }
}

export interface SourceOption<T = SeriesOperand> {
  key: string;
  label: string;
  group: 'Price' | 'Indicators' | 'Drawings';
  operand: T;
}

/** Plot outputs of every indicator on the chart, titled like the legend. */
export function indicatorOptions(ctx: AlertContext): SourceOption<SeriesOperand>[] {
  const out: SourceOption<SeriesOperand>[] = [];
  for (const inst of ctx.indicators) {
    if (isUserScriptType(inst.type)) continue;
    const def = defaultRegistry.get(inst.type);
    if (!def) continue;
    for (const o of def.outputs) {
      if (o.type !== 'plot') continue;
      const ref = tryRef(ctx.indicators, inst.id, o.id);
      if (!ref) continue;
      const operand: SeriesOperand = { kind: 'indicator', ref };
      out.push({ key: operandKey(operand), label: ref.title, group: 'Indicators', operand });
    }
  }
  return out;
}

function tryRef(
  instances: readonly ChartInstance[],
  instanceId: string,
  outputId: string,
): IndicatorRef | null {
  try {
    return buildIndicatorRef(instances, instanceId, outputId);
  } catch {
    return null;
  }
}

export function indicatorOperand(
  ctx: AlertContext,
  instanceId: string,
  outputId: string,
): SeriesOperand | null {
  const ref = tryRef(ctx.indicators, instanceId, outputId);
  return ref ? { kind: 'indicator', ref } : null;
}

/** First plot output of a chart indicator. */
export function firstOutputId(type: string): string | null {
  if (isUserScriptType(type)) return null;
  return defaultRegistry.get(type)?.outputs.find((o) => o.type === 'plot')?.id ?? null;
}

export function priceOptions(): SourceOption<SeriesOperand>[] {
  return PRICE_FIELDS.map((field) => {
    const operand: SeriesOperand = { kind: 'price', field };
    return { key: operandKey(operand), label: PRICE_FIELD_LABELS[field], group: 'Price', operand };
  });
}

/** Pane the left operand lives in (price: the main pane). */
export function operandPane(ctx: AlertContext, op: SeriesOperand): string {
  return op.kind === 'price' ? 'main' : (ctx.paneOf(op.ref.instanceId) ?? 'main');
}

/**
 * Left operand choices. A stored operand (editing) that is no longer on the
 * chart stays selectable, so an edit does not silently change it.
 */
export function leftOptions(
  ctx: AlertContext,
  symbol: string,
  current?: SeriesOperand,
): SourceOption<SeriesOperand>[] {
  const list = [
    ...priceOptions(),
    ...(indicatorsAllowed(ctx, symbol) ? indicatorOptions(ctx) : []),
  ];
  if (current && !list.some((o) => o.key === operandKey(current)))
    list.push({
      key: operandKey(current),
      label: current.kind === 'indicator' ? current.ref.title : PRICE_FIELD_LABELS[current.field],
      group: current.kind === 'indicator' ? 'Indicators' : 'Price',
      operand: current,
    });
  return list;
}

// ---------------------------------------------------------------- drawings

const CHANNEL_PARTS: readonly DrawingPart[] = ['upper', 'lower', 'middle'];

/** Drawing the alert can reference at all: a supported tool with all anchors, matching the symbol. */
function usable(d: DrawingSummary, symbol: string): boolean {
  const need = TOOL_POINTS[d.type];
  if (need === undefined || d.pointCount < need) return false;
  if (!LINE_TOOLS.includes(d.type) && !CHANNEL_TOOLS.includes(d.type)) return false;
  return d.scope === 'all' || d.symbol === symbol;
}

/** "Trend line", or "Trend line 2" when there are several of a type. */
export function drawingName(ctx: Pick<AlertContext, 'drawings'>, drawingId: string): string {
  const d = ctx.drawings.find((x) => x.id === drawingId);
  if (!d) return 'Drawing';
  const same = ctx.drawings.filter((x) => x.type === d.type);
  const n = same.indexOf(d) + 1;
  return same.length > 1 ? `${toolName(d.type)} ${n}` : toolName(d.type);
}

export function drawingOperand(
  ctx: AlertContext,
  d: DrawingSummary,
  part: DrawingPart,
): DrawingLineOperand {
  return { kind: 'drawing', drawingId: d.id, part, scale: ctx.scaleOf(d.paneId) };
}

/**
 * Drawing choices as the right side of crossing/greater/less (line tools, and
 * channel parts) or as channel bounds. Only drawings in the left operand's
 * pane are offered (§2.6: a pane's drawing yields that pane's units).
 */
export function drawingTargets(
  ctx: AlertContext,
  symbol: string,
  left: SeriesOperand,
): SourceOption<DrawingLineOperand>[] {
  if (!drawingsAllowed(ctx)) return [];
  const pane = operandPane(ctx, left);
  const out: SourceOption<DrawingLineOperand>[] = [];
  for (const d of ctx.drawings) {
    if (!usable(d, symbol) || d.paneId !== pane) continue;
    const parts: readonly DrawingPart[] = LINE_TOOLS.includes(d.type) ? ['line'] : CHANNEL_PARTS;
    for (const part of parts) {
      const operand = drawingOperand(ctx, d, part);
      const name = drawingName(ctx, d.id);
      out.push({
        key: operandKey(operand),
        label: part === 'line' ? name : `${name} ${part}`,
        group: 'Drawings',
        operand,
      });
    }
  }
  return out;
}

/** Parallel channels and rectangles, to use as a whole channel. */
export function channelDrawings(
  ctx: AlertContext,
  symbol: string,
  left: SeriesOperand,
): { drawing: DrawingSummary; label: string; scale: DrawingScaleMode }[] {
  if (!drawingsAllowed(ctx)) return [];
  const pane = operandPane(ctx, left);
  return ctx.drawings
    .filter((d) => CHANNEL_TOOLS.includes(d.type) && usable(d, symbol) && d.paneId === pane)
    .map((d) => ({ drawing: d, label: drawingName(ctx, d.id), scale: ctx.scaleOf(d.paneId) }));
}

/** Right side of a cross condition: price fields, indicator outputs, drawing lines. */
export function targetOptions(
  ctx: AlertContext,
  symbol: string,
  left: SeriesOperand,
  current?: ValueOperand,
): SourceOption<SeriesOperand | DrawingLineOperand>[] {
  const list: SourceOption<SeriesOperand | DrawingLineOperand>[] = [
    ...priceOptions(),
    ...(indicatorsAllowed(ctx, symbol) ? indicatorOptions(ctx) : []),
    ...drawingTargets(ctx, symbol, left),
  ];
  if (current && current.kind !== 'value' && !list.some((o) => o.key === operandKey(current))) {
    const label =
      current.kind === 'indicator'
        ? current.ref.title
        : current.kind === 'price'
          ? PRICE_FIELD_LABELS[current.field]
          : drawingName(ctx, current.drawingId);
    list.push({
      key: operandKey(current),
      label,
      group: current.kind === 'drawing' ? 'Drawings' : 'Price',
      operand: current,
    });
  }
  return list;
}

/** Whether the op takes a drawing at all (the dialog hides the drawing group otherwise). */
export const opTakesDrawing = (op: ConditionOp): boolean => isCrossOp(op) || isChannelOp(op);

// ----------------------------------------------------------------- preview

function operandValue(ctx: AlertContext, op: ValueOperand | SeriesOperand): number {
  const bar = ctx.lastBar;
  switch (op.kind) {
    case 'value':
      return op.value;
    case 'indicator':
      return ctx.indicatorValue(op.ref.instanceId, op.ref.outputId) ?? NaN;
    case 'drawing':
      return NaN;
    case 'price': {
      if (!bar) return NaN;
      const { open, high, low, close } = bar;
      switch (op.field) {
        case 'hl2':
          return (high + low) / 2;
        case 'hlc3':
          return (high + low + close) / 3;
        case 'ohlc4':
          return (open + high + low + close) / 4;
        default:
          return bar[op.field];
      }
    }
  }
}

/** The chart's last bar as a firing sample, for the message preview. */
export function previewSample(
  alert: Pick<AlertIn, 'spec'>,
  ctx: AlertContext,
): { barTime: number; values: SampleValues } {
  const bar = ctx.lastBar;
  const c = alert.spec.condition;
  const values: SampleValues = {
    x: operandValue(ctx, alert.spec.left),
    open: bar?.open ?? NaN,
    high: bar?.high ?? NaN,
    low: bar?.low ?? NaN,
    close: bar?.close ?? NaN,
    volume: bar?.volume ?? 0,
  };
  if ('right' in c) values.y = operandValue(ctx, c.right);
  else if ('channel' in c && c.channel.kind === 'bounds') {
    values.upper = operandValue(ctx, c.channel.upper);
    values.lower = operandValue(ctx, c.channel.lower);
  }
  return { barTime: bar?.time ?? 0, values };
}
