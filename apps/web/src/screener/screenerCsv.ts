import { csvField, csvTextField } from '../chart/exportData';
import type { LiveQuote } from '../quotes/types';
import { isNum } from '../sidebar/format';
import { dayBounds, effectiveCap, relVolume, turnover, week52Bounds } from './model';
import { SCREENER_ALL_COLUMNS, type ScreenerColumnId } from './screenerPrefs';
import type { ScanRow } from './server/types';
import type { Universe, UniverseSymbol } from './universe/types';

type CsvRow = Pick<UniverseSymbol, 'symbol' | 'name' | 'group' | 'exchange' | 'cap'>;

const num = (v: number | null | undefined): string => (isNum(v) ? String(v) : '');

interface CsvColumn {
  /** Header cells (a column may write several, e.g. a low/high pair). */
  head: (universe: Universe) => string[];
  /** Value cells, same length as `head`. Text goes through `csvTextField`. */
  cells: (r: CsvRow, q: LiveQuote | undefined, universe: Universe) => string[];
}

const capHead = (u: Universe): string =>
  u.capKind === 'aum' ? 'AUM (approx $B)' : 'Market Cap (approx $B)';

/**
 * Writable columns. `trend` (a sparkline) has no tabular value and is left
 * out; `dayRange` / `week52Range` write their low and high as two columns.
 */
const CSV_COLUMNS: Partial<Record<ScreenerColumnId, CsvColumn>> = {
  name: { head: () => ['Name'], cells: (r) => [csvTextField(r.name)] },
  last: { head: () => ['Last'], cells: (_r, q) => [num(q?.last)] },
  change: { head: () => ['Change'], cells: (_r, q) => [num(q?.change)] },
  changePercent: { head: () => ['Change %'], cells: (_r, q) => [num(q?.changePercent)] },
  prevClose: { head: () => ['Prev Close'], cells: (_r, q) => [num(q?.prevClose)] },
  volume: { head: () => ['Volume'], cells: (_r, q) => [num(q?.volume)] },
  relVolume: { head: () => ['Rel Volume'], cells: (_r, q) => [num(relVolume(q))] },
  turnover: { head: () => ['Turnover'], cells: (_r, q) => [num(turnover(q))] },
  dayRange: {
    head: () => ['Day Low', 'Day High'],
    cells: (_r, q) => {
      const b = dayBounds(q);
      return [num(b?.low), num(b?.high)];
    },
  },
  week52Range: {
    head: () => ['52W Low', '52W High'],
    cells: (_r, q) => {
      const b = week52Bounds(q);
      return [num(b?.low), num(b?.high)];
    },
  },
  extChangePercent: {
    head: () => ['Pre/Post Change %'],
    cells: (_r, q) => [num(q?.ext?.changePercent)],
  },
  cap: { head: (u) => [capHead(u)], cells: (r) => [num(r.cap)] },
  liveCap: {
    head: (u) => [u.capKind === 'aum' ? 'AUM (approx $B)' : 'Market Cap (live $B)'],
    cells: (r, q, u) => [num(effectiveCap(r, q, u.capKind))],
  },
  group: {
    head: (u) => [
      u.groupLabel === 'sector' ? 'Sector' : u.groupLabel === 'category' ? 'Category' : 'Group',
    ],
    cells: (r) => [csvTextField(r.group)],
  },
  exchange: { head: () => ['Exchange'], cells: (r) => [csvTextField(r.exchange ?? '')] },
};

/** Default export columns: everything the table can show (all but the sparkline). */
export const CSV_DEFAULT_COLUMNS: readonly ScreenerColumnId[] = SCREENER_ALL_COLUMNS;

/**
 * CSV of the screener view. `rows` must already be in the displayed (sorted)
 * order; `columns` are the visible table columns in table order (the symbol
 * is always first). Text fields go through `csvTextField` (RFC 4180 +
 * formula-injection guard); numbers are written raw so spreadsheets read them
 * as numbers. Missing values stay empty.
 */
export function screenerCsv(
  universe: Universe,
  rows: CsvRow[],
  quotes: Record<string, LiveQuote | undefined>,
  columns: readonly ScreenerColumnId[] = CSV_DEFAULT_COLUMNS,
): string {
  const defs = columns.flatMap((id) => {
    const def = CSV_COLUMNS[id];
    const capless = (id === 'cap' || id === 'liveCap') && !universe.capKind;
    return def && !capless ? [def] : [];
  });
  const head = ['Symbol', ...defs.flatMap((d) => d.head(universe))];
  const body = rows.map((r) => {
    const q = quotes[r.symbol];
    return [csvTextField(r.symbol), ...defs.flatMap((d) => d.cells(r, q, universe))].join(',');
  });
  return [head.map(csvField).join(','), ...body].join('\n');
}

/** `Screener-<class>_<YYYY-MM-DD>.csv`, safe for file systems. */
export function screenerCsvFilename(cls: string, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  return `Screener-${cls}_${day}.csv`;
}

interface ServerCsvColumn {
  head: string;
  cell: (r: ScanRow) => string;
}

const sv = (r: ScanRow, f: string): string => {
  const v = r.values[f];
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
};
const st = (r: ScanRow, f: string): string => {
  const v = r.values[f];
  return typeof v === 'string' ? csvTextField(v) : '';
};
const numCol = (head: string, field: string): ServerCsvColumn => ({
  head,
  cell: (r) => sv(r, field),
});

/**
 * Writable columns of the server table. `change`, the range bars and the sparkline have no
 * snapshot value and are left out.
 */
const SERVER_CSV_COLUMNS: Record<string, ServerCsvColumn> = {
  name: { head: 'Name', cell: (r) => csvTextField(r.name) },
  last: numCol('Last', 'last'),
  changePercent: numCol('Change %', 'chg1d'),
  volume: numCol('Volume', 'volume'),
  relVol: numCol('Rel Volume', 'relVol'),
  perf1w: numCol('Perf 1W %', 'perf1w'),
  perf1m: numCol('Perf 1M %', 'perf1m'),
  perfYtd: numCol('Perf YTD %', 'perfYtd'),
  perf1y: numCol('Perf 1Y %', 'perf1y'),
  rsi14: numCol('RSI (14)', 'rsi14'),
  pctVsSma200: numCol('% vs SMA200', 'pctVsSma200'),
  atrPct: numCol('ATR %', 'atrPct'),
  pctOffHi52: numCol('% off 52W high', 'pctOffHi52'),
  mcap: numCol('Market Cap (USD)', 'mcap'),
  pe: numCol('P/E', 'pe'),
  divYield: numCol('Dividend Yield %', 'divYield'),
  nextEarnings: {
    head: 'Next Earnings',
    cell: (r) => {
      const v = r.values.nextEarnings;
      return typeof v === 'number' && Number.isFinite(v)
        ? new Date(v * 1000).toISOString().slice(0, 10)
        : '';
    },
  },
  daysToEarnings: numCol('Days to Earnings', 'daysToEarnings'),
  sector: { head: 'Sector', cell: (r) => st(r, 'sector') },
  group: { head: 'Group', cell: (r) => csvTextField(r.group) },
  exchange: { head: 'Exchange', cell: (r) => csvTextField(r.exchange ?? '') },
};

/**
 * CSV of server scan rows in order; `columns` are the visible server-table columns (the symbol
 * is always first). Same escaping as `screenerCsv`; snapshot values are written raw. A formula
 * column (`"=<formula>"`) is headed by its name from `labels`, else its formula; headers are
 * user text, so they get the CSV-injection guard (a formula starts with `=`).
 */
export function serverScreenerCsv(
  rows: ScanRow[],
  columns: readonly string[],
  labels: Readonly<Record<string, string>> = {},
): string {
  const defs = columns.flatMap((id) => {
    if (id.startsWith('=') && id.length > 1)
      return [{ head: labels[id] || id.slice(1), cell: (r: ScanRow) => sv(r, id) }];
    const def = SERVER_CSV_COLUMNS[id];
    return def ? [def] : [];
  });
  const head = ['Symbol', ...defs.map((d) => d.head)];
  const body = rows.map((r) => [csvTextField(r.symbol), ...defs.map((d) => d.cell(r))].join(','));
  return [head.map(csvTextField).join(','), ...body].join('\n');
}
