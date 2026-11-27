/**
 * Full-tier chart tools (large and cloud models): read and edit every drawing and indicator,
 * switch the chart, and read other symbols, events and news. Changes stay undoable: edits and
 * removals keep a snapshot in `AiChanges.restore` for "Undo AI changes", and the whole answer is
 * one step in the chart's undo history.
 */
import { buildChartBrief, type BriefBars } from '@tickerglass/ai-context';
import {
  CHART_TYPES,
  getDrawingTool,
  parseInterval,
  toApiInterval,
  type ChartType,
} from '@tickerglass/engine';
import { requestJson } from '../api/client';
import type { NewsItem } from '../api/types';
import { RANGE_PRESETS } from '../bottombar/ranges';
import { commit, currentDrawings, findDrawing, updateDrawings } from '../drawings/actions';
import { fetchEvents } from '../events/api';
import { findIndicator, updateIndicator } from '../indicators/actions';
import { findIndicatorDef, coerceInputs } from './catalog';
import { syncBus } from '../layout/sync';
import { runInSession } from '../store/chart';
import { useChartView } from '../store/chartView';
import { briefFromChart, visibleFocus } from './context';
import { fundamentalsReport, type PriceHistory } from './fundamentals';
import { BARS_DEFAULT } from './fullSchemas';
import { fail, prune, result, type ToolResult } from './toolResult';
import { fmtTime, lineStyle, num, parseBarTime, px, str, toneOf, type ToolContext } from './tools';

const MAX_DRAWINGS_LISTED = 60;
const BARS_MAX = 2000;
const CHART_WAIT_MS = 15_000;
const NEWS_LIMIT = 12;

// ------------------------------------------------------------ helpers

function restore(ctx: ToolContext) {
  ctx.changes.restore ??= { drawings: [], indicators: [] };
  return ctx.changes.restore;
}

const dateOf = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

interface ApiBars {
  symbol: string;
  interval: string;
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

async function fetchBars(symbol: string, interval: string, limit: number): Promise<ApiBars> {
  const api = toApiInterval(parseInterval(interval));
  if (!api)
    throw new Error(`interval ${interval} is not available for other symbols; use 1D, 1W or 1h`);
  return requestJson<ApiBars>('GET', '/bars', undefined, {
    query: { symbol, interval: api, limit, adjusted: true },
  });
}

const briefBars = (b: ApiBars): BriefBars => ({
  length: b.t.length,
  time: b.t,
  open: b.o,
  high: b.h,
  low: b.l,
  close: b.c,
  volume: b.v,
});

/** Another symbol's daily closes in the shape the fundamentals report reads. */
async function historyOf(symbol: string): Promise<PriceHistory> {
  const b = await fetchBars(symbol, '1D', BARS_MAX);
  const time = Float64Array.from(b.t);
  const close = Float64Array.from(b.c);
  return {
    getSymbol: () => symbol,
    rawStore: { length: b.t.length, time, close },
    symbolInfo: null,
  } as unknown as PriceHistory;
}

function closeAtOrBefore(time: ArrayLike<number>, close: ArrayLike<number>, n: number, t: number) {
  let r = NaN;
  for (let i = 0; i < n && time[i]! <= t; i++) r = close[i]!;
  return r;
}

async function waitForChart(ctx: ToolContext, symbol: string): Promise<boolean> {
  const until = Date.now() + CHART_WAIT_MS;
  while (Date.now() < until) {
    if (ctx.chart.getSymbol() === symbol && ctx.chart.store.length > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// ------------------------------------------------------------ tools

function listDrawingsTool(ctx: ToolContext): ToolResult {
  const fmt = fmtTime(ctx.chart);
  const list = runInSession(ctx.chartId, currentDrawings)
    .filter((d) => (getDrawingTool(d.type)?.coords ?? 'chart') === 'chart')
    .slice(-MAX_DRAWINGS_LISTED)
    .map((d) => ({
      id: d.id,
      type: d.type,
      pane: d.paneId === 'main' ? 'price' : d.paneId,
      points: d.points.map((p) => ({ time: fmt(p.time), price: px(p.price) })),
      ...(d.text ? { text: d.text.slice(0, 80) } : {}),
      ...(d.hidden ? { hidden: true } : {}),
      ...(d.locked ? { locked: true } : {}),
    }));
  return result({ drawings: list }, `Read ${list.length} drawings`, true, 8000);
}

function updateDrawingTool(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const id = str(args.id);
  const before = runInSession(ctx.chartId, () => findDrawing(id));
  if (!before) return fail(`no drawing "${id}"; call list_drawings`);
  if (before.locked) return fail('that drawing is locked by the user');
  const patch: Record<string, unknown> = {};
  if (Array.isArray(args.points)) {
    if (args.points.length !== before.points.length)
      return fail(`${before.type} has ${before.points.length} point(s)`);
    const points = [];
    for (const [i, p] of (args.points as unknown[]).entries()) {
      const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      const time = o.time === undefined ? before.points[i]!.time : parseBarTime(ctx.chart, o.time);
      const price = o.price === undefined ? before.points[i]!.price : num(o.price);
      if (time === null || !Number.isFinite(price)) return fail(`point ${i + 1} is not valid`);
      points.push({ time, price });
    }
    patch.points = points;
  }
  if (typeof args.text === 'string') patch.text = args.text.slice(0, 200);
  if (args.tone) patch.style = { ...before.style, ...lineStyle(toneOf(args.tone)) };
  if (typeof args.hidden === 'boolean') patch.hidden = args.hidden;
  if (!Object.keys(patch).length) return fail('nothing to change');
  restore(ctx).drawings.push(before);
  runInSession(ctx.chartId, () => updateDrawings([id], patch, 'AI: Edit drawing'));
  return result(
    { updated: id, changed: Object.keys(patch) },
    `Edited ${before.type.replace(/-/g, ' ')}`,
  );
}

function removeDrawingTool(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const ids = Array.isArray(args.ids) ? args.ids.map((x) => str(x)) : [str(args.ids)];
  const found = runInSession(ctx.chartId, () =>
    ids.map((id) => findDrawing(id)).filter((d) => d && !d.locked),
  );
  if (!found.length) return fail('no unlocked drawings with those ids; call list_drawings');
  restore(ctx).drawings.push(...found.map((d) => d!));
  runInSession(ctx.chartId, () =>
    commit(
      'AI: Remove drawings',
      found.map((d) => ({ before: d!, after: null })),
    ),
  );
  return result({ removed: found.map((d) => d!.id) }, `Removed ${found.length} drawing(s)`);
}

function editIndicatorTool(ctx: ToolContext, args: Record<string, unknown>): ToolResult {
  const id = str(args.id);
  const inst = runInSession(ctx.chartId, () => findIndicator(id));
  if (!inst) return fail(`no indicator "${id}"; call list_indicators`);
  const def = findIndicatorDef(inst.type);
  if (!def) return fail(`unknown indicator type ${inst.type}`);
  const { inputs, errors } = coerceInputs(def, args.inputs);
  if (errors.length) return fail(errors.join('; '));
  if (!Object.keys(inputs).length) return fail('no inputs to change');
  restore(ctx).indicators.push(inst);
  const ok = runInSession(ctx.chartId, () =>
    updateIndicator(
      id,
      { inputs: { ...inst.inputs, ...inputs } as typeof inst.inputs },
      'AI: Edit indicator',
    ),
  );
  return ok
    ? result({ updated: id, inputs }, `Edited ${def.name}`)
    : fail(`could not apply those inputs to ${def.name}`);
}

async function setChartTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const view = runInSession(ctx.chartId, () => useChartView.getState());
  const preset = args.range ? RANGE_PRESETS.find((p) => p.label === str(args.range)) : undefined;
  if (args.range && !preset)
    return fail(`range must be one of ${RANGE_PRESETS.map((p) => p.label).join(', ')}`);
  const symbol = args.symbol ? str(args.symbol).trim().toUpperCase() : view.symbol;
  const interval = args.interval ? str(args.interval).trim() : (preset?.interval ?? view.interval);
  try {
    parseInterval(interval);
  } catch {
    return fail(`unknown interval "${interval}"`);
  }
  const chartType = args.chart_type ? (str(args.chart_type) as ChartType) : undefined;
  if (chartType && !CHART_TYPES.includes(chartType))
    return fail(`unknown chart type "${chartType}"`);
  const changed: string[] = [];
  if (symbol !== view.symbol || interval !== view.interval) {
    try {
      await ctx.chart.setSymbolAndInterval(symbol, interval);
    } catch (e) {
      return fail(`could not load ${symbol} ${interval}: ${e instanceof Error ? e.message : e}`);
    }
    runInSession(ctx.chartId, () => {
      if (symbol !== view.symbol) view.setSymbol(symbol);
      if (interval !== view.interval) view.setInterval(interval);
    });
    if (!(await waitForChart(ctx, symbol))) return fail(`no data for ${symbol} ${interval}`);
    changed.push(`${symbol} ${interval}`);
  }
  if (chartType && chartType !== view.chartType) {
    runInSession(ctx.chartId, () => view.set({ chartType }));
    changed.push(chartType);
  }
  if (preset) {
    const n = ctx.chart.store.length;
    if (n) {
      await (preset.from === null
        ? syncBus.range(ctx.chartId, 'all')
        : syncBus.range(ctx.chartId, {
            from: preset.from(ctx.chart.store.time[n - 1]!),
            to: Infinity,
          }));
      changed.push(preset.label);
    }
  }
  if (!changed.length) return fail('the chart already shows that');
  // Later tools read the new view.
  const focus = visibleFocus(ctx.chart);
  if (focus) ctx.focus = focus;
  const brief = focus ? briefFromChart(ctx.chart, focus, 2500) : null;
  return result(
    { changed, chartContext: brief?.text ?? 'no bars yet' },
    `Switched chart to ${changed.join(' · ')}`,
    true,
    12_000,
  );
}

async function getBarsTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = str(args.symbol).trim().toUpperCase();
  if (!symbol) return fail('symbol is required');
  const interval = str(args.interval, '1D') || '1D';
  const want = Math.min(BARS_MAX, Math.max(20, Math.round(num(args.bars)) || BARS_DEFAULT));
  let b: ApiBars;
  try {
    b = await fetchBars(symbol, interval, want);
  } catch (e) {
    return fail(
      `no bars for ${symbol}: ${e instanceof Error ? e.message : e}`,
      `No bars for ${symbol}`,
    );
  }
  const n = b.t.length;
  if (!n) return fail(`no bars for ${symbol}`, `No bars for ${symbol}`);
  const tz =
    ctx.chart.timezone === 'local'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
      : ctx.chart.timezone;
  const brief = buildChartBrief(
    {
      symbol,
      interval,
      timezone: tz,
      bars: briefBars(b),
      focus: { kind: 'visible', from: b.t[0]!, to: b.t[n - 1]! },
    },
    { maxTokens: 1800 },
  );
  // Same dates on the chart symbol, for "how did X do next to Y".
  const from = b.t[0]!;
  const to = b.t[n - 1]!;
  const own = ctx.chart.rawStore;
  const a0 = closeAtOrBefore(own.time, own.close, own.length, from);
  const a1 = closeAtOrBefore(own.time, own.close, own.length, to);
  const change = ((b.c[n - 1]! - b.c[0]!) / b.c[0]!) * 100;
  const chartChange =
    Number.isFinite(a0) && Number.isFinite(a1) && a0 ? ((a1 - a0) / a0) * 100 : NaN;
  return result(
    prune({
      symbol,
      from: dateOf(from),
      to: dateOf(to),
      changePct: Number(change.toFixed(2)),
      chartSymbol: ctx.chart.getSymbol(),
      chartSymbolChangePct: Number.isFinite(chartChange) ? Number(chartChange.toFixed(2)) : null,
      context: brief.text,
    }),
    `Read ${symbol} ${interval} bars`,
    true,
    10_000,
  );
}

async function getFundamentalsOfTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  const symbol = str(args.symbol).trim().toUpperCase();
  if (!symbol || symbol === ctx.chart.getSymbol()) return null; // the chart's own: tools.ts
  try {
    const report = await fundamentalsReport(await historyOf(symbol));
    return result(prune(report), `Read ${symbol} fundamentals`, true, 9000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail(
      `financial statements of ${symbol} unavailable: ${msg}`,
      `No fundamentals for ${symbol}`,
    );
  }
}

async function getEventsTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = str(args.symbol).trim().toUpperCase() || ctx.chart.getSymbol();
  try {
    const ev = await fetchEvents(symbol);
    const recent = <T extends { t: number }>(xs: T[] | undefined, k: number) =>
      [...(xs ?? [])].sort((a, b) => a.t - b.t).slice(-k);
    const now = Date.now() / 1000;
    return result(
      prune({
        symbol,
        earnings: recent(ev.earnings, 12).map((e) => ({
          date: dateOf(e.t),
          ...(e.t > now ? { upcoming: true } : {}),
          epsEstimate: e.epsEstimate ?? null,
          epsActual: e.epsActual ?? null,
          surprisePct: e.surprisePercent ?? null,
        })),
        dividends: recent(ev.dividends, 8).map((d) => ({ date: dateOf(d.t), amount: d.amount })),
        splits: recent(ev.splits, 5).map((s) => ({ date: dateOf(s.t), ratio: s.ratio })),
      }),
      `Read ${symbol} events`,
      true,
      6000,
    );
  } catch (e) {
    return fail(
      `no events for ${symbol}: ${e instanceof Error ? e.message : e}`,
      `No events for ${symbol}`,
    );
  }
}

async function getNewsTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const symbol = str(args.symbol).trim().toUpperCase() || ctx.chart.getSymbol();
  try {
    const items = await requestJson<NewsItem[]>(
      'GET',
      `/news/${encodeURIComponent(symbol)}`,
      undefined,
      {
        query: { limit: NEWS_LIMIT },
      },
    );
    const news = (Array.isArray(items) ? items : []).map((n) => ({
      date: n.time ? dateOf(n.time) : null,
      title: n.title,
      publisher: n.publisher,
    }));
    if (!news.length) return fail(`no news for ${symbol}`, `No news for ${symbol}`);
    return result(prune({ symbol, news }), `Read ${symbol} news`, true, 6000);
  } catch (e) {
    return fail(
      `no news for ${symbol}: ${e instanceof Error ? e.message : e}`,
      `No news for ${symbol}`,
    );
  }
}

/** Run a Full-tier tool, or null when `name` is not one (or is the chart's own fundamentals). */
export async function runFullTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult | null> {
  switch (name) {
    case 'list_drawings':
      return listDrawingsTool(ctx);
    case 'update_drawing':
      return updateDrawingTool(ctx, args);
    case 'remove_drawing':
      return removeDrawingTool(ctx, args);
    case 'edit_indicator':
      return editIndicatorTool(ctx, args);
    case 'set_chart':
      return setChartTool(ctx, args);
    case 'get_bars':
      return getBarsTool(ctx, args);
    case 'get_fundamentals':
      return getFundamentalsOfTool(ctx, args);
    case 'get_events':
      return getEventsTool(ctx, args);
    case 'get_news':
      return getNewsTool(ctx, args);
    default:
      return null;
  }
}

/** Put back what the AI edited or removed (for Undo AI changes). */
export function restoreChanges(restore: NonNullable<ToolContext['changes']['restore']>): void {
  // Oldest snapshot of each item wins (it may have been edited more than once).
  const drawings = new Map<string, (typeof restore.drawings)[number]>();
  for (const d of restore.drawings) if (!drawings.has(d.id)) drawings.set(d.id, d);
  if (drawings.size)
    commit(
      'Undo AI edits',
      [...drawings.values()].map((d) => ({ before: findDrawing(d.id) ?? null, after: d })),
    );
  const indicators = new Map<string, (typeof restore.indicators)[number]>();
  for (const i of restore.indicators) if (!indicators.has(i.id)) indicators.set(i.id, i);
  for (const i of indicators.values())
    if (findIndicator(i.id)) updateIndicator(i.id, { inputs: i.inputs }, 'Undo AI edits');
}
