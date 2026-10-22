import type { WatchlistItem } from '../../watchlist/types';

/** Items [from, end) that move together with the item at `from` (a section takes its symbols). */
function blockEnd(items: WatchlistItem[], from: number): number {
  if (items[from]?.type !== 'section') return from + 1;
  let end = from + 1;
  while (end < items.length && items[end]!.type === 'symbol') end++;
  return end;
}

/**
 * `to` argument for the store's `moveItem` that moves the item at `from` one step up (-1) or
 * down (+1): a symbol swaps with its neighbour, a section jumps over the previous/next section
 * block. Null when it cannot move that way.
 */
export function moveStepTarget(items: WatchlistItem[], from: number, dir: 1 | -1): number | null {
  const cur = items[from];
  if (!cur) return null;
  if (cur.type === 'symbol') {
    const to = from + dir;
    return to < 0 || to >= items.length ? null : to;
  }
  if (dir < 0) {
    for (let i = from - 1; i >= 0; i--) if (items[i]!.type === 'section') return i;
    return from > 0 ? 0 : null;
  }
  const end = blockEnd(items, from);
  if (end >= items.length) return null;
  const nextEnd = blockEnd(items, end);
  return nextEnd - (end - from);
}
