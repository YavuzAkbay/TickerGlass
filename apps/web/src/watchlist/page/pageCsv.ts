import { csvField, csvTextField } from '../../chart/exportData';
import type { LiveQuote } from '../../quotes/types';
import { isNum } from '../../sidebar/format';
import { COLUMN_DEFS } from '../columns/registry';
import type { Snaps, SymbolMeta } from '../model';
import type { ColumnId } from '../types';

/**
 * CSV of the current view: a Symbol column, then the visible `columns` in
 * display order, each contributing the headers/values its registry entry
 * defines (the sparkline has none). Text fields go through `csvTextField`
 * (RFC 4180 + formula-injection guard); numbers are written raw so
 * spreadsheets read them as numbers. Missing values stay empty. `snaps` feeds the snapshot
 * columns (server screener).
 */
export function watchlistCsv(
  symbols: string[],
  quotes: Record<string, LiveQuote | undefined>,
  meta: Record<string, SymbolMeta | undefined>,
  columns: readonly ColumnId[],
  snaps: Snaps = {},
): string {
  const head = ['Symbol', ...columns.flatMap((c) => COLUMN_DEFS[c].csv.headers)];
  const rows = symbols.map((symbol) => {
    const q = quotes[symbol];
    const cells = columns.flatMap((c) => COLUMN_DEFS[c].csv.values(q, meta[symbol], snaps[symbol]));
    return [
      csvTextField(symbol),
      ...cells.map((v) => (typeof v === 'string' ? csvTextField(v) : isNum(v) ? String(v) : '')),
    ].join(',');
  });
  return [head.map(csvField).join(','), ...rows].join('\n');
}

/** `<list>_<YYYY-MM-DD>.csv`, safe for file systems. */
export function csvFilename(listName: string, date = new Date()): string {
  const stem = listName.replace(/[/\\:*?"<>|]/g, '_').trim() || 'watchlist';
  const day = date.toISOString().slice(0, 10);
  return `${stem}_${day}.csv`;
}

/**
 * Export order: the rows as the table displays them (sort applied), then the
 * view's symbols that have no row (under collapsed sections) in list order.
 * `shown` entries outside the view (stale after a list switch) are dropped.
 */
export function exportOrder(shown: readonly string[], view: readonly string[]): string[] {
  const inView = new Set(view);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of shown)
    if (inView.has(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  for (const s of view)
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  return out;
}
