import { useEffect } from 'react';
import type { VirtualRange } from '../../ui/virtualRows';

/** A run of rendered rows `[from, to)` or a blank gap of `rows` row heights. */
export type Segment =
  { gap: true; key: string; rows: number } | { gap: false; from: number; to: number };

/**
 * Layout of a virtualized list: the visible `range`, plus the row `pinned` (the one being dragged)
 * even when scrolled out of range, so its DOM node survives and its `dragend` still reaches React.
 */
export function windowSegments(
  count: number,
  range: VirtualRange,
  pinned: number | null,
): Segment[] {
  const { start, end } = range;
  const visible: Segment = { gap: false, from: start, to: end };
  if (pinned !== null && pinned >= 0 && pinned < start)
    return [
      { gap: true, key: 'gap-top', rows: pinned },
      { gap: false, from: pinned, to: pinned + 1 },
      { gap: true, key: 'gap-mid', rows: start - pinned - 1 },
      visible,
      { gap: true, key: 'gap-bottom', rows: count - end },
    ];
  if (pinned !== null && pinned >= end && pinned < count)
    return [
      { gap: true, key: 'gap-top', rows: start },
      visible,
      { gap: true, key: 'gap-mid', rows: pinned - end },
      { gap: false, from: pinned, to: pinned + 1 },
      { gap: true, key: 'gap-bottom', rows: count - pinned - 1 },
    ];
  return [
    { gap: true, key: 'gap-top', rows: start },
    visible,
    { gap: true, key: 'gap-bottom', rows: count - end },
  ];
}

/**
 * While a drag is active, end it on any window-level `dragend`/`drop`. Rows have their own
 * handlers, but a row that unmounted mid-drag (virtualized away) or a drop outside the table
 * never reaches them, which would leave the drag state (and the table freeze) stuck.
 */
export function useDragEndSafety(active: boolean, onEnd: () => void): void {
  useEffect(() => {
    if (!active) return;
    window.addEventListener('dragend', onEnd);
    window.addEventListener('drop', onEnd);
    return () => {
      window.removeEventListener('dragend', onEnd);
      window.removeEventListener('drop', onEnd);
    };
  }, [active, onEnd]);
}
