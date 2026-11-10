/**
 * Watchlists and flags: the local copy (offline cache, localStorage) that
 * `persist/watchlists.ts` syncs with `/watchlists` and `/flags`. Every edit
 * marks the list dirty (or the flag in `flagsDirty`) until the server has it.
 */
import { isExpressionSymbol } from '@tickerglass/engine';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { normalizeSymbol } from '../store/app';
import { MAX_SECTION_TITLE, MAX_WATCHLIST_ITEMS, SYMBOL_RE, sectionCollapsed } from './model';
import { useWatchlistPagePrefs } from './page/pagePrefs';
import { useWatchlistPrefs } from './prefs';
import type { FlagColor, WatchlistEntry, WatchlistItem } from './types';

export const DEFAULT_LIST_NAME = 'Watchlist';

/**
 * Lists created by first-run seeding while the server was unreachable: ids with
 * the content signature at creation (`WatchlistSync.seedIfEmpty`).
 */
export interface PendingSeed {
  ids: string[];
  sigs: Record<string, string>;
}

/**
 * What a removal took out, with the positions, so `restore` can put it back
 * (also after other edits: items go to their old index, clamped).
 */
export interface UndoSnapshot {
  listId: string;
  entries: { index: number; item: WatchlistItem }[];
}

export interface MoveResult {
  /** Added to the target. */
  moved: number;
  /** Already in the target; only removed from the source. */
  alreadyThere: number;
  /** Did not fit in the target (1000-item cap); left in the source. */
  leftBehind: number;
}

interface WatchlistState {
  /** The last removal that can still be undone (`undoLast`). Not persisted. */
  lastUndo: UndoSnapshot | null;
  /**
   * The server's lists have been merged in at least once this session (set by the
   * persistence bootstrap). Until then `lists` may lack lists made on other devices.
   * Not persisted.
   */
  loaded: boolean;

  lists: Record<string, WatchlistEntry>;
  /**
   * Ids deleted locally, still to delete on the server. Includes lists never
   * confirmed by the server (a create may have gone through with its response
   * lost); deleting those just 404s.
   */
  pendingDeletes: string[];
  flags: Record<string, { color: FlagColor; at: string }>;
  flagsDirty: Record<string, true>;
  /** The default lists were seeded once already (never re-seed after the user deleted them). */
  seeded: boolean;
  /**
   * Lists seeded while the server was unreachable, with their content
   * signatures then; not yet confirmed (see `WatchlistSync.seedIfEmpty`).
   */
  pendingSeed: PendingSeed | null;

  /** New list (client-generated id); items are normalized and de-duplicated. */
  createList: (name: string, items?: WatchlistItem[]) => string;
  renameList: (id: string, name: string) => void;
  /** Deep copy under `name` (fresh section ids); '' if `id` is unknown. */
  duplicateList: (id: string, name: string) => string;
  deleteList: (id: string) => void;
  /**
   * Add symbols not yet in the list. Default position: the end; with `at`
   * (index of an existing item): right after it. Respects the 1000-item cap.
   * Returns the symbols actually added.
   */
  addSymbols: (id: string, symbols: string[], at?: number) => string[];
  /** Returns what was removed (for `restore`), or null if nothing was. */
  removeSymbols: (id: string, symbols: string[]) => UndoSnapshot | null;
  /** New section at the end, or at index `at` (above the item there). '' if the list is full. */
  addSection: (id: string, title: string, at?: number) => string;
  renameSection: (id: string, sid: string, title: string) => void;
  /** Returns what was removed (the section, and its symbols unless `keepSymbols`), or null. */
  removeSection: (id: string, sid: string, keepSymbols: boolean) => UndoSnapshot | null;
  /**
   * Re-insert removed items at their old positions; items already present (same
   * symbol / section id) are skipped and the item cap is respected. Returns how
   * many items were put back.
   */
  restore: (snap: UndoSnapshot) => number;
  /** `restore` of the last removal; 0 if there is none. */
  undoLast: () => number;
  /**
   * Collapse/expand. Local only (`useWatchlistPrefs.collapsed`): the list is not
   * marked dirty and its revision does not change.
   */
  toggleSection: (id: string, sid: string) => void;
  /** Move the item (a section moves with its symbols) so it ends up at index `to`. */
  moveItem: (id: string, from: number, to: number) => void;
  /** Move symbols between lists; those already in the target are only removed from the source. Returns how many were added to the target. */
  moveSymbols: (fromId: string, toId: string, symbols: string[]) => number;
  /** `moveSymbols` with the full outcome (for reporting what did not fit). */
  moveSymbolsDetailed: (fromId: string, toId: string, symbols: string[]) => MoveResult;
  /** `at` (ISO time) restores an earlier flag time, e.g. on undo; default is now. */
  setFlag: (symbol: string, color: FlagColor | null, at?: string) => void;
}

const cleanName = (name: string): string => name.trim().slice(0, 200) || DEFAULT_LIST_NAME;
const cleanTitle = (t: string): string => t.trim().slice(0, MAX_SECTION_TITLE);

/** Normalized symbol, or null if the server would reject it (`SYMBOL_RE`) or it is an expression. */
export function validSymbol(raw: string): string | null {
  const symbol = normalizeSymbol(raw);
  return SYMBOL_RE.test(symbol) && !isExpressionSymbol(symbol) ? symbol : null;
}

/** Normalize symbols, drop invalid ones and duplicates (first wins), respect the item cap. */
export function sanitizeItems(items: WatchlistItem[]): WatchlistItem[] {
  const out: WatchlistItem[] = [];
  const syms = new Set<string>();
  const sids = new Set<string>();
  for (const it of items) {
    if (out.length >= MAX_WATCHLIST_ITEMS) break;
    if (it.type === 'section') {
      const id = !it.id || sids.has(it.id) ? crypto.randomUUID() : it.id;
      sids.add(id);
      out.push({ type: 'section', id, title: cleanTitle(it.title), collapsed: !!it.collapsed });
    } else {
      const symbol = validSymbol(it.symbol);
      if (!symbol || syms.has(symbol)) continue;
      syms.add(symbol);
      out.push({ type: 'symbol', symbol });
    }
  }
  return out;
}

/** Whether section `sid` of list `listId` is collapsed here (local pref, else the legacy synced flag). */
export function isSectionCollapsed(listId: string, sid: string): boolean {
  const item = useWatchlistStore
    .getState()
    .lists[listId]?.items.find((i) => i.type === 'section' && i.id === sid);
  const local = useWatchlistPrefs.getState().collapsed[sid];
  if (local !== undefined) return local;
  return item?.type === 'section' ? sectionCollapsed(undefined, item) : false;
}

/** Items [from, end) that move together with the item at `from`. */
function blockEnd(items: WatchlistItem[], from: number): number {
  if (items[from]?.type !== 'section') return from + 1;
  let end = from + 1;
  while (end < items.length && items[end]!.type === 'symbol') end++;
  return end;
}

type Persisted = Pick<
  WatchlistState,
  'lists' | 'pendingDeletes' | 'flags' | 'flagsDirty' | 'seeded' | 'pendingSeed'
>;

/** `PendingSeed`, also accepting the pre-starters `{id, sig}` shape an older client cached. */
function normalizePendingSeed(v: unknown): PendingSeed | null {
  if (!isObj(v)) return null;
  if (typeof v.id === 'string' && typeof v.sig === 'string')
    return { ids: [v.id], sigs: { [v.id]: v.sig } };
  if (!Array.isArray(v.ids) || !isObj(v.sigs)) return null;
  const ids = v.ids.filter((x): x is string => typeof x === 'string');
  const sigs: Record<string, string> = {};
  for (const id of ids) if (typeof v.sigs[id] === 'string') sigs[id] = v.sigs[id];
  return ids.length ? { ids, sigs } : null;
}

/**
 * Rehydrate: clean what an older client may have cached (symbols the server
 * rejects with 422). A list that changed is marked dirty so the clean copy syncs.
 */
export function mergePersisted(saved: unknown, current: WatchlistState): WatchlistState {
  const p = (saved ?? {}) as Partial<Persisted>;
  const lists: Record<string, WatchlistEntry> = {};
  for (const [id, entry] of Object.entries(p.lists ?? current.lists)) {
    const items = sanitizeItems(entry.items ?? []);
    const changed = JSON.stringify(items) !== JSON.stringify(entry.items);
    lists[id] = changed ? { ...entry, items, dirty: true } : entry;
  }
  const flags: WatchlistState['flags'] = {};
  for (const [sym, f] of Object.entries(p.flags ?? current.flags)) {
    if (validSymbol(sym) === sym) flags[sym] = f;
  }
  const flagsDirty: WatchlistState['flagsDirty'] = {};
  for (const sym of Object.keys(p.flagsDirty ?? current.flagsDirty)) {
    if (validSymbol(sym) === sym) flagsDirty[sym] = true;
  }
  return {
    ...current,
    lists,
    flags,
    flagsDirty,
    pendingDeletes: p.pendingDeletes ?? current.pendingDeletes,
    seeded: p.seeded ?? current.seeded,
    pendingSeed:
      p.pendingSeed === undefined ? current.pendingSeed : normalizePendingSeed(p.pendingSeed),
  };
}

export const useWatchlistStore = create<WatchlistState>()(
  persist(
    (set, get) => {
      /** Replace a list's items (marks it dirty); no-op if unchanged or unknown. */
      const edit = (
        id: string,
        fn: (items: WatchlistItem[]) => WatchlistItem[] | null,
      ): boolean => {
        const cur = get().lists[id];
        if (!cur) return false;
        const next = fn(cur.items);
        if (!next) return false;
        set((s) => ({ lists: { ...s.lists, [id]: { ...cur, items: next, dirty: true } } }));
        return true;
      };

      return {
        lastUndo: null,
        loaded: false,
        lists: {},
        pendingDeletes: [],
        flags: {},
        flagsDirty: {},
        seeded: false,
        pendingSeed: null,

        createList: (name, items = []) => {
          const id = crypto.randomUUID();
          set((s) => ({
            lists: {
              ...s.lists,
              [id]: {
                id,
                name: cleanName(name),
                items: sanitizeItems(items),
                revision: null,
                dirty: true,
              },
            },
          }));
          return id;
        },

        renameList: (id, name) => {
          const cur = get().lists[id];
          const next = cleanName(name);
          if (!cur || cur.name === next) return;
          set((s) => ({ lists: { ...s.lists, [id]: { ...cur, name: next, dirty: true } } }));
        },

        duplicateList: (id, name) => {
          const cur = get().lists[id];
          if (!cur) return '';
          const items = cur.items.map((it) =>
            it.type === 'section' ? { ...it, id: crypto.randomUUID() } : { ...it },
          );
          return get().createList(name, items);
        },

        deleteList: (id) => {
          const cur = get().lists[id];
          if (!cur) return;
          // The remembered page view of a deleted list goes with it.
          useWatchlistPagePrefs.getState().forgetViews([id]);
          useWatchlistPrefs
            .getState()
            .forgetSections(cur.items.flatMap((i) => (i.type === 'section' ? [i.id] : [])));
          set((s) => {
            const { [id]: _gone, ...lists } = s.lists;
            return {
              lists,
              pendingDeletes: s.pendingDeletes.includes(id)
                ? s.pendingDeletes
                : [...s.pendingDeletes, id],
            };
          });
        },

        addSymbols: (id, symbols, at) => {
          const added: string[] = [];
          edit(id, (items) => {
            const have = new Set(items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
            const fresh: WatchlistItem[] = [];
            for (const raw of symbols) {
              const symbol = validSymbol(raw);
              if (!symbol || have.has(symbol)) continue;
              if (items.length + fresh.length >= MAX_WATCHLIST_ITEMS) break;
              have.add(symbol);
              fresh.push({ type: 'symbol', symbol });
              added.push(symbol);
            }
            if (!fresh.length) return null;
            const pos = at === undefined || at < 0 || at >= items.length ? items.length : at + 1;
            return [...items.slice(0, pos), ...fresh, ...items.slice(pos)];
          });
          return added;
        },

        removeSymbols: (id, symbols) => {
          const drop = new Set(symbols.map(normalizeSymbol));
          const out: { snap: UndoSnapshot | null } = { snap: null };
          edit(id, (items) => {
            const entries = items.flatMap((item, index) =>
              item.type === 'symbol' && drop.has(item.symbol) ? [{ index, item }] : [],
            );
            if (!entries.length) return null;
            out.snap = { listId: id, entries };
            return items.filter((i) => !(i.type === 'symbol' && drop.has(i.symbol)));
          });
          if (out.snap) set({ lastUndo: out.snap });
          return out.snap;
        },

        addSection: (id, title, at) => {
          const sid = crypto.randomUUID();
          const ok = edit(id, (items) => {
            if (items.length >= MAX_WATCHLIST_ITEMS) return null;
            const pos = at === undefined || at < 0 || at > items.length ? items.length : at;
            const sec: WatchlistItem = {
              type: 'section',
              id: sid,
              title: cleanTitle(title),
            };
            return [...items.slice(0, pos), sec, ...items.slice(pos)];
          });
          return ok ? sid : '';
        },

        renameSection: (id, sid, title) =>
          edit(id, (items) => {
            const t = cleanTitle(title);
            let changed = false;
            const next = items.map((i) => {
              if (i.type === 'section' && i.id === sid && i.title !== t) {
                changed = true;
                return { ...i, title: t };
              }
              return i;
            });
            return changed ? next : null;
          }),

        removeSection: (id, sid, keepSymbols) => {
          const out: { snap: UndoSnapshot | null } = { snap: null };
          edit(id, (items) => {
            const from = items.findIndex((i) => i.type === 'section' && i.id === sid);
            if (from < 0) return null;
            const end = keepSymbols ? from + 1 : blockEnd(items, from);
            out.snap = {
              listId: id,
              entries: items.slice(from, end).map((item, k) => ({ index: from + k, item })),
            };
            return [...items.slice(0, from), ...items.slice(end)];
          });
          if (out.snap) set({ lastUndo: out.snap });
          return out.snap;
        },

        restore: (snap) => {
          let put = 0;
          edit(snap.listId, (items) => {
            const syms = new Set(items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
            const sids = new Set(items.flatMap((i) => (i.type === 'section' ? [i.id] : [])));
            const next = [...items];
            for (const { index, item } of [...snap.entries].sort((a, b) => a.index - b.index)) {
              if (next.length >= MAX_WATCHLIST_ITEMS) break;
              if (item.type === 'symbol' ? syms.has(item.symbol) : sids.has(item.id)) continue;
              next.splice(Math.min(index, next.length), 0, item);
              put++;
            }
            return put ? next : null;
          });
          if (get().lastUndo === snap) set({ lastUndo: null });
          return put;
        },

        undoLast: () => {
          const snap = get().lastUndo;
          return snap ? get().restore(snap) : 0;
        },

        toggleSection: (id, sid) => {
          const cur = get().lists[id];
          const sec = cur?.items.find((i) => i.type === 'section' && i.id === sid);
          if (!cur || sec?.type !== 'section') return;
          const prefs = useWatchlistPrefs.getState();
          prefs.setSectionCollapsed(sid, !sectionCollapsed(prefs.collapsed, sec));
        },

        moveItem: (id, from, to) =>
          edit(id, (items) => {
            if (from < 0 || from >= items.length || from === to) return null;
            const end = blockEnd(items, from);
            const block = items.slice(from, end);
            const rest = [...items.slice(0, from), ...items.slice(end)];
            let pos = Math.max(0, Math.min(to, rest.length));
            if (block[0]!.type === 'section') {
              // Never split another section: snap to the end of the block it lands in.
              const hasSectionBefore = (p: number) =>
                rest.slice(0, p).some((i) => i.type === 'section');
              while (pos < rest.length && rest[pos]!.type === 'symbol' && hasSectionBefore(pos))
                pos++;
            }
            const next = [...rest.slice(0, pos), ...block, ...rest.slice(pos)];
            return next.every((it, i) => it === items[i]) ? null : next;
          }),

        moveSymbols: (fromId, toId, symbols) =>
          get().moveSymbolsDetailed(fromId, toId, symbols).moved,

        moveSymbolsDetailed: (fromId, toId, symbols) => {
          const none: MoveResult = { moved: 0, alreadyThere: 0, leftBehind: 0 };
          if (fromId === toId) return none;
          const src = get().lists[fromId];
          const dst = get().lists[toId];
          if (!src || !dst) return none;
          const want = [...new Set(symbols.map(normalizeSymbol))];
          const inSrc = new Set(src.items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
          const inDst = new Set(dst.items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
          const present = want.filter((s) => inSrc.has(s));
          const toAdd = present.filter((s) => !inDst.has(s));
          const added = get().addSymbols(toId, toAdd);
          // Symbols that did not fit in the target (cap) stay in the source.
          const addedSet = new Set(added);
          const remove = present.filter((s) => inDst.has(s) || addedSet.has(s));
          get().removeSymbols(fromId, remove);
          // A move is not an undoable removal: the symbols still exist in the target.
          set({ lastUndo: null });
          return {
            moved: added.length,
            alreadyThere: present.filter((s) => inDst.has(s)).length,
            leftBehind: present.length - remove.length,
          };
        },

        setFlag: (symbol, color, at) => {
          const sym = validSymbol(symbol);
          if (!sym) return;
          const cur = get().flags[sym];
          if ((cur?.color ?? null) === color) return;
          set((s) => {
            const flags = { ...s.flags };
            if (color) flags[sym] = { color, at: at ?? new Date().toISOString() };
            else delete flags[sym];
            return { flags, flagsDirty: { ...s.flagsDirty, [sym]: true } };
          });
        },
      };
    },
    {
      name: 'tickerglass-watchlists',
      version: 1,
      merge: mergePersisted,
      partialize: (s) => ({
        lists: s.lists,
        pendingDeletes: s.pendingDeletes,
        flags: s.flags,
        flagsDirty: s.flagsDirty,
        seeded: s.seeded,
        pendingSeed: s.pendingSeed,
      }),
    },
  ),
);
