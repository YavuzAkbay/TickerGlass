/**
 * Columns of the results table in server mode: the quote-driven ones of the
 * client table plus snapshot fields, plus up to three formula columns (`"=<formula>"`,
 * design doc section 10). Pure id tables (the cell renderers live in `columnDefs.tsx`).
 */
import {
  codePoints,
  FORMULA_FIELD_PREFIX,
  FORMULA_MAX_LENGTH,
  formulaSyntaxOk,
  MAX_FORMULA_FIELDS,
} from '../rules/formula';

/** Snapshot-backed columns (id = server field id). */
export const SNAPSHOT_COLUMNS = [
  'relVol',
  'perf1w',
  'perf1m',
  'perfYtd',
  'perf1y',
  'rsi14',
  'pctVsSma200',
  'atrPct',
  'pctOffHi52',
  'mcap',
  'pe',
  'divYield',
  'nextEarnings',
  'daysToEarnings',
  'sector',
] as const;

/** Every column of the server table, in canonical display order. */
export const SERVER_ALL_COLUMNS = [
  'name',
  'last',
  'change',
  'changePercent',
  'volume',
  'dayRange',
  'week52Range',
  'relVol',
  'perf1w',
  'perf1m',
  'perfYtd',
  'perf1y',
  'rsi14',
  'pctVsSma200',
  'atrPct',
  'pctOffHi52',
  'mcap',
  'pe',
  'divYield',
  'nextEarnings',
  'daysToEarnings',
  'sector',
  'group',
  'exchange',
  'trend',
] as const;

export type ServerColumnId = (typeof SERVER_ALL_COLUMNS)[number];

export const DEFAULT_SERVER_COLUMNS: ServerColumnId[] = [
  'name',
  'last',
  'changePercent',
  'volume',
  'relVol',
  'perf1m',
  'rsi14',
  'mcap',
  'trend',
];

/** A formula column: `"=" + formula`, the scan returns its value under the same key. */
export type FormulaColumnId = `=${string}`;

/** Any column of the server table. */
export type ServerColumn = ServerColumnId | FormulaColumnId;

/** Most formula columns at once (the server's `fields` limit). */
export const MAX_FORMULA_COLUMNS = MAX_FORMULA_FIELDS;

/** A well-formed formula column id (grammar and limits; the field ids are checked by the server). */
export const isFormulaColumn = (v: unknown): v is FormulaColumnId =>
  typeof v === 'string' &&
  v.startsWith(FORMULA_FIELD_PREFIX) &&
  // Cheap bound before counting: a code point is at most two UTF-16 units.
  v.length <= (FORMULA_MAX_LENGTH + 1) * 2 &&
  codePoints(v) <= FORMULA_MAX_LENGTH + 1 &&
  formulaSyntaxOk(v.slice(FORMULA_FIELD_PREFIX.length));

/** The column id of a formula (trimmed). */
export const formulaColumnId = (formula: string): FormulaColumnId =>
  `${FORMULA_FIELD_PREFIX}${formula.trim()}`;

/** The formula text of a formula column id. */
export const formulaOfColumn = (id: FormulaColumnId): string =>
  id.slice(FORMULA_FIELD_PREFIX.length);

export const isServerColumn = (v: unknown): v is ServerColumn =>
  (typeof v === 'string' && (SERVER_ALL_COLUMNS as readonly string[]).includes(v)) ||
  isFormulaColumn(v);

/**
 * Stored or loaded columns, cleaned: the fixed ones in canonical order, then the valid formula
 * columns in their own order (deduplicated, at most `MAX_FORMULA_COLUMNS`).
 */
export function normalizeServerColumns(v: readonly unknown[]): ServerColumn[] {
  const set = new Set(v);
  const fixed = SERVER_ALL_COLUMNS.filter((c) => set.has(c));
  const formulas: FormulaColumnId[] = [];
  for (const c of v)
    if (isFormulaColumn(c) && !formulas.includes(c) && formulas.length < MAX_FORMULA_COLUMNS)
      formulas.push(c);
  return [...fixed, ...formulas];
}

/**
 * Server field a column sorts by; null = the column cannot be sorted by the server. Formula
 * columns are not sortable (the scan sorts by field ids only).
 */
export function columnSortField(id: string): string | null {
  switch (id) {
    case 'name':
    case 'last':
    case 'volume':
    case 'group':
    case 'exchange':
    case 'sector':
      return id;
    case 'changePercent':
      return 'chg1d';
    case 'dayRange':
    case 'week52Range':
    case 'change':
    case 'trend':
      return null;
    default:
      return (SNAPSHOT_COLUMNS as readonly string[]).includes(id) ? id : null;
  }
}

/** Sort fields whose live overlay can re-order the page client-side. */
export const LIVE_SORT_FIELDS: Record<string, 'last' | 'changePercent' | 'volume'> = {
  last: 'last',
  chg1d: 'changePercent',
  volume: 'volume',
};

/** Fields to request for the visible columns (the live overlay falls back to last / chg1d / volume). */
export function requestFields(columns: readonly string[], sortField: string): string[] {
  const out = new Set<string>(['last', 'chg1d', 'volume', sortField]);
  for (const c of columns) {
    if (isFormulaColumn(c)) {
      out.add(c);
      continue;
    }
    const f = c === 'changePercent' ? 'chg1d' : c;
    if (
      (SNAPSHOT_COLUMNS as readonly string[]).includes(f) ||
      ['last', 'volume', 'sector', 'group', 'exchange'].includes(f)
    )
      out.add(f);
  }
  return [...out];
}

/** First sort direction when a header is clicked (text ascending, numbers descending). */
export const firstDir = (field: string): 'asc' | 'desc' =>
  field === 'name' || field === 'group' || field === 'exchange' || field === 'sector'
    ? 'asc'
    : 'desc';

/** Rows per page in server mode (the server caps a page at 500). */
export const SERVER_PAGE_SIZES: readonly number[] = [20, 50, 100, 500];
