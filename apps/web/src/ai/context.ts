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
import { intervalSeconds, parseInterval, type Chart } from '@tickerglass/engine';
import { exportInputFromChart } from '../chart/exportData';

/** Tokens kept free for the system prompt, the conversation and the answer. */
const RESERVED_TOKENS = 2500;
/** With chart tools: their definitions (~1.5K), results over several rounds and the model's
 * reasoning between them need room too (a full window cuts the answer off mid-sentence). */
const RESERVED_TOKENS_TOOLS = 7000;
/** The tool count `RESERVED_TOKENS_TOOLS` was sized for, and tokens per tool beyond it. */
const BASE_TOOL_COUNT = 13;
const TOKENS_PER_TOOL = 150;
/** Share of the rest of the context window the brief may use. */
const BRIEF_SHARE = 0.7;
/** With tools the brief never takes more than this share of the whole window. */
const BRIEF_MAX_SHARE_TOOLS = 0.35;

/** Drawing tools that carry no chart meaning for the model. */
const SKIP_DRAWINGS = new Set(['image', 'icon', 'emoji', 'sticker']);

/** Token budget of the brief for a model context window of `numCtx` tokens. */
export function briefBudget(numCtx: number, tools = false, toolCount = BASE_TOOL_COUNT): number {
  if (!tools) return Math.max(800, Math.floor((numCtx - RESERVED_TOKENS) * BRIEF_SHARE));
  const reserved =
    RESERVED_TOKENS_TOOLS + Math.max(0, toolCount - BASE_TOOL_COUNT) * TOKENS_PER_TOOL;
  return Math.max(
    800,
    Math.floor(Math.min((numCtx - reserved) * BRIEF_SHARE, numCtx * BRIEF_MAX_SHARE_TOOLS)),
  );
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

/** Whether the bar opened at `time` (unix seconds) has not finished yet at `now`. */
export function lastBarLive(interval: string, time: number, now: number): boolean {
  try {
    return time > 0 && now < time + intervalSeconds(parseInterval(interval));
  } catch {
    return false;
  }
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
  const live = lastBarLive(chart.getInterval(), n ? input.time[n - 1]! : 0, Date.now() / 1000);
  if (live)
    notes.push(
      'the last bar may still be in progress: its close is the latest price and its volume is partial, so do not compare that volume with full bars',
    );
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
