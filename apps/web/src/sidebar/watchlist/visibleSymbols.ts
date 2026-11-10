import { sectionCollapsed, type CollapsedMap } from '../../watchlist/model';
import type { WatchlistItem } from '../../watchlist/types';

/**
 * Symbols whose rows can be on screen: everything except symbols under a
 * collapsed section (`collapsed` is the local `useWatchlistPrefs.collapsed` map).
 * Only these need live quote subscriptions.
 */
export function visibleSymbols(
  items: readonly WatchlistItem[],
  collapsed?: CollapsedMap,
): string[] {
  const out: string[] = [];
  let hidden = false;
  for (const it of items) {
    if (it.type === 'section') hidden = sectionCollapsed(collapsed, it);
    else if (!hidden) out.push(it.symbol);
  }
  return out;
}
