import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { isFlagRef } from './model';
import {
  ALL_COLUMNS,
  type ColumnId,
  type ListRef,
  type SortKey,
  type SortSpec,
  type WatchlistPrefs,
} from './types';

const SORT_KEYS: readonly string[] = ['symbol', ...ALL_COLUMNS.filter((c) => c !== 'trend')];

export const DEFAULT_PREFS: WatchlistPrefs = {
  activeId: null,
  columns: ['last', 'changePercent', 'trend'],
  sort: null,
};

/** Validate a value from the server or an import; invalid fields are left out. */
export function parsePrefs(v: unknown): Partial<WatchlistPrefs> {
  const out: Partial<WatchlistPrefs> = {};
  if (!isObj(v)) return out;
  if (v.activeId === null) out.activeId = null;
  else if (typeof v.activeId === 'string' && v.activeId.length > 0 && v.activeId.length <= 64)
    out.activeId = v.activeId.startsWith('flag:') && !isFlagRef(v.activeId) ? null : v.activeId;
  if (Array.isArray(v.columns)) {
    const set = new Set(v.columns);
    out.columns = ALL_COLUMNS.filter((c) => set.has(c));
  }
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

interface PrefsState extends WatchlistPrefs {
  setActive: (id: ListRef | null) => void;
  /** Toggle a column; columns stay in canonical order. */
  toggleColumn: (id: ColumnId) => void;
  setSort: (sort: SortSpec | null) => void;
}

export const useWatchlistPrefs = create<PrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      setActive: (activeId) => set({ activeId }),
      toggleColumn: (id) =>
        set((s) => {
          const has = s.columns.includes(id);
          const next = ALL_COLUMNS.filter((c) => (c === id ? !has : s.columns.includes(c)));
          // A sort on a hidden column is cleared.
          const sort =
            s.sort && s.sort.key !== 'symbol' && !next.includes(s.sort.key) ? null : s.sort;
          return { columns: next, sort };
        }),
      setSort: (sort) => set({ sort }),
    }),
    {
      name: 'tickerglass-watchlist-prefs',
      version: 1,
      partialize: (s) => ({ activeId: s.activeId, columns: s.columns, sort: s.sort }),
      merge: (persisted, current) => ({ ...current, ...parsePrefs(persisted) }),
    },
  ),
);
