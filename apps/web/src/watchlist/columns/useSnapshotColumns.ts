import { isExpressionSymbol } from '@tickerglass/engine';
import { useMemo } from 'react';
import { useSnapshots, useSnapshotsDisabled } from '../../screener/server/snapshot';
import type { Snaps } from '../model';
import type { ColumnId, SortKey } from '../types';
import { isSnapshotColumn } from './registry';

/**
 * Server-screener snapshot rows for a table: fetched (one batched request per 200 symbols) only
 * while a snapshot column is visible or the table is sorted by one, for the whole list so the sort
 * covers every row. Without such a column nothing is requested.
 *
 * `unavailable` is `base` plus the snapshot columns when the endpoint is absent (shown as "—" with
 * an explanation); the set keeps its identity while its members do not change.
 */
export function useSnapshotColumns(
  columns: readonly ColumnId[],
  symbols: readonly string[],
  sortKey: SortKey | undefined,
  base: ReadonlySet<ColumnId>,
): { snaps: Snaps; unavailable: ReadonlySet<ColumnId> } {
  const shown = columns.some(isSnapshotColumn);
  const needed = shown || (sortKey !== undefined && isSnapshotColumn(sortKey));
  const list = useMemo(
    () => (needed ? symbols.filter((s) => !isExpressionSymbol(s)) : []),
    [needed, symbols],
  );
  const snaps = useSnapshots(list, { enabled: needed });
  const off = useSnapshotsDisabled();
  const unavailable = useMemo(() => {
    if (!off || !shown) return base;
    const out = new Set(base);
    for (const c of columns) if (isSnapshotColumn(c)) out.add(c);
    return out;
  }, [off, shown, columns, base]);
  return { snaps, unavailable };
}
