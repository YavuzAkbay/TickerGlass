import type { WatchlistItem } from '../types';

/** Substring match on the symbol or its (resolved) name. */
export function matchesFilter(symbol: string, name: string | undefined, raw: string): boolean {
  const needle = raw.trim().toLowerCase();
  if (!needle) return true;
  return symbol.toLowerCase().includes(needle) || (!!name && name.toLowerCase().includes(needle));
}

/**
 * Items narrowed by the filter. Matching sections keep all their symbols; a
 * section whose title matches stays whole. Empty sections drop out so the
 * table shows only what matched.
 */
export function filterItems(
  items: WatchlistItem[],
  raw: string,
  nameOf: (symbol: string) => string | undefined,
): WatchlistItem[] {
  const needle = raw.trim().toLowerCase();
  if (!needle) return items;
  const out: WatchlistItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.type !== 'section') {
      if (matchesFilter(it.symbol, nameOf(it.symbol), needle)) out.push(it);
      continue;
    }
    let j = i + 1;
    const block: WatchlistItem[] = [];
    while (j < items.length && items[j]!.type === 'symbol') {
      block.push(items[j]!);
      j++;
    }
    const titleMatch = it.title.toLowerCase().includes(needle);
    const kept = titleMatch
      ? block
      : block.filter(
          (s) => s.type === 'symbol' && matchesFilter(s.symbol, nameOf(s.symbol), needle),
        );
    if (titleMatch || kept.length) out.push(it, ...kept);
    i = j - 1;
  }
  return out;
}
