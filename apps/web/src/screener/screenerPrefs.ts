import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { isViewMode, type ViewMode } from '../heatmap/viewMode';
import {
  EMPTY_FILTERS,
  PAGE_SIZES,
  SCREENER_SORT_KEYS,
  type ScreenerFilters,
  type ScreenerSort,
  type ScreenerSortKey,
} from './model';
import { PRESETS, presetSort, type PresetId } from './presets';
import {
  DEFAULT_SERVER_COLUMNS,
  formulaColumnId,
  isFormulaColumn,
  MAX_FORMULA_COLUMNS,
  normalizeServerColumns,
  SERVER_ALL_COLUMNS,
  SERVER_PAGE_SIZES,
  type FormulaColumnId,
  type ServerColumn,
  type ServerColumnId,
} from './server/columns';
import { defaultSpec, parseSpec } from './server/spec';
import type { Group, ScanSort, ScreenSpec, Universe as ScanUniverse } from './server/types';
import type { ScreenerClass } from './universe/types';
import { SCREENER_CLASSES } from './universe/types';

/** Longest name of a formula column. */
export const MAX_FORMULA_LABEL = 60;

/** Columns of the screener table, in canonical display order. */
export const SCREENER_ALL_COLUMNS = [
  'name',
  'last',
  'change',
  'changePercent',
  'prevClose',
  'volume',
  'relVolume',
  'turnover',
  'dayRange',
  'week52Range',
  'extChangePercent',
  'cap',
  'liveCap',
  'group',
  'exchange',
  'trend',
] as const;

export type ScreenerColumnId = (typeof SCREENER_ALL_COLUMNS)[number];

const SORT_KEYS: readonly string[] = SCREENER_SORT_KEYS;

/** Smallest universe slice a saved preference may name. */
export const MIN_UNIVERSE_SIZE = 20;

export type Density = 'compact' | 'cozy';

/** Rows of the table (and tiles of the heatmap) are grouped by sector or by the universe's group. */
export type ScreenerGroupBy = 'none' | 'sector' | 'group';
export const SCREENER_GROUP_BYS: readonly ScreenerGroupBy[] = ['none', 'sector', 'group'];

/** Row height in px per density (shared by the table, virtualizer and CSS). */
export const ROW_H: Record<Density, number> = { compact: 28, cozy: 36 };

export interface ScreenerPrefs {
  tab: ScreenerClass;
  /** Filters are remembered per class (a crypto group means nothing to stocks). */
  filters: Record<ScreenerClass, ScreenerFilters>;
  sort: ScreenerSort | null;
  /**
   * Rows per page of the pager (Finviz-style; `null` = all matches, default
   * 20 keeps the scan slice small).
   */
  pageSize: number | null;
  /** 0-based page; follows the filters, never saved. */
  page: number;
  /** Universe slice scanned; `null` = whole bundled universe. */
  universeSize: number | null;
  columns: ScreenerColumnId[];
  density: Density;
  detailOpen: boolean;
  /**
   * Draft screen of the server screener (universe, rule filter, sort): the same
   * `ScreenSpec` a saved screen holds. Client mode ignores it, bar the class
   * (`tab`), so switching modes never loses it.
   */
  draft: ScreenSpec;
  /** Saved screen the draft was loaded from (shown as modified when they differ). */
  activeScreenId: string | null;
  /** Visible columns of the server table (fixed ids, then up to 3 `"=<formula>"` columns). */
  serverColumns: ServerColumn[];
  /** User-given names of formula columns (id -> name); unnamed ones show the formula. */
  formulaLabels: Record<string, string>;
  /** Results as a table or as a heatmap (both engines). */
  view: ViewMode;
  /** Grouping of the table's rows and the heatmap's tiles. */
  groupBy: ScreenerGroupBy;
}

const DEFAULT_COLUMNS: ScreenerColumnId[] = [
  'name',
  'last',
  'change',
  'changePercent',
  'volume',
  'dayRange',
  'trend',
];

export const DEFAULT_SCREENER_PREFS: ScreenerPrefs = {
  tab: 'stocks',
  filters: {
    stocks: { ...EMPTY_FILTERS },
    etfs: { ...EMPTY_FILTERS },
    commodities: { ...EMPTY_FILTERS },
    crypto: { ...EMPTY_FILTERS },
  },
  sort: null,
  pageSize: 20,
  page: 0,
  universeSize: 100,
  columns: DEFAULT_COLUMNS,
  density: 'cozy',
  detailOpen: true,
  draft: defaultSpec('stocks'),
  activeScreenId: null,
  serverColumns: DEFAULT_SERVER_COLUMNS,
  formulaLabels: {},
  view: 'table',
  groupBy: 'none',
};

const NUM_BOUNDS: readonly (keyof ScreenerFilters)[] = [
  'priceMin',
  'priceMax',
  'chgMin',
  'chgMax',
  'volMin',
  'volMax',
  'capMin',
];

function parseFilters(v: unknown): ScreenerFilters {
  const out: ScreenerFilters = { ...EMPTY_FILTERS };
  if (!isObj(v)) return out;
  if (typeof v.search === 'string') out.search = v.search.slice(0, 200);
  if (typeof v.group === 'string') out.group = v.group;
  else if (v.group === null) out.group = null;
  if (typeof v.exchange === 'string') out.exchange = v.exchange;
  else if (v.exchange === null) out.exchange = null;
  for (const key of NUM_BOUNDS) {
    const value = v[key];
    if (typeof value === 'number' && Number.isFinite(value))
      (out as unknown as Record<string, number>)[key] = value;
  }
  return out;
}

/** Validate persisted/server prefs; unknown or stale fields fall back. */
export function parseScreenerPrefs(v: unknown): Partial<ScreenerPrefs> {
  const out: Partial<ScreenerPrefs> = {};
  if (!isObj(v)) return out;
  if (typeof v.tab === 'string' && (SCREENER_CLASSES as readonly string[]).includes(v.tab))
    out.tab = v.tab as ScreenerClass;
  if (isObj(v.filters)) {
    const filters = {} as Record<ScreenerClass, ScreenerFilters>;
    for (const cls of SCREENER_CLASSES) filters[cls] = parseFilters(v.filters[cls]);
    out.filters = filters;
  }
  if (v.sort === null) {
    out.sort = null;
  } else if (
    isObj(v.sort) &&
    typeof v.sort.key === 'string' &&
    SORT_KEYS.includes(v.sort.key) &&
    (v.sort.dir === 'asc' || v.sort.dir === 'desc')
  )
    out.sort = { key: v.sort.key as ScreenerSortKey, dir: v.sort.dir };
  // Back-compat: `preset` used to be stored; with no sort of its own it still applies.
  if (!('sort' in v) && typeof v.preset === 'string') {
    const sort = PRESETS.find((p) => p.id === v.preset)?.sort;
    if (sort) out.sort = { ...sort };
  }
  // The client table and the server table offer different sets (500 is server only).
  if (
    v.pageSize === null ||
    (typeof v.pageSize === 'number' &&
      (PAGE_SIZES.includes(v.pageSize) || SERVER_PAGE_SIZES.includes(v.pageSize)))
  )
    out.pageSize = v.pageSize;
  if (
    v.universeSize === null ||
    (typeof v.universeSize === 'number' &&
      Number.isInteger(v.universeSize) &&
      v.universeSize >= MIN_UNIVERSE_SIZE)
  )
    out.universeSize = v.universeSize;
  if (Array.isArray(v.columns)) {
    const set = new Set(v.columns);
    out.columns = SCREENER_ALL_COLUMNS.filter((c) => set.has(c));
  }
  if (v.density === 'compact' || v.density === 'cozy') out.density = v.density;
  if (typeof v.detailOpen === 'boolean') out.detailOpen = v.detailOpen;
  const draft = parseSpec(v.draft);
  if (draft) out.draft = draft;
  if (typeof v.activeScreenId === 'string' && v.activeScreenId)
    out.activeScreenId = v.activeScreenId;
  else if (v.activeScreenId === null) out.activeScreenId = null;
  if (Array.isArray(v.serverColumns)) out.serverColumns = normalizeServerColumns(v.serverColumns);
  if (isObj(v.formulaLabels)) {
    const labels: Record<string, string> = {};
    for (const [id, name] of Object.entries(v.formulaLabels))
      if (isFormulaColumn(id) && typeof name === 'string' && name.trim())
        labels[id] = name.trim().slice(0, MAX_FORMULA_LABEL);
    out.formulaLabels = labels;
  }
  if (isViewMode(v.view)) out.view = v.view;
  if (
    typeof v.groupBy === 'string' &&
    (SCREENER_GROUP_BYS as readonly string[]).includes(v.groupBy)
  )
    out.groupBy = v.groupBy as ScreenerGroupBy;
  return out;
}

interface ScreenerPrefsState extends ScreenerPrefs {
  setTab: (tab: ScreenerClass) => void;
  setFilters: (cls: ScreenerClass, filters: ScreenerFilters) => void;
  /** Preset click: applies its sort (null clears it); the active preset is derived from the sort. */
  setPreset: (preset: PresetId | null) => void;
  setSort: (sort: ScreenerSort | null) => void;
  setPageSize: (size: number | null) => void;
  setPage: (page: number) => void;
  setUniverseSize: (size: number | null) => void;
  toggleColumn: (id: ScreenerColumnId) => void;
  setDensity: (density: Density) => void;
  setDetailOpen: (open: boolean) => void;
  /** Server screener: pick the universe (a class also moves the class tab). */
  setUniverse: (universe: ScanUniverse) => void;
  setDraftFilter: (filter: Group | null) => void;
  setDraftSort: (sort: ScanSort) => void;
  /** Load a saved screen / preset as the draft (`screenId` null for a preset). */
  applySpec: (spec: ScreenSpec, screenId: string | null) => void;
  setActiveScreen: (id: string | null) => void;
  toggleServerColumn: (id: ServerColumnId) => void;
  /** Add a formula column (no-op when present or at the limit); `label` names it. */
  addFormulaColumn: (formula: string, label?: string) => void;
  removeFormulaColumn: (id: FormulaColumnId) => void;
  setView: (view: ViewMode) => void;
  setGroupBy: (groupBy: ScreenerGroupBy) => void;
}

/**
 * Version 2: `resultLimit` (10 default + show-more) became the page size pager.
 * Version 3: the stored `preset` is gone (derived from the sort), sort keys
 * and columns grew.
 * Version 4: server screener draft (`draft`, `activeScreenId`, `serverColumns`).
 * Also additive, without a bump: `view` (table | heatmap), `groupBy`, formula columns in
 * `serverColumns` and their `formulaLabels`.
 * Purely additive: older data parses unchanged and the new keys take their defaults.
 */
export const SCREENER_PREFS_VERSION = 4;

/** Upgrade stored prefs written by an older `SCREENER_PREFS_VERSION`. */
export function migrateScreenerPrefs(persisted: unknown, from: number): unknown {
  // v1 stored `resultLimit` (default 10, "show more"); the pager replaces it.
  if (from < 2 && isObj(persisted)) {
    const { resultLimit: _dropped, ...rest } = persisted;
    persisted = rest;
  }
  // v2 stored `preset` next to `sort`; it is derived now. A preset without a
  // sort (hand-edited or older builds) still resolves to its sort.
  if (from < 3 && isObj(persisted)) {
    const { preset, ...rest } = persisted;
    const hasSort = 'sort' in rest && rest.sort !== undefined;
    const fromPreset = PRESETS.find((p) => p.id === preset)?.sort;
    persisted = !hasSort && fromPreset ? { ...rest, sort: fromPreset } : rest;
  }
  // v3 -> v4 adds keys only; `parseScreenerPrefs` fills their defaults.
  return persisted;
}

/** Preferences of the screener screen (kept on this device only). */
export const useScreenerPrefs = create<ScreenerPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SCREENER_PREFS,
      setTab: (tab) =>
        set((s) => ({
          tab,
          page: 0,
          draft: { ...s.draft, universe: { kind: 'class', cls: tab } },
        })),
      setFilters: (cls, filters) =>
        set((s) => ({ filters: { ...s.filters, [cls]: filters }, page: 0 })),
      setPreset: (preset) => set({ sort: presetSort(preset), page: 0 }),
      setSort: (sort) => set({ sort, page: 0 }),
      setPageSize: (pageSize) => set({ pageSize, page: 0 }),
      setPage: (page) => set({ page: Math.max(0, Math.round(page)) }),
      setUniverseSize: (universeSize) => set({ universeSize, page: 0 }),
      toggleColumn: (id) =>
        set((s) => {
          const has = s.columns.includes(id);
          const columns = SCREENER_ALL_COLUMNS.filter((c) =>
            c === id ? !has : s.columns.includes(c),
          );
          return { columns };
        }),
      setDensity: (density) => set({ density }),
      setDetailOpen: (detailOpen) => set({ detailOpen }),
      setUniverse: (universe) =>
        set((s) => ({
          draft: { ...s.draft, universe },
          page: 0,
          ...(universe.kind === 'class' ? { tab: universe.cls } : {}),
        })),
      setDraftFilter: (filter) => set((s) => ({ draft: { ...s.draft, filter }, page: 0 })),
      setDraftSort: (sort) => set((s) => ({ draft: { ...s.draft, sort }, page: 0 })),
      applySpec: (spec, screenId) =>
        set((s) => {
          const cols = spec.columns ? normalizeServerColumns(spec.columns) : null;
          return {
            draft: spec,
            activeScreenId: screenId,
            page: 0,
            ...(spec.universe.kind === 'class' ? { tab: spec.universe.cls } : {}),
            ...(cols && cols.length ? { serverColumns: cols } : { serverColumns: s.serverColumns }),
          };
        }),
      setActiveScreen: (activeScreenId) => set({ activeScreenId }),
      toggleServerColumn: (id) =>
        set((s) => {
          const has = s.serverColumns.includes(id);
          return {
            serverColumns: [
              ...SERVER_ALL_COLUMNS.filter((c) => (c === id ? !has : s.serverColumns.includes(c))),
              ...s.serverColumns.filter(isFormulaColumn),
            ],
          };
        }),
      addFormulaColumn: (formula, label) =>
        set((s) => {
          const id = formulaColumnId(formula);
          const formulas = s.serverColumns.filter(isFormulaColumn);
          if (
            !isFormulaColumn(id) ||
            formulas.includes(id) ||
            formulas.length >= MAX_FORMULA_COLUMNS
          )
            return {};
          const name = label?.trim().slice(0, MAX_FORMULA_LABEL);
          return {
            serverColumns: [...s.serverColumns, id],
            ...(name ? { formulaLabels: { ...s.formulaLabels, [id]: name } } : {}),
          };
        }),
      removeFormulaColumn: (id) =>
        set((s) => {
          const { [id]: _gone, ...formulaLabels } = s.formulaLabels;
          return { serverColumns: s.serverColumns.filter((c) => c !== id), formulaLabels };
        }),
      setView: (view) => set({ view }),
      setGroupBy: (groupBy) => set({ groupBy }),
    }),
    {
      name: 'tickerglass-screener-prefs',
      version: SCREENER_PREFS_VERSION,
      migrate: migrateScreenerPrefs,
      partialize: (s) => ({
        tab: s.tab,
        filters: s.filters,
        sort: s.sort,
        pageSize: s.pageSize,
        universeSize: s.universeSize,
        columns: s.columns,
        density: s.density,
        detailOpen: s.detailOpen,
        draft: s.draft,
        activeScreenId: s.activeScreenId,
        serverColumns: s.serverColumns,
        formulaLabels: s.formulaLabels,
        view: s.view,
        groupBy: s.groupBy,
      }),
      merge: (persisted, current) => ({ ...current, ...parseScreenerPrefs(persisted) }),
    },
  ),
);
