import {
  at,
  fmtCompact,
  fmtPct,
  fmtPrice,
  fmtValue,
  inferPrecision,
  isIntraday,
  timeFormatter,
  type TimeFormat,
} from './format';
import { focusStats, rangeIndexes } from './stats';
import type { BriefInput, BriefOptions, ChartBrief, FocusStats, PricePoint } from './types';

export const BRIEF_START = 'CHART CONTEXT';
export const BRIEF_END = 'END CHART CONTEXT';

const DEFAULTS = { maxTokens: 4000, maxFocusRows: 250, leadBars: 100, leadRows: 25 };
const MAX_DRAWINGS = 30;
const MAX_POINTS = 8;

/** Rough token count of the brief: numbers and punctuation tokenize at about 3 chars a token. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

interface Column {
  label: string;
  values: ArrayLike<number>;
}

interface Params {
  maxFocusRows: number;
  leadBars: number;
  leadRows: number;
  studyColumns: boolean;
  maxDrawings: number;
}

interface Ctx {
  input: BriefInput;
  decimals: number;
  fmtTime: TimeFormat;
  columns: Column[];
  a: number;
  b: number;
}

function clean(s: string): string {
  return s.replace(/[\s,]+/g, ' ').trim();
}

function studyColumns(input: BriefInput): Column[] {
  const out: Column[] = [];
  for (const study of input.studies ?? []) {
    const title = clean(study.title);
    for (const o of study.outputs) {
      const name = clean(o.name);
      const label =
        study.outputs.length === 1 || !name || name === title ? title : `${title}: ${name}`;
      out.push({ label, values: o.values });
    }
  }
  return out;
}

/** CSV rows for bars `a..b`, `bucket` bars per row (OHLCV aggregated, studies at row end). */
function csv(ctx: Ctx, a: number, b: number, bucket: number, withStudies: boolean): string[] {
  const { input, decimals, fmtTime } = ctx;
  const bars = input.bars;
  const cols = withStudies ? ctx.columns : [];
  const header = ['time', 'open', 'high', 'low', 'close', 'volume', ...cols.map((c) => c.label)];
  const lines = [header.join(',')];
  for (let s = a; s <= b; s += bucket) {
    const e = Math.min(b, s + bucket - 1);
    let h = -Infinity;
    let l = Infinity;
    let v = 0;
    let hasV = false;
    for (let i = s; i <= e; i++) {
      h = Math.max(h, at(bars.high, i));
      l = Math.min(l, at(bars.low, i));
      const vi = at(bars.volume, i);
      if (Number.isFinite(vi)) {
        v += vi;
        hasV = true;
      }
    }
    lines.push(
      [
        fmtTime(at(bars.time, s)),
        fmtPrice(at(bars.open, s), decimals),
        fmtPrice(h, decimals),
        fmtPrice(l, decimals),
        fmtPrice(at(bars.close, e), decimals),
        hasV && v > 0 ? fmtCompact(v) : '',
        ...cols.map((c) => fmtValue(at(c.values, e))),
      ].join(','),
    );
  }
  return lines;
}

function point(ctx: Ctx, p: PricePoint | null): string {
  return p ? `${fmtPrice(p.price, ctx.decimals)} on ${ctx.fmtTime(p.time)}` : 'n/a';
}

function statsLines(ctx: Ctx, s: FocusStats): string[] {
  const d = ctx.decimals;
  const t = ctx.fmtTime;
  const lines = [
    `Open ${fmtPrice(s.open, d)} -> close ${fmtPrice(s.close, d)} (${fmtPct(s.changePct)}, ${s.change >= 0 ? '+' : ''}${fmtPrice(s.change, d)})`,
    `High ${point(ctx, s.high)}; low ${point(ctx, s.low)}; high-low range ${fmtPct(((s.high.price - s.low.price) / s.low.price) * 100, false)} of the low`,
    `Up bars ${s.upBars}, down bars ${s.downBars}` +
      (s.largestUp ? `; biggest gain ${fmtPct(s.largestUpPct)} on ${t(s.largestUp.time)}` : '') +
      (s.largestDown
        ? `; biggest drop ${fmtPct(s.largestDownPct)} on ${t(s.largestDown.time)}`
        : ''),
  ];
  const vol: string[] = [];
  if (s.volatilityPct !== null) vol.push(`bar-to-bar volatility ${fmtPct(s.volatilityPct, false)}`);
  if (s.atr !== null) {
    vol.push(
      `ATR(14) at end ${fmtPrice(s.atr, d)} (${fmtPct((s.atr / s.close) * 100, false)} of close)`,
    );
  }
  if (s.slope !== null && s.r2 !== null) {
    vol.push(
      `linear trend ${s.slope >= 0 ? '+' : ''}${fmtPrice(s.slope, d)} per bar (R² ${s.r2.toFixed(2)})`,
    );
  }
  if (vol.length) lines.push(vol.join('; '));
  if (s.avgVolume !== null) {
    lines.push(
      `Average volume ${fmtCompact(s.avgVolume)}` +
        (s.volumeVsPrior !== null
          ? ` (${s.volumeVsPrior.toFixed(2)}x the same number of bars before)`
          : '') +
        (s.maxVolume ? `; highest ${fmtCompact(s.maxVolume.price)} on ${t(s.maxVolume.time)}` : ''),
    );
  }
  const sw = (pts: readonly PricePoint[]): string =>
    pts.map((p) => `${t(p.time)} ${fmtPrice(p.price, d)}`).join(', ');
  if (s.swingHighs.length) lines.push(`Swing highs: ${sw(s.swingHighs)}`);
  if (s.swingLows.length) lines.push(`Swing lows: ${sw(s.swingLows)}`);
  if (s.priorChangePct !== null)
    lines.push(`Before the focus: ${fmtPct(s.priorChangePct)} over the preceding bars`);
  lines.push(
    s.barsAfter > 0
      ? `After the focus: ${s.barsAfter} more bars on the chart, ${fmtPct(s.afterChangePct)} from the focus close to the latest close`
      : 'The focus ends at the latest bar on the chart',
  );
  return lines;
}

function render(ctx: Ctx, stats: FocusStats, p: Params): { text: string; bucket: number } {
  const { input, fmtTime, a, b } = ctx;
  const bars = input.bars;
  const n = b - a + 1;
  const out: string[] = [BRIEF_START];
  const who = input.name ? `${input.symbol} (${clean(input.name)})` : input.symbol;
  out.push(`Symbol: ${who}; interval: ${input.interval}; times in ${input.timezone}`);
  out.push(
    `Focus: ${input.focus.kind === 'selection' ? 'user selection' : 'visible range'} ` +
      `${fmtTime(at(bars.time, a))} to ${fmtTime(at(bars.time, b))} (${n} bars)`,
  );
  out.push(
    `Data on chart: ${fmtTime(at(bars.time, 0))} to ${fmtTime(at(bars.time, bars.length - 1))} ` +
      `(${bars.length} bars); latest close ${fmtPrice(at(bars.close, bars.length - 1), ctx.decimals)}`,
  );

  for (const note of input.notes ?? []) out.push(`Note: ${note}`);

  out.push('', 'FOCUS STATS', ...statsLines(ctx, stats));

  const leadStart = Math.max(0, a - p.leadBars);
  if (p.leadBars > 0 && p.leadRows > 0 && leadStart < a) {
    const leadN = a - leadStart;
    const bucket = Math.max(1, Math.ceil(leadN / p.leadRows));
    out.push(
      '',
      `BEFORE FOCUS (${leadN} bars${bucket > 1 ? `, ${bucket} bars per row` : ''})`,
      ...csv(ctx, leadStart, a - 1, bucket, false),
    );
  }

  const bucket = Math.max(1, Math.ceil(n / p.maxFocusRows));
  const withStudies = p.studyColumns && ctx.columns.length > 0;
  out.push(
    '',
    `FOCUS BARS (${n} bars${bucket > 1 ? `, ${bucket} bars per row: open of the first, high/low of all, close and indicators of the last, volume summed` : ''})`,
    ...csv(ctx, a, b, bucket, withStudies),
  );

  if (ctx.columns.length) {
    out.push('', `INDICATORS at focus end (${fmtTime(at(bars.time, b))})`);
    for (const c of ctx.columns) {
      const v = fmtValue(at(c.values, b));
      out.push(`${c.label}: ${v || 'no value'}`);
    }
  }

  const drawings = (input.drawings ?? []).filter((dr) => {
    const times = dr.points.map((pt) => pt.time);
    if (!times.length) return false;
    // Horizontal tools carry one point; keep them whatever its time.
    if (dr.type.includes('horizontal')) return true;
    return Math.max(...times) >= at(bars.time, leadStart) && Math.min(...times) <= at(bars.time, b);
  });
  if (drawings.length) {
    out.push('', 'USER DRAWINGS near the focus');
    for (const dr of drawings.slice(0, p.maxDrawings)) {
      // Freehand tools carry many points: keep the first and last.
      const many = dr.points.length > MAX_POINTS;
      const shown = many ? [dr.points[0]!, dr.points[dr.points.length - 1]!] : dr.points;
      const pts = shown
        .map((pt) =>
          dr.type.includes('horizontal')
            ? fmtPrice(pt.price, ctx.decimals)
            : `${fmtTime(pt.time)} ${fmtPrice(pt.price, ctx.decimals)}`,
        )
        .join(' -> ');
      const extra = many ? ` (${dr.points.length} points)` : '';
      const text = dr.text ? ` "${clean(dr.text).slice(0, 80)}"` : '';
      out.push(`- ${dr.type}: ${pts}${extra}${text}`);
    }
    if (drawings.length > p.maxDrawings)
      out.push(`- (${drawings.length - p.maxDrawings} more not shown)`);
  }

  out.push(BRIEF_END);
  return { text: out.join('\n'), bucket };
}

/** Steps tried in order until the brief fits the token budget. */
function reductions(base: Params): [string, Params][] {
  const steps: [string, Params][] = [['', base]];
  let p = base;
  const push = (label: string, next: Partial<Params>): void => {
    p = { ...p, ...next };
    steps.push([label, p]);
  };
  for (const rows of [150, 100, 60]) {
    if (rows < p.maxFocusRows) push(`focus rows ${rows}`, { maxFocusRows: rows });
  }
  push('lead-in 10 rows', { leadRows: Math.min(p.leadRows, 10) });
  push('no indicator columns', { studyColumns: false });
  push('focus rows 30', { maxFocusRows: Math.min(p.maxFocusRows, 30) });
  push('no lead-in', { leadRows: 0 });
  push('drawings 5', { maxDrawings: 5 });
  return steps;
}

/** The chart context for a question, as text for the model plus its statistics. */
export function buildChartBrief(input: BriefInput, options: BriefOptions = {}): ChartBrief {
  const opts = { ...DEFAULTS, ...options };
  const bars = input.bars;
  const range = bars.length ? rangeIndexes(bars, input.focus.from, input.focus.to) : null;
  if (!range) {
    const text = [
      BRIEF_START,
      `Symbol: ${input.symbol}; interval: ${input.interval}`,
      'No bars in the focus range.',
      BRIEF_END,
    ].join('\n');
    return {
      text,
      stats: null,
      approxTokens: approxTokens(text),
      focusBars: 0,
      focusBucket: 1,
      trimmed: [],
    };
  }
  const [a, b] = range;
  const ctx: Ctx = {
    input,
    decimals: input.pricePrecision ?? inferPrecision(bars.close),
    fmtTime: timeFormatter(input.timezone, isIntraday(bars.time)),
    columns: studyColumns(input),
    a,
    b,
  };
  const stats = focusStats(bars, a, b);
  const base: Params = {
    maxFocusRows: Math.max(1, opts.maxFocusRows),
    leadBars: Math.max(0, opts.leadBars),
    leadRows: Math.max(0, opts.leadRows),
    studyColumns: true,
    maxDrawings: MAX_DRAWINGS,
  };
  const trimmed: string[] = [];
  let result = render(ctx, stats, base);
  for (const [label, params] of reductions(base).slice(1)) {
    if (approxTokens(result.text) <= opts.maxTokens) break;
    trimmed.push(label);
    result = render(ctx, stats, params);
  }
  return {
    text: result.text,
    stats,
    approxTokens: approxTokens(result.text),
    focusBars: b - a + 1,
    focusBucket: result.bucket,
    trimmed,
  };
}
