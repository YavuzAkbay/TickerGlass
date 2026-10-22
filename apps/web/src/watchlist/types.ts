/** Watchlist data model (docs/persistence.md; api userdata/schemas.py). */

export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'] as const;
export type FlagColor = (typeof FLAG_COLORS)[number];

export type WatchlistItem =
  | { type: 'symbol'; symbol: string }
  | { type: 'section'; id: string; title: string; collapsed?: boolean };

/** Wire shape of a stored list. */
export interface Watchlist {
  id: string;
  name: string;
  items: WatchlistItem[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Wire shape of a stored flag. */
export interface Flag {
  symbol: string;
  color: FlagColor;
  createdAt: string;
  updatedAt: string;
}

export interface WatchlistEntry {
  id: string;
  name: string;
  items: WatchlistItem[];
  /** null = not on the server yet. */
  revision: number | null;
  /** Edited locally since the last successful save. */
  dirty: boolean;
}

/** A watchlist id or a virtual flag list `flag:<color>`. */
export type ListRef = string;
export const flagRef = (c: FlagColor): ListRef => `flag:${c}`;

export type ColumnId =
  'last' | 'change' | 'changePercent' | 'volume' | 'extPrice' | 'extChangePercent' | 'trend';
/** Canonical display order. */
export const ALL_COLUMNS: readonly ColumnId[] = [
  'last',
  'change',
  'changePercent',
  'volume',
  'extPrice',
  'extChangePercent',
  'trend',
];
export type SortKey = 'symbol' | ColumnId;
export interface SortSpec {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export interface WatchlistPrefs {
  activeId: ListRef | null;
  columns: ColumnId[];
  sort: SortSpec | null;
}

export type Row =
  | { kind: 'section'; id: string; title: string; collapsed: boolean; count: number; index: number }
  | {
      kind: 'symbol';
      symbol: string;
      sectionId: string | null;
      /** Index in items; -1 in flag lists. */
      index: number;
    };
