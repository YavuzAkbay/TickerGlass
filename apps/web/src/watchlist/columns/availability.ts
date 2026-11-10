import { useMemo } from 'react';
import type { LiveQuote } from '../../quotes/types';
import type { ColumnId } from '../types';
import { COLUMN_DEFS, unavailableColumns } from './registry';

const NONE: ReadonlySet<ColumnId> = new Set();

/**
 * Columns among `columns` that the data source cannot fill for any of
 * `symbols` (e.g. average volume off Yahoo). The set keeps its identity while
 * its members do not change, so memoized rows do not re-render on every tick.
 */
export function useUnavailableColumns(
  columns: readonly ColumnId[],
  symbols: readonly string[],
  quotes: Record<string, LiveQuote | undefined>,
): ReadonlySet<ColumnId> {
  const needy = columns.filter((c) => COLUMN_DEFS[c].requires);
  const key = needy.length
    ? unavailableColumns(
        needy,
        symbols.map((s) => quotes[s]),
      ).join(',')
    : '';
  return useMemo(() => (key ? new Set(key.split(',') as ColumnId[]) : NONE), [key]);
}
