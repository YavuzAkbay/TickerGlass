/**
 * The chart brief sent with a question: the displayed bars, every study plot (offsets applied)
 * and the visible drawings of a chart, condensed by @tickerglass/ai-context.
 */
import {
  buildChartBrief,
  type BriefDrawing,
  type BriefFocus,
  type BriefStudy,
  type ChartBrief,
} from '@tickerglass/ai-context';
import type { Chart } from '@tickerglass/engine';
import { exportInputFromChart } from '../chart/exportData';

/** Tokens kept free for the system prompt, the conversation and the answer. */
const RESERVED_TOKENS = 2500;
/** Share of the rest of the context window the brief may use. */
const BRIEF_SHARE = 0.7;

/** Drawing tools that carry no chart meaning for the model. */
const SKIP_DRAWINGS = new Set(['image', 'icon', 'emoji', 'sticker']);

/** Token budget of the brief for a model context window of `numCtx` tokens. */
export function briefBudget(numCtx: number): number {
  return Math.max(800, Math.floor((numCtx - RESERVED_TOKENS) * BRIEF_SHARE));
}

/** `value` shifted by `offset` bars (plots with an offset draw value[i - offset] at bar i). */
function aligned(values: Float64Array, length: number, offset: number, n: number): Float64Array {
  const out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const src = i - offset;
    if (src >= 0 && src < length) out[i] = values[src]!;
  }
  return out;
}

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The visible range of `chart` as a focus, or null without bars. */
export function visibleFocus(chart: Chart): BriefFocus | null {
  const range = chart.getVisibleTimeRange();
  return range ? { kind: 'visible', from: range.from, to: range.to } : null;
}

export function briefFromChart(
  chart: Chart,
  focus: BriefFocus,
  maxTokens: number,
): ChartBrief | null {
  const input = exportInputFromChart(chart);
  if (!input) return null;
  const n = input.time.length;
  const studies: BriefStudy[] = input.studies.map((s) => ({
    title: s.title,
    outputs: s.plots.map((p) => ({
      name: p.title,
      values: aligned(s.values[p.id]!, s.length, p.offset, n),
    })),
  }));
  const drawings: BriefDrawing[] = chart
    .getDrawings()
    .filter((d) => !d.hidden && !SKIP_DRAWINGS.has(d.type) && d.points.length > 0)
    .map((d) => ({
      type: d.type,
      points: d.points.map((p) => ({ time: p.time, price: p.price })),
      ...(d.text ? { text: d.text } : {}),
    }));
  const info = chart.symbolInfo;
  const notes: string[] = [];
  if (chart.store !== chart.rawStore) {
    notes.push(`chart type ${chart.chartType}: the bars below are transformed, not traded prices`);
  }
  if (info?.currency) notes.push(`prices in ${info.currency}`);
  const tz = chart.timezone === 'local' ? localZone() : chart.timezone;
  return buildChartBrief(
    {
      symbol: chart.getSymbol(),
      ...(info?.name && info.name !== chart.getSymbol() ? { name: info.name } : {}),
      interval: chart.getInterval(),
      timezone: tz,
      ...(info?.priceHint !== undefined ? { pricePrecision: info.priceHint } : {}),
      bars: { length: n, ...input },
      studies,
      drawings,
      focus,
      notes,
    },
    { maxTokens },
  );
}
