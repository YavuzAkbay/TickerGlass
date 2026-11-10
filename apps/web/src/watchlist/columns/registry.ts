/**
 * The one definition of every watchlist column. The sidebar panel
 * (sidebar/watchlist/columns.ts) and the full-screen page
 * (watchlist/page/pageColumns.tsx) are thin views over this table: header
 * labels, widths, sort accessors, cell formatting and CSV values all live here.
 *
 * Pure data and functions (no React): cells describe themselves as text plus an
 * optional range bar, and the row components draw them (ColumnCell.tsx).
 */
import type { LiveQuote } from '../../quotes/types';
import type { SnapshotRow } from '../../screener/server/snapshot';
import {
  changeClass,
  currencyPrefix,
  fmtAuto,
  fmtCap,
  fmtCompact,
  fmtMultiple,
  fmtPrice,
  fmtSigned,
  isNum,
} from '../../sidebar/format';
import type { SymbolMeta } from '../model';
import type { ColumnId } from '../types';

export type Surface = 'sidebar' | 'page';

/** Quote fields that only some data sources provide (null = the source has none). */
export type QuoteField =
  'open' | 'fiftyTwoWeekHigh' | 'fiftyTwoWeekLow' | 'marketCap' | 'averageVolume';

/** Position marker of a range cell: `pos` 0..1 (null = no range), tinted by `tone`. */
export interface RangeBarData {
  pos: number | null;
  tone: '' | 'up' | 'down';
}

export interface CellValue {
  text: string;
  /** Extra class (`up` / `down` / `hot`). */
  className?: string;
  /** Tooltip. */
  title?: string;
  /** Draw a range bar instead of text. */
  bar?: RangeBarData;
}

export interface ColumnCtx {
  q: LiveQuote | undefined;
  meta: SymbolMeta | undefined;
  /** The symbol's nightly server-screener snapshot row (undefined: not loaded or not tracked). */
  snap?: SnapshotRow | undefined;
  surface: Surface;
}

export type CsvValue = string | number | null;

export interface ColumnDef {
  id: ColumnId;
  /** Long name: columns menu and tooltips. */
  label: string;
  /** Header text. */
  short: string;
  align: 'left' | 'right';
  /** Grid track per surface. */
  width: Record<Surface, string>;
  surfaces: readonly Surface[];
  /** Quote fields the column needs; it shows "not provided" when a source gives none of the rows any. */
  requires?: readonly QuoteField[];
  /** Values come from the server screener's snapshot, not the live quote (opt-in column). */
  snapshot?: true;
  sortable: boolean;
  /** Sort value (nulls sort last in both directions). */
  accessor: (
    q: LiveQuote | undefined,
    meta: SymbolMeta | undefined,
    snap?: SnapshotRow,
  ) => number | string | null;
  cell: (ctx: ColumnCtx) => CellValue;
  csv: {
    headers: readonly string[];
    values: (
      q: LiveQuote | undefined,
      meta: SymbolMeta | undefined,
      snap?: SnapshotRow,
    ) => CsvValue[];
  };
}

// ------------------------------------------------------------ derived values

const num = (v: number | null | undefined): number | null => (isNum(v) ? v : null);

/** Valid low/high pair, or null. */
function bounds(
  low: number | null | undefined,
  high: number | null | undefined,
): { low: number; high: number } | null {
  return isNum(low) && isNum(high) && high > low ? { low, high } : null;
}

function position(
  last: number | null | undefined,
  b: { low: number; high: number } | null,
): number | null {
  if (!b || !isNum(last)) return null;
  return Math.max(0, Math.min(1, (last - b.low) / (b.high - b.low)));
}

export const dayBounds = (q: LiveQuote | undefined) => bounds(q?.dayLow, q?.dayHigh);
export const week52Bounds = (q: LiveQuote | undefined) =>
  bounds(q?.fiftyTwoWeekLow, q?.fiftyTwoWeekHigh);

/** Where the last price sits in the day's range, 0..1. */
export const dayPosition = (q: LiveQuote | undefined): number | null =>
  position(q?.last, dayBounds(q));

/** Where the last price sits in the 52-week range, 0..1. */
export const week52Position = (q: LiveQuote | undefined): number | null =>
  position(q?.last, week52Bounds(q));

/** Percent below the 52-week high (<= 0 unless the high is stale). */
export function pctFrom52High(q: LiveQuote | undefined): number | null {
  const high = q?.fiftyTwoWeekHigh;
  if (!isNum(high) || high <= 0 || !isNum(q?.last)) return null;
  return ((q.last - high) / high) * 100;
}

/** Today's volume over the average daily volume. */
export function relativeVolume(q: LiveQuote | undefined): number | null {
  const avg = q?.averageVolume;
  if (!isNum(avg) || avg <= 0 || !isNum(q?.volume)) return null;
  return q.volume / avg;
}

/** Opening gap: (open - previous close) / previous close, in percent. */
export function gapPercent(q: LiveQuote | undefined): number | null {
  if (!isNum(q?.open) || !isNum(q?.prevClose) || q.prevClose === 0) return null;
  return ((q.open - q.prevClose) / q.prevClose) * 100;
}

/** Relative volume at which the cell is highlighted. */
export const REL_VOLUME_HOT = 2;

// ------------------------------------------------------------ snapshot values

/** Numeric snapshot field (null when missing, not a number or not finite). */
export function snapNum(snap: SnapshotRow | undefined, field: string): number | null {
  const v = snap?.[field];
  return isNum(v as number | null | undefined) ? (v as number) : null;
}

/** RSI below this reads oversold, above `RSI_OVERBOUGHT` overbought. */
export const RSI_OVERSOLD = 30;
export const RSI_OVERBOUGHT = 70;
/** An earnings date this many days away or sooner is highlighted. */
export const EARNINGS_SOON_DAYS = 7;

const DAY_S = 86_400;

/** Whole days from `nowMs` to the earnings time `ts` (unix seconds), by UTC calendar day. */
export function daysUntil(ts: number, nowMs = Date.now()): number {
  return Math.floor(ts / DAY_S) - Math.floor(nowMs / 1000 / DAY_S);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jan 30" (UTC calendar day of the timestamp). */
function shortDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Tooltip of an earnings date: "in 3 days", "today", "2 days ago". */
export function earningsTitle(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'in 1 day';
  if (days > 1) return `in ${days} days`;
  return days === -1 ? '1 day ago' : `${-days} days ago`;
}

/** RSI cell: the value with a direction marker in the extremes (never colour alone). */
function rsiCell(v: number | null): CellValue {
  if (v === null) return { text: '—' };
  const text = v.toFixed(1);
  if (v < RSI_OVERSOLD)
    return {
      text: `↓ ${text}`,
      className: 'down',
      title: `RSI(14) ${text}: oversold (below ${RSI_OVERSOLD})`,
    };
  if (v > RSI_OVERBOUGHT)
    return {
      text: `↑ ${text}`,
      className: 'up',
      title: `RSI(14) ${text}: overbought (above ${RSI_OVERBOUGHT})`,
    };
  return { text, title: `RSI(14) ${text}` };
}

function earningsCell(ts: number | null): CellValue {
  if (ts === null) return { text: '—' };
  const days = daysUntil(ts);
  const soon = days >= 0 && days <= EARNINGS_SOON_DAYS;
  return {
    text: shortDate(ts),
    title: earningsTitle(days),
    ...(soon ? { className: 'hot' } : {}),
  };
}

/** Percent snapshot cell, signed and tinted. */
function snapPctCell(v: number | null, title: string): CellValue {
  return { text: fmtSigned(v, 2, '%'), className: changeClass(v), title };
}

/** Single-header CSV column from a snapshot number. */
const csvSnap = (header: string, field: string) => ({
  headers: [header] as const,
  values: (_q: LiveQuote | undefined, _meta: SymbolMeta | undefined, snap?: SnapshotRow) => [
    csvDerived(snapNum(snap, field)),
  ],
});

/** Snapshot-backed percent columns (performance, distance from the 200-day average). */
const snapPct = (
  id: ColumnId,
  field: string,
  label: string,
  short: string,
  csvHeader: string,
  title: string,
): ColumnDef => ({
  id,
  label,
  short,
  align: 'right',
  width: wide('minmax(54px, 0.9fr)', 'minmax(66px, 0.9fr)'),
  surfaces: BOTH,
  snapshot: true,
  sortable: true,
  accessor: (_q, _m, snap) => snapNum(snap, field),
  cell: ({ snap }) => snapPctCell(snapNum(snap, field), title),
  csv: csvSnap(csvHeader, field),
});

// ------------------------------------------------------------ cells

/** A price cell; the page marks prices of non-USD quotes with their currency symbol. */
function priceText(v: number | null | undefined, ctx: ColumnCtx): string {
  if (!isNum(v)) return '—';
  return (ctx.surface === 'page' ? currencyPrefix(ctx.q?.currency) : '') + fmtAuto(v);
}

const rangeTitle = (b: { low: number; high: number } | null): string | undefined =>
  b ? `${fmtPrice(b.low)} – ${fmtPrice(b.high)}` : undefined;

const csvNum = (v: number | null | undefined): CsvValue => (isNum(v) ? v : null);
/** Derived ratios: trimmed so spreadsheets do not show float noise. */
const csvDerived = (v: number | null): CsvValue => (v === null ? null : Number(v.toFixed(6)));

/** Single-header numeric CSV column. */
const csv1 = (header: string, get: (q: LiveQuote | undefined) => number | null | undefined) => ({
  headers: [header] as const,
  values: (q: LiveQuote | undefined): CsvValue[] => [csvNum(get(q))],
});

const wide = (sidebar: string, page: string): Record<Surface, string> => ({ sidebar, page });
const BOTH: readonly Surface[] = ['sidebar', 'page'];
const PAGE: readonly Surface[] = ['page'];

/** Canonical display order. */
export const COLUMN_LIST: readonly ColumnDef[] = [
  {
    id: 'name',
    label: 'Company name',
    short: 'Name',
    align: 'left',
    width: wide('minmax(80px, 2fr)', 'minmax(110px, 2.2fr)'),
    surfaces: PAGE,
    sortable: true,
    accessor: (_q, meta) => meta?.name ?? null,
    // The row draws it (it triggers the lazy name lookup); this is the fallback text.
    cell: ({ meta }) => ({ text: meta?.name ?? '', className: 'wlp-name' }),
    csv: { headers: ['Name'], values: (_q, meta) => [meta?.name ?? ''] },
  },
  {
    id: 'last',
    label: 'Last price',
    short: 'Last',
    align: 'right',
    width: wide('minmax(54px, 1fr)', 'minmax(64px, 1fr)'),
    surfaces: BOTH,
    sortable: true,
    accessor: (q) => num(q?.last),
    cell: (ctx) => ({ text: ctx.q ? priceText(ctx.q.last, ctx) : '—' }),
    csv: csv1('Last', (q) => q?.last),
  },
  {
    id: 'change',
    label: 'Change',
    short: 'Chg',
    align: 'right',
    width: wide('minmax(50px, 0.9fr)', 'minmax(60px, 0.9fr)'),
    surfaces: BOTH,
    sortable: true,
    accessor: (q) => num(q?.change),
    cell: ({ q }) => ({ text: q ? fmtSigned(q.change) : '', className: changeClass(q?.change) }),
    csv: csv1('Change', (q) => q?.change),
  },
  {
    id: 'changePercent',
    label: 'Change %',
    short: 'Chg%',
    align: 'right',
    width: wide('minmax(56px, 0.9fr)', 'minmax(64px, 0.9fr)'),
    surfaces: BOTH,
    sortable: true,
    accessor: (q) => num(q?.changePercent),
    cell: ({ q }) => ({
      text: q ? fmtSigned(q.changePercent, 2, '%') : '',
      className: changeClass(q?.changePercent),
    }),
    csv: csv1('Change %', (q) => q?.changePercent),
  },
  {
    id: 'volume',
    label: 'Volume',
    short: 'Volume',
    align: 'right',
    width: wide('minmax(52px, 0.9fr)', 'minmax(64px, 0.9fr)'),
    surfaces: BOTH,
    sortable: true,
    accessor: (q) => num(q?.volume),
    cell: ({ q }) => ({ text: q ? fmtCompact(q.volume) : '' }),
    csv: csv1('Volume', (q) => q?.volume),
  },
  {
    id: 'extPrice',
    label: 'Pre/post-market price',
    short: 'Ext',
    align: 'right',
    width: wide('minmax(54px, 1fr)', 'minmax(64px, 1fr)'),
    surfaces: BOTH,
    sortable: true,
    accessor: (q) => num(q?.ext?.price),
    cell: (ctx) => ({ text: ctx.q?.ext ? priceText(ctx.q.ext.price, ctx) : '' }),
    csv: csv1('Ext Price', (q) => q?.ext?.price),
  },
  {
    id: 'extChangePercent',
    label: 'Pre/post-market change %',
    short: 'Ext%',
    align: 'right',
    width: wide('minmax(56px, 0.9fr)', 'minmax(64px, 0.9fr)'),
    surfaces: BOTH,
    sortable: true,
    accessor: (q) => num(q?.ext?.changePercent),
    cell: ({ q }) => ({
      text: q?.ext ? fmtSigned(q.ext.changePercent, 2, '%') : '',
      className: changeClass(q?.ext?.changePercent),
    }),
    csv: csv1('Ext Change %', (q) => q?.ext?.changePercent),
  },
  {
    id: 'open',
    label: 'Open',
    short: 'Open',
    align: 'right',
    width: wide('minmax(54px, 1fr)', 'minmax(64px, 1fr)'),
    surfaces: BOTH,
    requires: ['open'],
    sortable: true,
    accessor: (q) => num(q?.open),
    cell: (ctx) => ({ text: ctx.q ? priceText(ctx.q.open, ctx) : '' }),
    csv: csv1('Open', (q) => q?.open),
  },
  {
    id: 'gapPercent',
    label: 'Gap % (open vs previous close)',
    short: 'Gap%',
    align: 'right',
    width: wide('minmax(52px, 0.9fr)', 'minmax(64px, 0.9fr)'),
    surfaces: BOTH,
    requires: ['open'],
    sortable: true,
    accessor: gapPercent,
    cell: ({ q }) => {
      const g = gapPercent(q);
      return { text: q ? fmtSigned(g, 2, '%') : '', className: changeClass(g) };
    },
    csv: { headers: ['Gap %'], values: (q) => [csvDerived(gapPercent(q))] },
  },
  {
    id: 'relVolume',
    label: 'Relative volume (vs average)',
    short: 'Rel vol',
    align: 'right',
    width: wide('minmax(48px, 0.8fr)', 'minmax(64px, 0.8fr)'),
    surfaces: BOTH,
    requires: ['averageVolume'],
    sortable: true,
    accessor: relativeVolume,
    cell: ({ q }) => {
      const rv = relativeVolume(q);
      if (!q) return { text: '' };
      return {
        text: fmtMultiple(rv),
        ...(rv !== null && rv >= REL_VOLUME_HOT ? { className: 'hot' } : {}),
        ...(rv !== null
          ? { title: `${fmtCompact(q.volume)} vs average ${fmtCompact(q.averageVolume)}` }
          : {}),
      };
    },
    csv: { headers: ['Relative Volume'], values: (q) => [csvDerived(relativeVolume(q))] },
  },
  {
    id: 'avgVolume',
    label: 'Average volume',
    short: 'Avg vol',
    align: 'right',
    width: wide('minmax(52px, 0.9fr)', 'minmax(64px, 0.9fr)'),
    surfaces: BOTH,
    requires: ['averageVolume'],
    sortable: true,
    accessor: (q) => num(q?.averageVolume),
    cell: ({ q }) => ({ text: q ? fmtCompact(q.averageVolume) : '' }),
    csv: csv1('Avg Volume', (q) => q?.averageVolume),
  },
  {
    id: 'marketCap',
    label: 'Market cap (USD)',
    short: 'Mkt cap',
    align: 'right',
    width: wide('minmax(56px, 0.9fr)', 'minmax(72px, 0.9fr)'),
    surfaces: BOTH,
    requires: ['marketCap'],
    sortable: true,
    accessor: (q) => num(q?.marketCap),
    cell: ({ q }) => ({ text: q ? fmtCap(q.marketCap) : '' }),
    csv: csv1('Market Cap', (q) => q?.marketCap),
  },
  {
    id: 'dayRange',
    label: 'Day range',
    short: 'Range',
    align: 'right',
    width: wide('minmax(70px, 1.2fr)', 'minmax(72px, 1.1fr)'),
    surfaces: PAGE,
    sortable: false,
    accessor: () => null,
    cell: ({ q }) => {
      const b = dayBounds(q);
      const title = rangeTitle(b);
      return {
        text: '',
        bar: { pos: dayPosition(q), tone: changeClass(q?.changePercent) as RangeBarData['tone'] },
        ...(title ? { title } : {}),
      };
    },
    csv: {
      headers: ['Day Low', 'Day High'],
      values: (q) => [csvNum(q?.dayLow), csvNum(q?.dayHigh)],
    },
  },
  {
    id: 'week52Range',
    label: '52-week range',
    short: '52W',
    align: 'right',
    width: wide('56px', 'minmax(80px, 1.1fr)'),
    surfaces: BOTH,
    requires: ['fiftyTwoWeekHigh', 'fiftyTwoWeekLow'],
    sortable: true,
    accessor: week52Position,
    cell: ({ q }) => {
      const b = week52Bounds(q);
      const title = b ? `52W ${rangeTitle(b)}` : undefined;
      return {
        text: '',
        bar: {
          pos: week52Position(q),
          tone: changeClass(q?.changePercent) as RangeBarData['tone'],
        },
        ...(title ? { title } : {}),
      };
    },
    csv: {
      headers: ['52W Low', '52W High'],
      values: (q) => [csvNum(q?.fiftyTwoWeekLow), csvNum(q?.fiftyTwoWeekHigh)],
    },
  },
  {
    id: 'pctFrom52High',
    label: '% from 52-week high',
    short: '% 52W hi',
    align: 'right',
    width: wide('minmax(54px, 0.9fr)', 'minmax(70px, 0.9fr)'),
    surfaces: BOTH,
    requires: ['fiftyTwoWeekHigh'],
    sortable: true,
    accessor: pctFrom52High,
    cell: ({ q }) => ({ text: q ? fmtSigned(pctFrom52High(q), 2, '%') : '' }),
    csv: { headers: ['% From 52W High'], values: (q) => [csvDerived(pctFrom52High(q))] },
  },
  snapPct(
    'perf1m',
    'perf1m',
    '1-month performance',
    '1M%',
    '1M Performance %',
    '1-month performance',
  ),
  snapPct(
    'perfYtd',
    'perfYtd',
    'Year-to-date performance',
    'YTD%',
    'YTD Performance %',
    'Year to date',
  ),
  snapPct(
    'perf1y',
    'perf1y',
    '1-year performance',
    '1Y%',
    '1Y Performance %',
    '1-year performance',
  ),
  {
    id: 'rsi14',
    label: 'RSI (14-day)',
    short: 'RSI',
    align: 'right',
    width: wide('minmax(50px, 0.8fr)', 'minmax(62px, 0.8fr)'),
    surfaces: BOTH,
    snapshot: true,
    sortable: true,
    accessor: (_q, _m, snap) => snapNum(snap, 'rsi14'),
    cell: ({ snap }) => rsiCell(snapNum(snap, 'rsi14')),
    csv: csvSnap('RSI 14', 'rsi14'),
  },
  snapPct(
    'pctVsSma200',
    'pctVsSma200',
    '% vs 200-day average',
    '% SMA200',
    '% vs SMA200',
    'Distance from the 200-day simple moving average',
  ),
  {
    id: 'nextEarnings',
    label: 'Next earnings',
    short: 'Earnings',
    align: 'right',
    width: wide('minmax(56px, 0.9fr)', 'minmax(70px, 0.9fr)'),
    surfaces: BOTH,
    snapshot: true,
    sortable: true,
    accessor: (_q, _m, snap) => snapNum(snap, 'nextEarnings'),
    cell: ({ snap }) => earningsCell(snapNum(snap, 'nextEarnings')),
    csv: {
      headers: ['Next Earnings'],
      values: (_q, _m, snap) => {
        const ts = snapNum(snap, 'nextEarnings');
        return [ts === null ? null : new Date(ts * 1000).toISOString().slice(0, 10)];
      },
    },
  },
  {
    id: 'trend',
    label: '30-day trend',
    short: 'Trend',
    align: 'right',
    width: wide('50px', '96px'),
    surfaces: BOTH,
    sortable: false,
    accessor: () => null,
    // Drawn by `Sparkline` in the row.
    cell: () => ({ text: '' }),
    csv: { headers: [], values: () => [] },
  },
];

export const COLUMN_DEFS = Object.fromEntries(COLUMN_LIST.map((d) => [d.id, d])) as Record<
  ColumnId,
  ColumnDef
>;

/** Columns backed by the server screener's snapshot (opt-in; they fetch only while visible). */
export const SNAPSHOT_COLUMNS: readonly ColumnId[] = COLUMN_LIST.filter((d) => d.snapshot).map(
  (d) => d.id,
);
export const isSnapshotColumn = (id: string): boolean => SNAPSHOT_COLUMNS.includes(id as ColumnId);

export const isColumnId = (v: unknown): v is ColumnId =>
  typeof v === 'string' && Object.hasOwn(COLUMN_DEFS, v);

/** Columns a surface offers, in canonical order. */
export const columnsFor = (surface: Surface): ColumnId[] =>
  COLUMN_LIST.filter((d) => d.surfaces.includes(surface)).map((d) => d.id);

export const SIDEBAR_COLUMNS: readonly ColumnId[] = columnsFor('sidebar');
export const PAGE_COLUMN_IDS: readonly ColumnId[] = columnsFor('page');
export const columnIdsOf = (surface: Surface): readonly ColumnId[] =>
  surface === 'page' ? PAGE_COLUMN_IDS : SIDEBAR_COLUMNS;

/** Ids a surface can sort by (the symbol is always sortable too). */
export const sortableFor = (surface: Surface): ColumnId[] =>
  COLUMN_LIST.filter((d) => d.sortable && d.surfaces.includes(surface)).map((d) => d.id);

/**
 * Validate a stored column list for `surface`: unknown or foreign ids and
 * repeats are dropped, the stored order is kept (the page lets users reorder).
 */
export function normalizeColumns(v: unknown, surface: Surface): ColumnId[] {
  if (!Array.isArray(v)) return [];
  const allowed = columnIdsOf(surface);
  const seen = new Set<ColumnId>();
  for (const c of v) if (isColumnId(c) && allowed.includes(c)) seen.add(c);
  return [...seen];
}

/** Validate a stored column list for `surface` and put it in canonical order (the sidebar's fixed order). */
export function canonicalColumns(v: unknown, surface: Surface): ColumnId[] {
  const keep = new Set(normalizeColumns(v, surface));
  return columnIdsOf(surface).filter((c) => keep.has(c));
}

/** `columns` with `id` toggled; a new column lands after its canonical predecessor. */
export function toggleInOrder(
  columns: readonly ColumnId[],
  id: ColumnId,
  surface: Surface,
): ColumnId[] {
  if (columns.includes(id)) return columns.filter((c) => c !== id);
  const canon = columnIdsOf(surface);
  const rank = canon.indexOf(id);
  if (rank < 0) return [...columns];
  let at = 0;
  columns.forEach((c, i) => {
    if (canon.indexOf(c) < rank) at = i + 1;
  });
  return [...columns.slice(0, at), id, ...columns.slice(at)];
}

/** Move the column at `id` to `to` (index in the resulting list); no-op if unknown. */
export function moveColumn(columns: readonly ColumnId[], id: ColumnId, to: number): ColumnId[] {
  const from = columns.indexOf(id);
  if (from < 0) return [...columns];
  const out = columns.filter((c) => c !== id);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, id);
  return out;
}

// ------------------------------------------------------------ availability

/** Snapshot-backed quotes that must all lack a field before its column counts as unavailable. */
export const MIN_UNAVAILABLE_SAMPLE = 3;

/**
 * True when `def` can show nothing for these quotes: at least
 * `MIN_UNAVAILABLE_SAMPLE` snapshot-backed quotes, all missing a field the
 * column requires (one symbol lacking data, e.g. an index without a market cap,
 * says nothing about the source). A quote that has not had a snapshot yet (no
 * previous close; ticks alone never carry these extras) is not counted either,
 * so the column stays "pending", not unavailable.
 */
export function isUnavailable(def: ColumnDef, quotes: Iterable<LiveQuote | undefined>): boolean {
  const need = def.requires;
  if (!need?.length) return false;
  let seen = 0;
  for (const q of quotes) {
    if (!q || q.prevClose == null) continue;
    seen++;
    if (!need.some((f) => q[f] == null)) return false;
  }
  return seen >= MIN_UNAVAILABLE_SAMPLE;
}

/** Columns among `columns` that no quote can fill. */
export function unavailableColumns(
  columns: readonly ColumnId[],
  quotes: readonly (LiveQuote | undefined)[],
): ColumnId[] {
  return columns.filter((c) => isUnavailable(COLUMN_DEFS[c], quotes));
}
