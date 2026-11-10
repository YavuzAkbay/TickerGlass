import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { DEFAULT_COLUMNS } from './columns/presets';
import { canonicalColumns, sortableFor, toggleInOrder } from './columns/registry';
import {
  FLAG_COLORS,
  type ColumnId,
  type ListRef,
  type SortKey,
  type SortSpec,
  type WatchlistPrefs,
} from './types';

// Not from ./model: that imports this file (section collapse state).
const isFlagRef = (ref: string): boolean =>
  ref.startsWith('flag:') && (FLAG_COLORS as readonly string[]).includes(ref.slice(5));

const SORT_KEYS: readonly string[] = ['symbol', ...sortableFor('sidebar')];

export const DEFAULT_PREFS: WatchlistPrefs = {
  activeId: null,
  columns: [...DEFAULT_COLUMNS.sidebar],
  sort: null,
};

/** Validate a value from the server or an import; invalid fields are left out. */
export function parsePrefs(v: unknown): Partial<WatchlistPrefs> {
  const out: Partial<WatchlistPrefs> = {};
  if (!isObj(v)) return out;
  if (v.activeId === null) out.activeId = null;
  else if (typeof v.activeId === 'string' && v.activeId.length > 0 && v.activeId.length <= 64)
    out.activeId = v.activeId.startsWith('flag:') && !isFlagRef(v.activeId) ? null : v.activeId;
  // The sidebar has a fixed column order.
  if (Array.isArray(v.columns)) out.columns = canonicalColumns(v.columns, 'sidebar');
  if (v.sort === null) out.sort = null;
  else if (
    isObj(v.sort) &&
    typeof v.sort.key === 'string' &&
    SORT_KEYS.includes(v.sort.key) &&
    (v.sort.dir === 'asc' || v.sort.dir === 'desc')
  )
    out.sort = { key: v.sort.key as SortKey, dir: v.sort.dir };
  return out;
}

/** Entries kept in the collapse map (sections of deleted lists are pruned; this bounds the rest). */
export const MAX_COLLAPSE_ENTRIES = 2000;

/**
 * Validate the persisted collapse map (section id -> collapsed). Local only,
 * never synced: collapsing a section must not bump a list's revision.
 */
export function parseCollapsed(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isObj(v)) return out;
  // Insertion order is recency (writes delete + reinsert): keep the last entries.
  const valid = Object.entries(v).filter(
    (e): e is [string, boolean] =>
      typeof e[1] === 'boolean' && e[0].length > 0 && e[0].length <= 64,
  );
  for (const [sid, c] of valid.slice(-MAX_COLLAPSE_ENTRIES)) out[sid] = c;
  return out;
}

interface PrefsState extends WatchlistPrefs {
  /**
   * Collapse state per section id, local to this browser. An absent id falls
   * back to the legacy `collapsed` flag still stored in the list item (older
   * clients synced it), so existing collapsed sections stay collapsed.
   */
  collapsed: Record<string, boolean>;
  setSectionCollapsed: (sid: string, collapsed: boolean) => void;
  /** Drop collapse state of these sections (their list was deleted). */
  forgetSections: (sids: string[]) => void;
  setActive: (id: ListRef | null) => void;
  /** Toggle a column; a new one lands at its canonical place among the shown ones. */
  toggleColumn: (id: ColumnId) => void;
  /** Replace the shown columns (preset); a sort on a hidden column is cleared. */
  setColumns: (columns: ColumnId[]) => void;
  setSort: (sort: SortSpec | null) => void;
}

export const useWatchlistPrefs = create<PrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      collapsed: {},
      setSectionCollapsed: (sid, collapsed) =>
        set((s) => {
          if (s.collapsed[sid] === collapsed) return s;
          // Delete + reinsert so the newest entry is last; the oldest are dropped past the cap.
          const next = { ...s.collapsed };
          delete next[sid];
          next[sid] = collapsed;
          const keys = Object.keys(next);
          for (const k of keys.slice(0, Math.max(0, keys.length - MAX_COLLAPSE_ENTRIES)))
            delete next[k];
          return { collapsed: next };
        }),
      forgetSections: (sids) =>
        set((s) => {
          if (!sids.some((x) => x in s.collapsed)) return s;
          const next = { ...s.collapsed };
          for (const x of sids) delete next[x];
          return { collapsed: next };
        }),
      setActive: (activeId) => set({ activeId }),
      toggleColumn: (id) =>
        set((s) => {
          const next = toggleInOrder(s.columns, id, 'sidebar');
          // A sort on a hidden column is cleared.
          const sort =
            s.sort && s.sort.key !== 'symbol' && !next.includes(s.sort.key) ? null : s.sort;
          return { columns: next, sort };
        }),
      setColumns: (columns) =>
        set((s) => {
          const next = canonicalColumns(columns, 'sidebar');
          const sort =
            s.sort && s.sort.key !== 'symbol' && !next.includes(s.sort.key) ? null : s.sort;
          return { columns: next, sort };
        }),
      setSort: (sort) => set({ sort }),
    }),
    {
      name: 'tickerglass-watchlist-prefs',
      version: 1,
      partialize: (s) => ({
        activeId: s.activeId,
        columns: s.columns,
        sort: s.sort,
        collapsed: s.collapsed,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...parsePrefs(persisted),
        collapsed: parseCollapsed(isObj(persisted) ? persisted.collapsed : undefined),
      }),
    },
  ),
);
