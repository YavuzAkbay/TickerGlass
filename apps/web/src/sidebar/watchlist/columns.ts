import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { LiveQuote } from '../../quotes/types';
import type { SnapshotRow } from '../../screener/server/snapshot';
import { COLUMN_DEFS, type CellValue } from '../../watchlist/columns/registry';
import type { ColumnId } from '../../watchlist/types';

export type { CellValue };

/** A column as the sidebar panel sees it (a view over the shared registry). */
export interface ColumnDef {
  id: ColumnId;
  /** Header text. */
  label: string;
  /** Long name for tooltips and the columns menu. */
  title: string;
  /** Grid track. */
  width: string;
  render: (q: LiveQuote | undefined, snap?: SnapshotRow) => CellValue;
  sortValue: (q: LiveQuote | undefined, snap?: SnapshotRow) => number | null;
}

const view = (id: ColumnId): ColumnDef => {
  const d = COLUMN_DEFS[id];
  return {
    id,
    label: d.short,
    title: d.label,
    width: d.width.sidebar,
    render: (q, snap) => d.cell({ q, meta: undefined, snap, surface: 'sidebar' }),
    sortValue: (q, snap) => {
      const v = d.accessor(q, undefined, snap);
      return typeof v === 'number' ? v : null;
    },
  };
};

/** Every registry column (the panel only offers those of the sidebar surface). */
export const COLUMNS = Object.fromEntries(
  (Object.keys(COLUMN_DEFS) as ColumnId[]).map((id) => [id, view(id)]),
) as Record<ColumnId, ColumnDef>;

/**
 * Flash an element when the quote's price changed on a tick. Remove, reflow,
 * add: restarts the animation on consecutive changes. The tick's `flash.target`
 * picks the cell: an extended-hours tick flashes `extRef`, a regular tick
 * `lastRef`; nothing happens if that cell is not rendered.
 * Reduced motion is handled in CSS (the animation is disabled).
 */
export function useFlash(
  q: LiveQuote | undefined,
  lastRef: RefObject<HTMLElement | null>,
  extRef?: RefObject<HTMLElement | null>,
): void {
  const seq = q?.flash?.seq;
  const dir = q?.flash?.dir;
  const target = q?.flash?.target;
  const seen = useRef(seq);
  useLayoutEffect(() => {
    if (seq === undefined || dir === undefined || seq === seen.current) return;
    seen.current = seq;
    const el = target === 'ext' ? extRef?.current : lastRef.current;
    if (!el) return;
    el.classList.remove('wl-flash-up', 'wl-flash-down');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'wl-flash-up' : 'wl-flash-down');
  }, [seq, dir, target, lastRef, extRef]);
}
