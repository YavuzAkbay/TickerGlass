import { useEffect, useMemo, useState, type HTMLAttributes } from 'react';
import { useStableOrder } from '../../ui/useStableOrder';
import type { Row, SortSpec } from '../../watchlist/types';

/** Minimum time between reorders of a live-sorted table. */
export const STABLE_ROWS_MS = 1500;

export function rowKey(r: Row): string {
  return r.kind === 'section' ? `s:${r.id}` : `y:${r.symbol}`;
}

/** Symbol sort never changes with quotes; every other sort key is live. */
export const isLiveSort = (sort: SortSpec | null): boolean => !!sort && sort.key !== 'symbol';

/**
 * Display rows that do not jump on every quote tick while sorted by a live
 * column: the order re-commits at most every `STABLE_ROWS_MS` and never while
 * `frozen`. A different sort or list content re-sorts at once (the user asked
 * for it); unsorted lists pass through.
 */
export function useStableRows(
  rows: Row[],
  o: { sort: SortSpec | null; items: unknown; frozen: boolean },
): Row[] {
  const live = isLiveSort(o.sort);
  const sortSig = o.sort ? `${o.sort.key}:${o.sort.dir}` : '';
  const [seen, setSeen] = useState({ items: o.items, sortSig });
  const flush = seen.items !== o.items || seen.sortSig !== sortSig;
  if (flush) setSeen({ items: o.items, sortSig });
  const stable = useStableOrder(rows, rowKey, {
    intervalMs: flush ? 0 : STABLE_ROWS_MS,
    frozen: o.frozen,
  });
  return live ? stable : rows;
}

/** True while any popover (context menu, dropdown) is open. */
function usePopoverOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const check = () => setOpen(!!document.querySelector('.io-popover'));
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true });
    return () => mo.disconnect();
  }, []);
  return open;
}

/**
 * Freeze signal for `useStableRows`: the pointer is over the table body, a menu
 * is open, or `busy` (a drag). Spread `bodyProps` onto the rows' container.
 */
export function useTableFreeze(busy: boolean): {
  frozen: boolean;
  bodyProps: HTMLAttributes<HTMLDivElement>;
} {
  const [hover, setHover] = useState(false);
  const menu = usePopoverOpen();
  const bodyProps = useMemo<HTMLAttributes<HTMLDivElement>>(
    () => ({ onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) }),
    [],
  );
  return { frozen: hover || menu || busy, bodyProps };
}
