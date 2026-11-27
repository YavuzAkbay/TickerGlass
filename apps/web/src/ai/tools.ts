/**
 * Chart tools the model can call (Ollama function calling, docs/design/local-ai.md §7): add or
 * remove indicators, find swings and divergences exactly, and draw lines. They run in the browser
 * on the chart the question is about; every change goes through the undoable store actions.
 */
import {
  findDivergences,
  findSwings,
  isIntraday,
  rangeIndexes,
  timeFormatter,
  type BriefFocus,
  type Divergence,
} from '@tickerglass/ai-context';
import type { Chart, DrawingInput, DrawingStyle } from '@tickerglass/engine';
import { bindToChart } from '../drawings/attach';
import { commit, findDrawing } from '../drawings/actions';
import { addIndicator, findIndicator, removeIndicators } from '../indicators/actions';
import { useIndicatorStore } from '../indicators/store';
import { runInSession } from '../store/chart';

/** Ollama function schema. */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What one tool did: the JSON the model reads and a line for the user. */
export interface ToolResult {
  content: string;
  summary: string;
  ok: boolean;
}

/** Indicators and drawings the AI added while answering one question (for Undo). */
export interface AiChanges {
  indicators: string[];
  drawings: string[];
}

export interface ToolContext {
  chartId: string;
  chart: Chart;
  focus: BriefFocus;
  changes: AiChanges;
}

const OSCILLATORS: Record<string, { output: string; inputs?: Record<string, number> }> = {
  rsi: { output: 'rsi' },
  macd: { output: 'macd' },
  stochastic: { output: 'k' },
  cci: { output: 'cci' },
  mfi: { output: 'mf' },
  obv: { output: 'obv' },
};
const ADDABLE = [
  'rsi',
  'macd',
  'stochastic',
  'cci',
  'mfi',
  'obv',
  'sma',
  'ema',
  'bollinger',
  'atr',
  'volume',
];
const TONE = { bullish: '#34C38F', bearish: '#F2626B', neutral: '#9AA8FF' } as const;
type Tone = keyof typeof TONE;
const MAX_RESULT_CHARS = 4000;
const STUDY_WAIT_MS = 4000;

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(str(v).trim()));
const toneOf = (v: unknown): Tone => (str(v) in TONE ? (str(v) as Tone) : 'neutral');

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'list_indicators',
      description: 'List the indicators on the chart with their ids, panes and latest values.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_indicator',
      description:
        'Add an indicator to the chart (reuses an identical one already there). Returns its id and recent values.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ADDABLE },
          length: { type: 'number', description: 'Period, e.g. 14 for RSI, 20 for Bollinger' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_indicator',
      description: 'Remove an indicator by its id (from list_indicators or add_indicator).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_swings',
      description:
        'Find confirmed swing highs and lows (pivots) in the focus range, of price or of an indicator.',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            description: '"price" or an indicator id from list_indicators / add_indicator',
          },
          kind: { type: 'string', enum: ['high', 'low', 'both'] },
          strength: { type: 'number', description: 'Bars on each side, default 3' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_divergences',
      description:
        'Find regular and hidden, bullish and bearish divergences between price and an oscillator in the focus range. Adds the oscillator if it is not on the chart. Returns ids for draw_divergence.',
      parameters: {
        type: 'object',
        properties: {
          oscillator: { type: 'string', enum: Object.keys(OSCILLATORS) },
          kinds: { type: 'string', enum: ['regular', 'hidden', 'both'] },
        },
        required: ['oscillator'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw_divergence',
      description:
        'Draw one divergence found by find_divergences: a line between the two price swings and one between the two oscillator values, labelled.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'e.g. "d1"' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw_trend_line',
      description:
        'Draw a straight line between two points on the price pane or an indicator pane.',
      parameters: {
        type: 'object',
        properties: {
          pane: { type: 'string', description: '"price" or an indicator id' },
          from_time: { type: 'string', description: 'Date as in CHART CONTEXT, e.g. "2026-08-03"' },
          from_value: { type: 'number' },
          to_time: { type: 'string' },
          to_value: { type: 'number' },
          label: {
            type: 'string',
            description: 'Optional, at most 3 words; usually leave empty',
          },
          tone: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        },
        required: ['from_time', 'from_value', 'to_time', 'to_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw_horizontal_line',
      description: 'Draw a horizontal line at a price, e.g. support or resistance.',
      parameters: {
        type: 'object',
        properties: {
          price: { type: 'number' },
          label: { type: 'string', description: 'Optional, e.g. "Support" or "R1"' },
          tone: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        },
        required: ['price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_ai_drawings',
      description: 'Remove the lines you drew earlier in this conversation.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ------------------------------------------------------------ helpers

/** Divergences found per chart, by id, for draw_divergence. */
const divergences = new Map<
  string,
  Map<string, Divergence & { studyId: string; studyTitle: string }>
>();
/** Drawings the AI made per chart (clear_ai_drawings). */
const aiDrawings = new Map<string, Set<string>>();

function fmtTime(chart: Chart): (t: number) => string {
  const tz =
    chart.timezone === 'local'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      : chart.timezone;
  return timeFormatter(tz, isIntraday(chart.store.time.subarray(0, chart.store.length)));
}

const round = (v: number): number => Number(v.toPrecision(6));

/** Bar time for a model-supplied time: a date / date-time as in the brief, or unix seconds. */
export function parseBarTime(chart: Chart, raw: unknown): number | null {
  const store = chart.store;
  if (!store.length) return null;
  const text = str(raw).trim();
  if (!text) return null;
  const fmt = fmtTime(chart);
  // Exact match against the brief's own formatting (date, or date + time intraday).
  for (let i = 0; i < store.length; i++) {
    const s = fmt(store.time[i]!);
    if (s === text || s.startsWith(`${text} `)) return store.time[i]!;
  }
  let t = /^\d{9,11}$/.test(text) ? Number(text) : Date.parse(text.replace(' ', 'T') + 'Z') / 1000;
  if (!Number.isFinite(t)) return null;
  // Nearest bar.
  let lo = 0;
  let hi = store.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (store.time[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(store.time[lo - 1]! - t) < Math.abs(store.time[lo]! - t)) lo--;
  t = store.time[lo]!;
  return t;
}

function studyInfo(chart: Chart, id: string): { paneId: string; title: string } | null {
  const s = chart.getStudies().find((x) => x.id === id);
  return s ? { paneId: s.paneId, title: s.title } : null;
}

async function waitForStudy(chart: Chart, id: string): Promise<boolean> {
  const until = Date.now() + STUDY_WAIT_MS;
  while (Date.now() < until) {
    const data = chart.getStudyData(id);
    if (data?.current && data.length > 0) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function lastValues(chart: Chart, id: string): Record<string, number | null> {
  const data = chart.getStudyData(id);
  const out: Record<string, number | null> = {};
  if (!data) return out;
  for (const [k, arr] of Object.entries(data.values)) {
    let v = NaN;
    for (let i = data.length - 1; i >= 0 && !Number.isFinite(v); i--) v = arr[i]!;
    if (Number.isFinite(v)) out[k] = round(v);
  }
  return out;
}

function sameInputs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return Object.keys(b).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** An instance of `type` (with `inputs`) on the chart, added when missing. */
async function ensureIndicator(
  ctx: ToolContext,
  type: string,
  inputs: Record<string, number>,
): Promise<{ id: string; added: boolean } | null> {
  return runInSession(ctx.chartId, async () => {
    const existing = useIndicatorStore
      .getState()
      .instances.find((i) => i.type === type && sameInputs(i.inputs, inputs));
    let id = existing?.id ?? null;
    let added = false;
    if (!id) {
      id = addIndicator(type, { inputs });
      if (!id) return null;
      added = true;
      ctx.changes.indicators.push(id);
    }
    await waitForStudy(ctx.chart, id);
    return { id, added };
  });
}

function focusIndexes(ctx: ToolContext): [number, number] | null {
  const s = ctx.chart.store;
  return rangeIndexes(
    {
      length: s.length,
      time: s.time,
      open: s.open,
      high: s.high,
      low: s.low,
      close: s.close,
      volume: s.volume,
    },
    ctx.focus.from,
    ctx.focus.to,
  );
}

function addDrawings(ctx: ToolContext, inputs: DrawingInput[], label: string): string[] {
  const { chart, chartId } = ctx;
  const made = inputs.map((input) => {
    // The engine fills in the defaults (id, style, symbol); the store then owns the drawing.
    const d = chart.addDrawing(input);
    chart.removeDrawings([d.id]);
    return bindToChart(d, chartId);
  });
  runInSession(chartId, () =>
    commit(
      label,
      made.map((d) => ({ before: null, after: d })),
    ),
  );
  const ids = made.map((d) => d.id);
  ctx.changes.drawings.push(...ids);
  const set = aiDrawings.get(chartId) ?? new Set<string>();
  ids.forEach((id) => set.add(id));
  aiDrawings.set(chartId, set);
  return ids;
}

function lineStyle(tone: Tone): DrawingStyle {
  return { lineColor: TONE[tone], lineWidth: 2, textColor: TONE[tone] };
}

function paneFor(ctx: ToolContext, pane: unknown): { paneId: string; name: string } | null {
  const p = str(pane, 'price');
  if (!p || p === 'price' || p === 'main') return { paneId: 'main', name: 'price' };
  const info = studyInfo(ctx.chart, p);
  return info ? { paneId: info.paneId, name: info.title } : null;
}

function result(data: unknown, summary: string, ok = true): ToolResult {
  let content = JSON.stringify(data);
  if (content.length > MAX_RESULT_CHARS) content = `${content.slice(0, MAX_RESULT_CHARS)}…`;
  return { content, summary, ok };
}

const fail = (message: string, summary = message): ToolResult =>
  result({ error: message }, summary, false);

// ------------------------------------------------------------ tools

async function addIndicatorTool(ctx: ToolContext, args: Record<string, unknown>) {
  const type = str(args.type).toLowerCase();
  if (!ADDABLE.includes(type))
    return fail(`unknown indicator "${type}"; use one of ${ADDABLE.join(', ')}`);
  const length = num(args.length);
  const inputs = Number.isFinite(length) && length > 0 ? { length: Math.round(length) } : {};
  // MACD, Stochastic, OBV and Volume have no plain `length` input.
  const takesLength = !['macd', 'stochastic', 'obv', 'volume'].includes(type);
  const got = await ensureIndicator(ctx, type, takesLength ? inputs : {});
  if (!got) return fail(`could not add ${type}`);
  const info = studyInfo(ctx.chart, got.id);
  const title = info?.title ?? type;
  return result(
    {
      id: got.id,
      title,
      pane: info?.paneId === 'main' ? 'price' : got.id,
      alreadyOnChart: !got.added,
      latest: lastValues(ctx.chart, got.id),
    },
    got.added ? `Added ${title}` : `${title} already on the chart`,
  );
}

function listIndicatorsTool(ctx: ToolContext) {
  const list = ctx.chart
    .getStudies()
    .filter((s) => s.visible !== false)
    .map((s) => ({
      id: s.id,
      title: s.title,
      pane: s.paneId === 'main' ? 'price' : s.id,
      latest: lastValues(ctx.chart, s.id),
    }));
  return result(
    { indicators: list },
    `Read ${list.length} indicator${list.length === 1 ? '' : 's'}`,
  );
}

function removeIndicatorTool(ctx: ToolContext, args: Record<string, unknown>) {
  const id = str(args.id);
  const ok = runInSession(ctx.chartId, () => {
    const inst = findIndicator(id);
    if (!inst) return false;
    removeIndicators([id]);
    return true;
  });
  return ok ? result({ removed: id }, `Removed ${id}`) : fail(`no indicator with id "${id}"`);
}

function findSwingsTool(ctx: ToolContext, args: Record<string, unknown>) {
  const range = focusIndexes(ctx);
  if (!range) return fail('no bars in the focus range');
  const [from, to] = range;
  const source = str(args.source, 'price');
  const kind = str(args.kind, 'both');
  const strength = Number.isFinite(num(args.strength)) ? num(args.strength) : 3;
  const s = ctx.chart.store;
  const fmt = fmtTime(ctx.chart);
  let highs: ArrayLike<number> = s.high;
  let lows: ArrayLike<number> = s.low;
  let name = 'price';
  if (source !== 'price') {
    const data = ctx.chart.getStudyData(source);
    const first = data && Object.values(data.values)[0];
    if (!data || !first) return fail(`no indicator with id "${source}"`);
    highs = lows = first.subarray(0, data.length);
    name = studyInfo(ctx.chart, source)?.title ?? source;
  }
  const pick = (vals: ArrayLike<number>, k: 'high' | 'low') =>
    findSwings(vals, k, { strength, from, to })
      .slice(-12)
      .map((p) => ({ time: fmt(s.time[p.index]!), value: round(p.value) }));
  const data = {
    source: name,
    ...(kind !== 'low' ? { highs: pick(highs, 'high') } : {}),
    ...(kind !== 'high' ? { lows: pick(lows, 'low') } : {}),
  };
  const n = (data.highs?.length ?? 0) + (data.lows?.length ?? 0);
  return result(data, `Found ${n} swing${n === 1 ? '' : 's'} on ${name}`);
}

async function findDivergencesTool(ctx: ToolContext, args: Record<string, unknown>) {
  const osc = str(args.oscillator, 'rsi').toLowerCase();
  const spec = OSCILLATORS[osc];
  if (!spec) return fail(`unsupported oscillator "${osc}"`);
  const got = await ensureIndicator(ctx, osc, spec.inputs ?? {});
  if (!got) return fail(`could not add ${osc}`);
  const data = ctx.chart.getStudyData(got.id);
  const values = data?.values[spec.output];
  if (!data || !values) return fail(`${osc} has no values yet`);
  const range = focusIndexes(ctx);
  if (!range) return fail('no bars in the focus range');
  const s = ctx.chart.store;
  const kinds = str(args.kinds, 'both');
  const found = findDivergences(
    {
      length: s.length,
      time: s.time,
      open: s.open,
      high: s.high,
      low: s.low,
      close: s.close,
      volume: s.volume,
    },
    values.subarray(0, data.length),
    {
      from: range[0],
      to: range[1],
      kinds:
        kinds === 'regular' ? ['regular'] : kinds === 'hidden' ? ['hidden'] : ['regular', 'hidden'],
    },
  );
  const title = studyInfo(ctx.chart, got.id)?.title ?? osc.toUpperCase();
  divergences.set(
    ctx.chartId,
    new Map(found.map((d) => [d.id, { ...d, studyId: got.id, studyTitle: title }])),
  );
  const fmt = fmtTime(ctx.chart);
  return result(
    {
      oscillator: { id: got.id, title, addedNow: got.added },
      divergences: found.map((d) => ({
        id: d.id,
        type: `${d.kind} ${d.direction}`,
        price: d.price.map((p) => ({ time: fmt(p.time), price: round(p.value) })),
        [osc]: d.oscillator.map((p) => ({ time: fmt(p.time), value: round(p.value) })),
        bars: d.bars,
      })),
    },
    `${got.added ? `Added ${title} · ` : ''}Found ${found.length} divergence${found.length === 1 ? '' : 's'} (${title})`,
  );
}

function drawDivergenceTool(ctx: ToolContext, args: Record<string, unknown>) {
  const d = divergences.get(ctx.chartId)?.get(str(args.id));
  if (!d) return fail(`unknown divergence id "${str(args.id)}"; call find_divergences first`);
  const pane = studyInfo(ctx.chart, d.studyId);
  if (!pane) return fail(`${d.studyTitle} is no longer on the chart`);
  const tone: Tone = d.direction;
  const name = `${d.kind === 'hidden' ? 'Hidden ' : ''}${d.direction} divergence`;
  const label = name.charAt(0).toUpperCase() + name.slice(1);
  addDrawings(
    ctx,
    [
      {
        type: 'trend-line',
        paneId: 'main',
        points: d.price.map((p) => ({ time: p.time, price: p.value })),
        // No text on the chart: the colour says bullish/bearish; the answer explains.
        style: lineStyle(tone),
      },
      {
        type: 'trend-line',
        paneId: pane.paneId,
        points: d.oscillator.map((p) => ({ time: p.time, price: p.value })),
        style: lineStyle(tone),
      },
    ],
    `AI: ${label}`,
  );
  return result(
    { drawn: d.id },
    `Drew ${label.toLowerCase()} ${d.id} on price and ${d.studyTitle}`,
  );
}

function drawTrendLineTool(ctx: ToolContext, args: Record<string, unknown>) {
  const pane = paneFor(ctx, args.pane);
  if (!pane) return fail(`no indicator pane "${str(args.pane)}"`);
  const t1 = parseBarTime(ctx.chart, args.from_time);
  const t2 = parseBarTime(ctx.chart, args.to_time);
  const v1 = num(args.from_value);
  const v2 = num(args.to_value);
  if (t1 === null || t2 === null || !Number.isFinite(v1) || !Number.isFinite(v2))
    return fail('need from_time, from_value, to_time and to_value');
  const tone = toneOf(args.tone);
  addDrawings(
    ctx,
    [
      {
        type: 'trend-line',
        paneId: pane.paneId,
        points: [
          { time: t1, price: v1 },
          { time: t2, price: v2 },
        ],
        style: lineStyle(tone),
        text: str(args.label).slice(0, 24),
      },
    ],
    'AI: Trend line',
  );
  return result({ drawn: 'trend line', pane: pane.name }, `Drew a trend line on ${pane.name}`);
}

function drawHorizontalTool(ctx: ToolContext, args: Record<string, unknown>) {
  const price = num(args.price);
  if (!Number.isFinite(price)) return fail('need a price');
  const s = ctx.chart.store;
  const tone = toneOf(args.tone);
  addDrawings(
    ctx,
    [
      {
        type: 'horizontal-line',
        paneId: 'main',
        points: [{ time: s.time[Math.max(0, s.length - 1)]!, price }],
        style: lineStyle(tone),
        text: str(args.label).slice(0, 24),
      },
    ],
    'AI: Horizontal line',
  );
  return result({ drawn: 'horizontal line', price }, `Drew a line at ${round(price)}`);
}

function clearTool(ctx: ToolContext) {
  const ids = [...(aiDrawings.get(ctx.chartId) ?? [])];
  removeAiDrawings(ctx.chartId, ids);
  return result(
    { removed: ids.length },
    `Removed ${ids.length} AI drawing${ids.length === 1 ? '' : 's'}`,
  );
}

/** Remove drawings by id from the store (one undo step). */
export function removeAiDrawings(chartId: string, ids: readonly string[]): void {
  if (!ids.length) return;
  runInSession(chartId, () => {
    const list = ids.map((id) => findDrawing(id)).filter((d) => d !== undefined);
    if (list.length)
      commit(
        'Remove AI drawings',
        list.map((d) => ({ before: d, after: null })),
      );
  });
  const set = aiDrawings.get(chartId);
  ids.forEach((id) => set?.delete(id));
}

/** Run one tool call. Never throws: failures come back as a result the model can read. */
export async function runTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
  const args = call.arguments ?? {};
  try {
    switch (call.name) {
      case 'list_indicators':
        return listIndicatorsTool(ctx);
      case 'add_indicator':
        return await addIndicatorTool(ctx, args);
      case 'remove_indicator':
        return removeIndicatorTool(ctx, args);
      case 'find_swings':
        return findSwingsTool(ctx, args);
      case 'find_divergences':
        return await findDivergencesTool(ctx, args);
      case 'draw_divergence':
        return drawDivergenceTool(ctx, args);
      case 'draw_trend_line':
        return drawTrendLineTool(ctx, args);
      case 'draw_horizontal_line':
        return drawHorizontalTool(ctx, args);
      case 'clear_ai_drawings':
        return clearTool(ctx);
      default:
        return fail(`unknown tool "${call.name}"`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), `${call.name} failed`);
  }
}
