import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { LiveQuote } from '../../quotes/types';
import type { ColumnId } from '../../watchlist/types';
import { changeClass, fmtAuto, fmtCompact, fmtSigned, isNum } from '../format';

export interface CellValue {
  text: string;
  /** Extra class (`up` / `down`). */
  className?: string;
}

export interface ColumnDef {
  id: ColumnId;
  label: string;
  /** Long name for tooltips and the columns menu. */
  title: string;
  /** Grid track. */
  width: string;
  render: (q: LiveQuote | undefined) => CellValue;
  sortValue: (q: LiveQuote | undefined) => number | null;
}

const num = (v: number | null | undefined): number | null => (isNum(v) ? v : null);

export const COLUMNS: Record<ColumnId, ColumnDef> = {
  last: {
    id: 'last',
    label: 'Last',
    title: 'Last price',
    width: 'minmax(54px, 1fr)',
    render: (q) => ({ text: q ? fmtAuto(q.last) : '—' }),
    sortValue: (q) => num(q?.last),
  },
  change: {
    id: 'change',
    label: 'Chg',
    title: 'Change',
    width: 'minmax(50px, 0.9fr)',
    render: (q) => ({ text: q ? fmtSigned(q.change) : '', className: changeClass(q?.change) }),
    sortValue: (q) => num(q?.change),
  },
  changePercent: {
    id: 'changePercent',
    label: 'Chg%',
    title: 'Change %',
    width: 'minmax(56px, 0.9fr)',
    render: (q) => ({
      text: q ? fmtSigned(q.changePercent, 2, '%') : '',
      className: changeClass(q?.changePercent),
    }),
    sortValue: (q) => num(q?.changePercent),
  },
  volume: {
    id: 'volume',
    label: 'Volume',
    title: 'Volume',
    width: 'minmax(52px, 0.9fr)',
    render: (q) => ({ text: q ? fmtCompact(q.volume) : '' }),
    sortValue: (q) => num(q?.volume),
  },
  extPrice: {
    id: 'extPrice',
    label: 'Ext',
    title: 'Pre/post-market price',
    width: 'minmax(54px, 1fr)',
    render: (q) => ({ text: q?.ext ? fmtAuto(q.ext.price) : '' }),
    sortValue: (q) => num(q?.ext?.price),
  },
  extChangePercent: {
    id: 'extChangePercent',
    label: 'Ext%',
    title: 'Pre/post-market change %',
    width: 'minmax(56px, 0.9fr)',
    render: (q) => ({
      text: q?.ext ? fmtSigned(q.ext.changePercent, 2, '%') : '',
      className: changeClass(q?.ext?.changePercent),
    }),
    sortValue: (q) => num(q?.ext?.changePercent),
  },
  trend: {
    id: 'trend',
    label: 'Trend',
    title: '30-day trend',
    width: '50px',
    // Drawn by `Sparkline` (SymbolRow); not sortable.
    render: () => ({ text: '' }),
    sortValue: () => null,
  },
};

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
