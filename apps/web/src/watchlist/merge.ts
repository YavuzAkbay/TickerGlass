/**
 * Three-way merge of a watchlist for a save that hit a newer server version
 * (409): `base` is the last version this client synced with the server, `mine`
 * the current local state and `theirs` the server's.
 *
 * Items are keyed by symbol / section id. Adds from both sides are kept, a
 * removal on either side wins over an untouched copy on the other, and the
 * order comes from `mine`; items only `theirs` added are placed after their
 * nearest predecessor in `theirs` that is kept (first if none). It is
 * a true conflict (not merged) when both sides changed the same name or
 * section title differently, one side renamed a section the other removed, or
 * the result would exceed the item cap.
 */
import { MAX_WATCHLIST_ITEMS } from './model';
import type { WatchlistItem } from './types';

export interface ListContent {
  name: string;
  items: WatchlistItem[];
}

export type MergeResult =
  { ok: true; name: string; items: WatchlistItem[] } | { ok: false; reasons: string[] };

const keyOf = (i: WatchlistItem): string => (i.type === 'symbol' ? `S:${i.symbol}` : `#:${i.id}`);

/** Per-key lookup of the items. */
const index = (items: WatchlistItem[]): Map<string, WatchlistItem> =>
  new Map(items.map((i) => [keyOf(i), i]));

type Section = Extract<WatchlistItem, { type: 'section' }>;
const asSection = (i: WatchlistItem | undefined): Section | undefined =>
  i?.type === 'section' ? i : undefined;

/** Three-way pick of a scalar: undefined when both sides changed it, differently. */
function pick3(base: string | undefined, mine: string, theirs: string): string | undefined {
  if (mine === theirs) return mine;
  if (mine === base) return theirs;
  if (theirs === base) return mine;
  return undefined;
}

/**
 * A stand-in base when the real one is unknown: `a` with only the items `b`
 * has too. Merging against it keeps every addition of both sides (a removal
 * made on one side since the real base comes back instead of being lost).
 */
export function sharedBase(a: ListContent, b: ListContent): ListContent {
  const inB = index(b.items);
  return { name: a.name, items: a.items.filter((i) => inB.has(keyOf(i))) };
}

export function mergeLists(base: ListContent, mine: ListContent, theirs: ListContent): MergeResult {
  const reasons: string[] = [];
  const B = index(base.items);
  const M = index(mine.items);
  const T = index(theirs.items);

  const name = pick3(base.name, mine.name, theirs.name);
  if (name === undefined)
    reasons.push(
      `The list was renamed differently (“${mine.name}” here, “${theirs.name}” elsewhere)`,
    );

  const keep = new Set<string>();
  const titles = new Map<string, string>();
  for (const k of new Set([...M.keys(), ...T.keys()])) {
    const b = B.get(k);
    const m = M.get(k);
    const t = T.get(k);
    if (b && (!m || !t)) {
      // Removed on one side: gone, unless the other side edited it (renamed a section).
      const other = asSection(m ?? t);
      if (other && other.title !== asSection(b)?.title)
        reasons.push(`Section “${other.title}” was renamed on one side and removed on the other`);
      continue;
    }
    keep.add(k);
    const ms = asSection(m);
    const ts = asSection(t);
    if (ms && ts) {
      const title = pick3(asSection(b)?.title, ms.title, ts.title);
      if (title === undefined)
        reasons.push(`Section renamed differently (“${ms.title}” here, “${ts.title}” elsewhere)`);
      else titles.set(k, title);
    }
  }

  const items: WatchlistItem[] = [];
  const titled = (i: WatchlistItem): WatchlistItem => {
    const title = titles.get(keyOf(i));
    return title !== undefined && i.type === 'section' ? { ...i, title } : i;
  };
  // Items only `theirs` added go after their nearest predecessor in `theirs`
  // that is kept (so they stay in their section), or first if there is none.
  const head: WatchlistItem[] = [];
  const after = new Map<string, WatchlistItem[]>();
  let anchor: string | null = null;
  for (const i of theirs.items) {
    const k = keyOf(i);
    if (!keep.has(k)) continue;
    if (!M.has(k)) {
      const into = anchor === null ? head : (after.get(anchor) ?? []);
      into.push(i);
      if (anchor !== null) after.set(anchor, into);
    }
    anchor = k;
  }
  const emit = (i: WatchlistItem): void => {
    items.push(titled(i));
    for (const next of after.get(keyOf(i)) ?? []) emit(next);
  };
  for (const i of head) emit(i);
  for (const i of mine.items) if (keep.has(keyOf(i))) emit(i);

  if (items.length > MAX_WATCHLIST_ITEMS)
    reasons.push(`The merged list would exceed ${MAX_WATCHLIST_ITEMS} items`);
  return reasons.length || name === undefined ? { ok: false, reasons } : { ok: true, name, items };
}
