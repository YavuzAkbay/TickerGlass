/**
 * Chart tools the model can call (Ollama function calling, docs/design/local-ai.md §7): add or
 * remove indicators, find swings and divergences exactly, and draw lines. They run in the browser
 * on the chart the question is about; every change goes through the undoable store actions.
 */
import {
  findDivergences,
  findLevels,
  findSwings,
  isIntraday,
  macdHistogram,
  macdLine,
  rangeIndexes,
  rsi,
  timeFormatter,
  type BriefBars,
  type BriefFocus,
  type Divergence,
  type Level,
} from '@tickerglass/ai-context';
import type { Chart, DrawingInput, DrawingStyle } from '@tickerglass/engine';
import type { InputValueMap } from '@tickerglass/indicators';
import { bindToChart } from '../drawings/attach';
import { commit, findDrawing } from '../drawings/actions';
import { addIndicator, findIndicator, removeIndicators } from '../indicators/actions';
import { useIndicatorStore } from '../indicators/store';
import { runInSession } from '../store/chart';
import type { AiTier } from './api';
import {
  anchorRange,
  coerceInputs,
  describeIndicator,
  drawableTypes,
  findIndicatorDef,
  searchIndicators,
} from './catalog';
import { fundamentalsReport } from './fundamentals';

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
  /** The model's tier: Basic gets the curated indicator list only. */
  tier?: AiTier;
}

/** Divergence sources: indicator type, the plotted output searched and drawn on, and how many
 * bars its extreme may sit from the price swing. MACD means its histogram, as most analysts read
 * MACD divergences (it turns before the line); `macd_line` is the MACD line itself. */
const OSCILLATORS: Record<
  string,
  { type: string; output: string; tolerance?: number; inputs?: Record<string, number> }
> = {
  rsi: { type: 'rsi', output: 'rsi' },
  macd: { type: 'macd', output: 'hist', tolerance: 5 },
  macd_line: { type: 'macd', output: 'macd' },
  stochastic: { type: 'stochastic', output: 'k' },
  cci: { type: 'cci', output: 'cci' },
  mfi: { type: 'mfi', output: 'mf' },
  obv: { type: 'obv', output: 'obv' },
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
/** Financial-statement indicators by the name the model uses (each plots in its own pane). */
const FINANCIAL: Record<string, string> = {
  revenue: 'fin-revenue',
  revenue_growth: 'fin-revenue-growth',
  net_income: 'fin-net-income',
  net_income_growth: 'fin-net-income-growth',
  eps: 'fin-eps',
  gross_margin: 'fin-gross-margin',
  operating_margin: 'fin-operating-margin',
  net_margin: 'fin-net-margin',
  operating_cash_flow: 'fin-ocf',
  free_cash_flow: 'fin-fcf',
  debt_to_equity: 'fin-debt-equity',
  debt_to_cash: 'fin-debt-cash',
  current_ratio: 'fin-current-ratio',
  roe: 'fin-roe',
  book_value_per_share: 'fin-bvps',
  pe: 'fin-pe',
  ps: 'fin-ps',
  pb: 'fin-pb',
};
/** Tools that only read: offered even when the user has not let the AI change the chart. */
export const READ_ONLY_TOOLS = new Set([
  'list_indicators',
  'get_fundamentals',
  'find_swings',
  'find_divergences',
  'find_levels',
  'search_indicators',
  'list_drawings',
  'get_bars',
  'get_events',
  'get_news',
]);

const TIER_RANK: Record<AiTier, number> = { basic: 0, standard: 1, full: 2 };
/** Lowest tier offered each tool; unlisted tools are Basic (mirrors the server's TIER_TOOLS). */
const MIN_TIER: Record<string, AiTier> = {
  search_indicators: 'standard',
  draw: 'standard',
  list_drawings: 'full',
  update_drawing: 'full',
  remove_drawing: 'full',
  edit_indicator: 'full',
  set_chart: 'full',
  get_bars: 'full',
  get_events: 'full',
  get_news: 'full',
};

/** Tool rounds per question before the loop gives up. */
export const MAX_TOOL_ROUNDS: Record<AiTier, number> = { basic: 6, standard: 10, full: 16 };

/** The tools a model of `tier` gets; only read-only ones unless the user allows chart changes. */
export function schemasFor(tier: AiTier, allowActions: boolean): ToolSchema[] {
  return TOOL_SCHEMAS.filter((t) => {
    const name = t.function.name;
    if (TIER_RANK[MIN_TIER[name] ?? 'basic'] > TIER_RANK[tier]) return false;
    return allowActions || READ_ONLY_TOOLS.has(name);
  }).map((t) => {
    if (tier === 'basic') return t;
    if (t.function.name === 'add_indicator') return OPEN_ADD_INDICATOR;
    if (t.function.name === 'draw') return drawSchema(tier);
    return t;
  });
}

/** Standard and Full: any indicator in the app, with its inputs. */
const OPEN_ADD_INDICATOR: ToolSchema = {
  type: 'function',
  function: {
    name: 'add_indicator',
    description:
      'Add any indicator in the app (reuses an identical one already there). type: an id from search_indicators, or a common name (rsi, macd, bollinger, pe, revenue...). inputs: values by input key from search_indicators; omitted ones keep their defaults. Returns its id and latest values.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string' },
        inputs: { type: 'object', description: 'e.g. {"length": 50}' },
        length: { type: 'number', description: 'Shortcut for inputs.length' },
      },
      required: ['type'],
    },
  },
};

function drawSchema(tier: AiTier): ToolSchema {
  return {
    type: 'function',
    function: {
      name: 'draw',
      description:
        'Place a drawing from anchor points. Anchors per type: fib-retracement 2 (start and end of the move), fib-extension 3 (move start, move end, retracement end), rectangle 2 (opposite corners), parallel-channel 3 (line start, line end, a point on the parallel side), trend-line/ray/extended-line/arrow-line/callout 2, horizontal-ray/vertical-line/text 1. Anchor on swings from find_swings or levels from find_levels.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: drawableTypes(tier) },
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: { time: { type: 'string' }, price: { type: 'number' } },
              required: ['time', 'price'],
            },
          },
          pane: { type: 'string', description: "'price' (default) or an indicator id" },
          text: { type: 'string', description: 'Label or text, a few words' },
          tone: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
        },
        required: ['type', 'points'],
      },
    },
  };
}
const TONE = { bullish: '#34C38F', bearish: '#F2626B', neutral: '#9AA8FF' } as const;
type Tone = keyof typeof TONE;
const MAX_RESULT_CHARS = 4000;
const MAX_FUNDAMENTALS_CHARS = 9000;
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
      name: 'search_indicators',
      description:
        'Search every indicator in the app by name or idea (e.g. "ichimoku", "volatility", "vwap"). Returns ids and inputs for add_indicator. Read-only.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw',
      description: 'Place a drawing from anchor points (schema filled per tier).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_indicator',
      description:
        'Add an indicator to the chart (reuses an identical one already there). Returns its id and recent values. Financial ones (revenue, pe, roe...) plot the statements of the chart symbol over time.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...ADDABLE, ...Object.keys(FINANCIAL)] },
          length: { type: 'number', description: 'Period, e.g. 14 for RSI, 20 for Bollinger' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_fundamentals',
      description:
        "Financial statements and valuation of the chart's symbol, computed exactly: trailing twelve months revenue, earnings, EPS, cash flow, margins, growth, ROE, balance sheet, P/E, P/S, P/B, PEG, yields, the same multiples at past period ends, and the last quarters and fiscal years. Read-only.",
      parameters: { type: 'object', properties: {} },
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
        'Find regular and hidden, bullish and bearish divergences between price and an oscillator in the focus range, most recent first. "macd" uses the MACD histogram (the usual choice); "macd_line" the MACD line. Read-only: does not change the chart. Returns ids for draw_divergence.',
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
        'Draw one divergence found by find_divergences: a line between the two price swings and one between the two oscillator values (adds the oscillator to the chart if needed).',
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
      name: 'find_levels',
      description:
        'Find horizontal support and resistance: prices where price turned at least twice, over all loaded history up to the focus end, nearest to the latest close on both sides. Read-only. Returns ids for draw_level.',
      parameters: {
        type: 'object',
        properties: { max: { type: 'number', description: 'How many levels, default 5' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw_level',
      description:
        'Draw a level found by find_levels as a horizontal line starting where it formed (green support, red resistance).',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'e.g. "L2"' } },
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
  Map<string, Divergence & { osc: string; studyTitle: string }>
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
/** A price for people and the model: 2 decimals from 1 up, else 4 significant digits. */
const px = (v: number): number =>
  Math.abs(v) >= 1 ? Number(v.toFixed(2)) : Number(v.toPrecision(4));

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
  inputs: InputValueMap,
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

function storeBars(ctx: ToolContext): BriefBars {
  const s = ctx.chart.store;
  return {
    length: s.length,
    time: s.time,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: s.volume,
  };
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

function result(
  data: unknown,
  summary: string,
  ok = true,
  maxChars = MAX_RESULT_CHARS,
): ToolResult {
  let content = JSON.stringify(data);
  if (content.length > maxChars) content = `${content.slice(0, maxChars)}…`;
  return { content, summary, ok };
}

const fail = (message: string, summary = message): ToolResult =>
  result({ error: message }, summary, false);

// ------------------------------------------------------------ tools

async function addIndicatorTool(ctx: ToolContext, args: Record<string, unknown>) {
  const name = str(args.type)
    .toLowerCase()
    .replace(/[\s/-]+/g, '_');
  const financial = FINANCIAL[name] ?? (name === 'p_e' ? FINANCIAL.pe : undefined);
  const type = financial ?? name;
  if (ctx.tier && ctx.tier !== 'basic' && !ADDABLE.includes(type)) {
    const def = findIndicatorDef(financial ?? str(args.type));
    if (!def) return fail(`no indicator "${str(args.type)}"; call search_indicators first`);
    const raw =
      args.inputs && typeof args.inputs === 'object'
        ? { ...(args.inputs as Record<string, unknown>) }
        : {};
    if (args.length !== undefined && raw.length === undefined && 'length' in def.inputs)
      raw.length = args.length;
    const { inputs, errors } = coerceInputs(def, raw);
    if (errors.length) return fail(`${def.name}: ${errors.join('; ')}`);
    return addedResult(ctx, await ensureIndicator(ctx, def.id, inputs as InputValueMap), def.id);
  }
  if (!financial && !ADDABLE.includes(type))
    return fail(
      `unknown indicator "${name}"; use one of ${[...ADDABLE, ...Object.keys(FINANCIAL)].join(', ')}`,
    );
  const length = num(args.length);
  const inputs = Number.isFinite(length) && length > 0 ? { length: Math.round(length) } : {};
  // MACD, Stochastic, OBV, Volume and the financial ones have no plain `length` input.
  const takesLength = !financial && !['macd', 'stochastic', 'obv', 'volume'].includes(type);
  return addedResult(ctx, await ensureIndicator(ctx, type, takesLength ? inputs : {}), type);
}

function addedResult(
  ctx: ToolContext,
  got: { id: string; added: boolean } | null,
  type: string,
): ToolResult {
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

function searchIndicatorsTool(args: Record<string, unknown>) {
  const query = str(args.query);
  const found = searchIndicators(query);
  if (!found.length) return fail(`no indicator matches "${query}"`);
  return result(
    { indicators: found.map(describeIndicator) },
    `Searched indicators: ${query}`,
    true,
    6000,
  );
}

function drawTool(ctx: ToolContext, args: Record<string, unknown>) {
  const type = str(args.type);
  const tier = ctx.tier ?? 'basic';
  if (tier === 'basic' || !drawableTypes(tier).includes(type))
    return fail(`cannot draw "${type}"; use one of ${drawableTypes(tier).join(', ')}`);
  const range = anchorRange(type)!;
  const raw = Array.isArray(args.points) ? (args.points as unknown[]) : [];
  if (raw.length < range.min || raw.length > range.max)
    return fail(
      `${type} takes ${range.min === range.max ? range.min : `${range.min}-${range.max}`} point(s), got ${raw.length}`,
    );
  const pane = paneFor(ctx, args.pane);
  if (!pane) return fail(`no indicator pane "${str(args.pane)}"`);
  const points: { time: number; price: number }[] = [];
  for (const [i, p] of raw.entries()) {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const time = parseBarTime(ctx.chart, o.time);
    const price = num(o.price);
    if (time === null || !Number.isFinite(price))
      return fail(`point ${i + 1} needs a time on the chart and a numeric price`);
    points.push({ time, price });
  }
  const text = str(args.text).slice(0, 80);
  const name = type.replace(/-/g, ' ');
  addDrawings(
    ctx,
    [
      {
        type,
        paneId: pane.paneId,
        points,
        ...(args.tone ? { style: lineStyle(toneOf(args.tone)) } : {}),
        ...(text ? { text } : {}),
      },
    ],
    `AI: ${name}`,
  );
  const fmt = fmtTime(ctx.chart);
  return result(
    {
      drawn: type,
      pane: pane.name,
      points: points.map((p) => ({ time: fmt(p.time), price: px(p.price) })),
    },
    `Drew ${name}`,
  );
}

/** JSON without the nulls of figures the statements do not have. */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== null && x !== undefined)
        .map(([k, x]) => [k, prune(x)]),
    );
  return v;
}

async function getFundamentalsTool(ctx: ToolContext) {
  try {
    const report = await fundamentalsReport(ctx.chart);
    return result(prune(report), 'Read fundamentals', true, MAX_FUNDAMENTALS_CHARS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(`financial statements unavailable: ${msg}`, 'No fundamentals available');
  }
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
    findSwings(vals, k, { strength, from, to, includeLast: true })
      .slice(-12)
      .map((p) => ({
        time: fmt(s.time[p.index]!),
        value: round(p.value),
        ...(p.confirmed === false ? { stillForming: true } : {}),
      }));
  const data = {
    source: name,
    ...(kind !== 'low' ? { highs: pick(highs, 'high') } : {}),
    ...(kind !== 'high' ? { lows: pick(lows, 'low') } : {}),
  };
  const n = (data.highs?.length ?? 0) + (data.lows?.length ?? 0);
  return result(data, `Found ${n} swing${n === 1 ? '' : 's'} on ${name}`);
}

/** Oscillator values for divergence search without touching the chart: the indicator's own
 * values when it is on the chart, else RSI / MACD computed here. */
function oscillatorValues(
  ctx: ToolContext,
  osc: string,
): { values: ArrayLike<number>; studyId: string | null; title: string } | null {
  const spec = OSCILLATORS[osc]!;
  const s = ctx.chart.store;
  const onChart = runInSession(ctx.chartId, () =>
    useIndicatorStore.getState().instances.find((i) => i.type === spec.type),
  );
  if (onChart) {
    const data = ctx.chart.getStudyData(onChart.id);
    const values = data?.values[spec.output];
    if (data?.current && values)
      return {
        values: values.subarray(0, data.length),
        studyId: onChart.id,
        title:
          (studyInfo(ctx.chart, onChart.id)?.title ?? osc.toUpperCase()) +
          (spec.output === 'hist' ? ' histogram' : ''),
      };
  }
  const close = s.close.subarray(0, s.length);
  if (osc === 'rsi') return { values: rsi(close, 14), studyId: null, title: 'RSI 14' };
  if (osc === 'macd')
    return { values: macdHistogram(close), studyId: null, title: 'MACD 12 26 9 histogram' };
  if (osc === 'macd_line') return { values: macdLine(close), studyId: null, title: 'MACD 12 26' };
  return null;
}

async function findDivergencesTool(ctx: ToolContext, args: Record<string, unknown>) {
  const osc = str(args.oscillator, 'rsi').toLowerCase();
  if (!OSCILLATORS[osc]) return fail(`unsupported oscillator "${osc}"`);
  let source = oscillatorValues(ctx, osc);
  if (!source) {
    // Stochastic, CCI, MFI, OBV: only from the chart's own indicator.
    const spec = OSCILLATORS[osc]!;
    const got = await ensureIndicator(ctx, spec.type, spec.inputs ?? {});
    if (!got) return fail(`could not add ${osc}`);
    source = oscillatorValues(ctx, osc);
    if (!source) return fail(`${osc} has no values yet`);
  }
  const range = focusIndexes(ctx);
  if (!range) return fail('no bars in the focus range');
  const kinds = str(args.kinds, 'both');
  const found = findDivergences(storeBars(ctx), source.values, {
    from: range[0],
    to: range[1],
    strength: 4,
    tolerance: OSCILLATORS[osc]!.tolerance ?? 2,
    kinds:
      kinds === 'regular' ? ['regular'] : kinds === 'hidden' ? ['hidden'] : ['regular', 'hidden'],
  });
  divergences.set(
    ctx.chartId,
    new Map(found.map((d) => [d.id, { ...d, osc, studyTitle: source.title }])),
  );
  const fmt = fmtTime(ctx.chart);
  return result(
    {
      oscillator: source.title,
      onChart: source.studyId !== null,
      note: 'Most recent first. confirmed=false: the second swing is still forming (latest bars).',
      divergences: found.map((d) => ({
        id: d.id,
        type: `${d.kind} ${d.direction}`,
        price: d.price.map((p) => ({ time: fmt(p.time), price: round(p.value) })),
        [osc]: d.oscillator.map((p) => ({ time: fmt(p.time), value: round(p.value) })),
        bars: d.bars,
        confirmed: d.confirmed,
      })),
    },
    `Found ${found.length} divergence${found.length === 1 ? '' : 's'} (${source.title})`,
  );
}

async function drawDivergenceTool(ctx: ToolContext, args: Record<string, unknown>) {
  const d = divergences.get(ctx.chartId)?.get(str(args.id));
  if (!d) return fail(`unknown divergence id "${str(args.id)}"; call find_divergences first`);
  // The oscillator goes on the chart only now, when there is something to draw on it.
  const spec = OSCILLATORS[d.osc]!;
  const got = await ensureIndicator(ctx, spec.type, spec.inputs ?? {});
  if (!got) return fail(`could not add ${d.osc}`);
  const pane = studyInfo(ctx.chart, got.id);
  if (!pane) return fail(`${d.osc} is not on the chart`);
  // Anchor the oscillator line on the plotted values (they match the search to rounding).
  const plotted = ctx.chart.getStudyData(got.id)?.values[spec.output];
  const oscPoint = (p: { index: number; time: number; value: number }) => {
    const v = plotted?.[p.index];
    return { time: p.time, price: v !== undefined && Number.isFinite(v) ? v : p.value };
  };
  const tone: Tone = d.direction;
  const name = `${d.kind === 'hidden' ? 'hidden ' : ''}${d.direction} divergence`;
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
        points: d.oscillator.map(oscPoint),
        style: lineStyle(tone),
      },
    ],
    `AI: ${name}`,
  );
  return result(
    { drawn: d.id, indicatorAdded: got.added },
    `${got.added ? `Added ${pane.title} · ` : ''}Drew ${name} ${d.id}`,
  );
}

/** Support/resistance per chart, by id, for draw_level. */
const levelCache = new Map<string, Map<string, Level>>();

function findLevelsTool(ctx: ToolContext, args: Record<string, unknown>) {
  const range = focusIndexes(ctx);
  if (!range) return fail('no bars in the focus range');
  const all = storeBars(ctx);
  // All history up to the focus end: old levels still matter after a breakdown.
  const upTo = { ...all, length: range[1] + 1 };
  const limit = Number.isFinite(num(args.max)) ? Math.max(2, Math.min(10, num(args.max))) : 5;
  const levels = findLevels(upTo, { limit });
  levelCache.set(ctx.chartId, new Map(levels.map((l) => [l.id, l])));
  const fmt = fmtTime(ctx.chart);
  return result(
    {
      close: round(all.close[range[1]]!),
      note: 'Prices where swings turned at least twice, nearest to the close on both sides.',
      levels: levels.map((l) => ({
        id: l.id,
        price: px(l.price),
        role: l.role,
        touches: l.touches.length,
        first: fmt(l.touches[0]!.time),
        last: fmt(l.touches.at(-1)!.time),
        flipped: l.flipped,
        distancePct: Number(l.distancePct.toFixed(1)),
      })),
    },
    `Found ${levels.length} support/resistance level${levels.length === 1 ? '' : 's'}`,
  );
}

function drawLevelTool(ctx: ToolContext, args: Record<string, unknown>) {
  const l = levelCache.get(ctx.chartId)?.get(str(args.id));
  if (!l) return fail(`unknown level id "${str(args.id)}"; call find_levels first`);
  addDrawings(
    ctx,
    [
      {
        // A ray from where the level formed, like a hand-drawn one.
        type: 'horizontal-ray',
        paneId: 'main',
        points: [{ time: l.touches[0]!.time, price: l.price }],
        style: lineStyle(l.role === 'support' ? 'bullish' : 'bearish'),
      },
    ],
    `AI: ${l.role}`,
  );
  return result({ drawn: l.id }, `Drew ${l.role} at ${px(l.price)}`);
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
  return result({ drawn: 'horizontal line', price }, `Drew a line at ${px(price)}`);
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
      case 'get_fundamentals':
        return await getFundamentalsTool(ctx);
      case 'search_indicators':
        return searchIndicatorsTool(args);
      case 'draw':
        return drawTool(ctx, args);
      case 'remove_indicator':
        return removeIndicatorTool(ctx, args);
      case 'find_swings':
        return findSwingsTool(ctx, args);
      case 'find_divergences':
        return await findDivergencesTool(ctx, args);
      case 'draw_divergence':
        return await drawDivergenceTool(ctx, args);
      case 'find_levels':
        return findLevelsTool(ctx, args);
      case 'draw_level':
        return drawLevelTool(ctx, args);
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
