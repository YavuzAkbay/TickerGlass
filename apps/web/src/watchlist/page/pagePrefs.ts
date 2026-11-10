import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../../persist/net';
import { isViewMode, type ViewMode } from '../../heatmap/viewMode';
import {
  DEFAULT_COLUMNS,
  clampWidth,
  parsePresets,
  parseWidths,
  presetFor,
  removePreset,
  upsertPreset,
  type ColumnPreset,
  type ColumnWidths,
} from '../columns/presets';
import {
  PAGE_COLUMN_IDS,
  moveColumn as moveInOrder,
  normalizeColumns,
  sortableFor,
  toggleInOrder,
  type Surface,
} from '../columns/registry';
import { FLAG_COLORS } from '../types';
import type { ColumnId, SortKey, SortSpec } from '../types';

/** Columns of the full-screen table, in canonical display order. */
export const PAGE_ALL_COLUMNS: readonly ColumnId[] = PAGE_COLUMN_IDS;

const SORT_KEYS: readonly string[] = ['symbol', ...sortableFor('page')];

export type Density = 'compact' | 'cozy';

/** Columns and sort remembered for one list ("Remember columns & sort per list"). */
export interface ColumnView {
  columns: ColumnId[];
  sort: SortSpec | null;
}

export interface PagePrefs {
  /**
   * The columns/sort the table shows (derived): the list's own view while `perList`
   * and it has one, else `global`. Edits go through the actions, never `setState`.
   */
  columns: ColumnId[];
  sort: SortSpec | null;
  /** Columns/sort shared by every list without its own view (the synced `columns`/`sort`). */
  global: ColumnView;
  detailOpen: boolean;
  /** The list as a table or as a heatmap (device-local, like `detailOpen`). */
  view: ViewMode;
  density: Density;
  /** Custom column widths in px (absent = the column's default track). */
  widths: ColumnWidths;
  /** User-saved column presets (shared with the sidebar's columns menu). */
  presets: ColumnPreset[];
  /** Keep a separate columns/sort per list. */
  perList: boolean;
  /** list id (or `flag:<color>`) -> its remembered view; only used while `perList`. */
  views: Record<string, ColumnView>;
}

export const DEFAULT_PAGE_PREFS: PagePrefs = {
  columns: [...DEFAULT_COLUMNS.page],
  sort: null,
  global: { columns: [...DEFAULT_COLUMNS.page], sort: null },
  detailOpen: true,
  view: 'table',
  density: 'cozy',
  widths: {},
  presets: [],
  perList: false,
  views: {},
};

/** Row height in px per density (shared by the table, the virtualizer and CSS). */
export const ROW_H: Record<Density, number> = { compact: 28, cozy: 36 };

/** Remembered list views kept (oldest dropped; deleted lists are pruned on top of this). */
export const MAX_VIEWS = 50;

function parseSort(v: unknown): SortSpec | null | undefined {
  if (v === null) return null;
  if (
    isObj(v) &&
    typeof v.key === 'string' &&
    SORT_KEYS.includes(v.key) &&
    (v.dir === 'asc' || v.dir === 'desc')
  )
    return { key: v.key as SortKey, dir: v.dir };
  return undefined;
}

/** Validate the per-list view map; the newest `MAX_VIEWS` entries (insertion order) are kept. */
export function parseViews(v: unknown): Record<string, ColumnView> {
  const out: Record<string, ColumnView> = {};
  if (!isObj(v)) return out;
  const valid: [string, ColumnView][] = [];
  for (const [id, raw] of Object.entries(v)) {
    if (id.length === 0 || id.length > 64 || !isObj(raw) || !Array.isArray(raw.columns)) continue;
    const columns = normalizeColumns(raw.columns, 'page');
    const sort = parseSort(raw.sort) ?? null;
    valid.push([
      id,
      { columns, sort: sort && sort.key !== 'symbol' && !columns.includes(sort.key) ? null : sort },
    ]);
  }
  for (const [id, view] of valid.slice(-MAX_VIEWS)) out[id] = view;
  return out;
}

const isFlagId = (id: string): boolean =>
  id.startsWith('flag:') && (FLAG_COLORS as readonly string[]).includes(id.slice(5));

/** Drop views of lists that no longer exist (flag lists always exist). */
export function pruneViews(
  views: Record<string, ColumnView>,
  listIds: Iterable<string>,
): Record<string, ColumnView> {
  const keep = new Set(listIds);
  const out: Record<string, ColumnView> = {};
  for (const [id, view] of Object.entries(views)) if (keep.has(id) || isFlagId(id)) out[id] = view;
  return out;
}

/** `views` with `id` set as the newest entry, capped. */
function putView(
  views: Record<string, ColumnView>,
  id: string,
  view: ColumnView,
): Record<string, ColumnView> {
  const next = { ...views };
  delete next[id];
  next[id] = view;
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_VIEWS))) delete next[k];
  return next;
}

/**
 * Validated persisted/server prefs (wire shape): `columns`/`sort` are the *global* layout,
 * which is what older clients stored there. Unknown or page-ineligible fields are dropped.
 */
export type ParsedPagePrefs = Partial<Omit<PagePrefs, 'global'>>;

export function parsePagePrefs(v: unknown): ParsedPagePrefs {
  const out: ParsedPagePrefs = {};
  if (!isObj(v)) return out;
  // The stored order is kept (users reorder columns on the page).
  if (Array.isArray(v.columns)) out.columns = normalizeColumns(v.columns, 'page');
  const sort = parseSort(v.sort);
  if (sort !== undefined) out.sort = sort;
  if (typeof v.detailOpen === 'boolean') out.detailOpen = v.detailOpen;
  if (isViewMode(v.view)) out.view = v.view;
  if (v.density === 'compact' || v.density === 'cozy') out.density = v.density;
  if (v.widths !== undefined) out.widths = parseWidths(v.widths);
  if (v.presets !== undefined) out.presets = parsePresets(v.presets);
  if (typeof v.perList === 'boolean') out.perList = v.perList;
  if (v.views !== undefined) out.views = parseViews(v.views);
  return out;
}

/** Columns/sort the table shows for the given prefs. */
function effectiveView(
  p: Pick<PagePrefs, 'perList' | 'views' | 'global'> & { activeViewId: string | null },
): ColumnView {
  return (p.perList && p.activeViewId ? p.views[p.activeViewId] : undefined) ?? p.global;
}

/** `columns`/`sort` (the derived display fields) for `p`, as a state patch. */
function shown(
  p: Pick<PagePrefs, 'perList' | 'views' | 'global'> & { activeViewId: string | null },
): Pick<PagePrefs, 'columns' | 'sort'> {
  const v = effectiveView(p);
  return { columns: [...v.columns], sort: v.sort };
}

interface PagePrefsState extends PagePrefs {
  /** The list the table shows (not persisted); per-list edits are recorded under it. */
  activeViewId: string | null;
  toggleColumn: (id: ColumnId) => void;
  /** Replace the shown columns (and widths, when given); a sort on a hidden column is cleared. */
  setColumns: (columns: ColumnId[], widths?: ColumnWidths) => void;
  /** Move a column to index `to` of the visible order. */
  moveColumn: (id: ColumnId, to: number) => void;
  /** Set a column's width in px; null = back to the default track. */
  setWidth: (id: ColumnId, px: number | null) => void;
  resetWidths: () => void;
  setSort: (sort: SortSpec | null) => void;
  setDetailOpen: (open: boolean) => void;
  setView: (view: ViewMode) => void;
  setDensity: (d: Density) => void;
  /** Save a layout under `name` (replaces the same name); false when the list is full. */
  savePreset: (
    name: string,
    columns: ColumnId[],
    widths?: ColumnWidths,
    surface?: Surface,
  ) => boolean;
  deletePreset: (name: string) => void;
  applyPreset: (preset: ColumnPreset) => void;
  setPerList: (on: boolean) => void;
  /** The table now shows list `id`: adopt its remembered view and record later changes under it. */
  enterList: (id: string | null) => void;
  /** Forget views of lists that no longer exist (everything but `listIds`; flag lists stay). */
  pruneViews: (listIds: Iterable<string>) => void;
  /** Forget the views of these (deleted) lists. */
  forgetViews: (ids: Iterable<string>) => void;
  /** Adopt parsed stored/server prefs (`columns`/`sort` land in `global`). */
  adopt: (parsed: ParsedPagePrefs) => void;
}

/**
 * A `columns`/`sort` edit: stored under the current list while `perList` (and a list is
 * shown), else as the global layout. Returns the state patch incl. the derived fields.
 */
function editView(
  s: PagePrefsState,
  patch: { columns?: ColumnId[]; sort?: SortSpec | null },
): Partial<PagePrefsState> {
  const cur = effectiveView(s);
  const columns = patch.columns ?? cur.columns;
  // A sort on a hidden (or unsortable) column is cleared.
  const wanted = patch.sort === undefined ? cur.sort : patch.sort;
  const sort = wanted && wanted.key !== 'symbol' && !columns.includes(wanted.key) ? null : wanted;
  if (s.perList && s.activeViewId)
    return {
      views: putView(s.views, s.activeViewId, { columns, sort }),
      columns: [...columns],
      sort,
    };
  return { global: { columns, sort }, columns: [...columns], sort };
}

/** State patch adopting parsed prefs. */
function adoptPatch(s: PagePrefsState, parsed: ParsedPagePrefs): Partial<PagePrefsState> {
  const { columns, sort, ...rest } = parsed;
  const global: ColumnView = {
    columns: columns ?? s.global.columns,
    sort: sort === undefined ? s.global.sort : sort,
  };
  return { ...rest, global, ...shown({ ...s, ...rest, global }) };
}

/** Preferences of the full-screen watchlists page (independent of the sidebar table's). */
export const useWatchlistPagePrefs = create<PagePrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PAGE_PREFS,
      activeViewId: null,
      toggleColumn: (id) =>
        set((s) => editView(s, { columns: toggleInOrder(effectiveView(s).columns, id, 'page') })),
      setColumns: (columns, widths) =>
        set((s) => ({
          ...editView(s, { columns: normalizeColumns(columns, 'page') }),
          ...(widths ? { widths } : {}),
        })),
      moveColumn: (id, to) =>
        set((s) => {
          const cur = effectiveView(s).columns;
          const columns = moveInOrder(cur, id, to);
          return columns.every((c, i) => c === cur[i]) ? s : editView(s, { columns });
        }),
      setWidth: (id, px) =>
        set((s) => {
          const widths = { ...s.widths };
          if (px === null) delete widths[id];
          else widths[id] = clampWidth(px);
          return { widths };
        }),
      resetWidths: () => set((s) => (Object.keys(s.widths).length ? { widths: {} } : s)),
      setSort: (sort) => set((s) => editView(s, { sort })),
      setDetailOpen: (detailOpen) => set({ detailOpen }),
      setView: (view) => set({ view }),
      setDensity: (density) => set({ density }),
      savePreset: (name, columns, widths = {}, surface = 'page') => {
        let ok = true;
        set((s) => {
          const kept: ColumnWidths = {};
          for (const c of columns) if (widths[c]) kept[c] = widths[c];
          const next = upsertPreset(s.presets, {
            name: name.trim(),
            columns: [...columns],
            widths: kept,
            surface,
          });
          if (!next) {
            ok = false;
            return s;
          }
          return { presets: parsePresets(next) };
        });
        return ok;
      },
      deletePreset: (name) => set((s) => ({ presets: removePreset(s.presets, name) })),
      applyPreset: (preset) =>
        set((s) => {
          const v = presetFor(preset, 'page');
          let columns = v.columns;
          // A sidebar layout has no Name column; keep the one the table shows.
          if (
            preset.surface === 'sidebar' &&
            !columns.includes('name') &&
            effectiveView(s).columns.includes('name')
          )
            columns = ['name', ...columns];
          // A preset without widths (e.g. from the sidebar) keeps the current widths.
          return {
            ...editView(s, { columns }),
            ...(Object.keys(v.widths).length ? { widths: v.widths } : {}),
          };
        }),
      setPerList: (perList) => set((s) => ({ perList, ...shown({ ...s, perList }) })),
      enterList: (id) =>
        set((s) =>
          s.activeViewId === id ? s : { activeViewId: id, ...shown({ ...s, activeViewId: id }) },
        ),
      pruneViews: (listIds) =>
        set((s) => {
          const views = pruneViews(s.views, listIds);
          return Object.keys(views).length === Object.keys(s.views).length
            ? s
            : { views, ...shown({ ...s, views }) };
        }),
      forgetViews: (ids) =>
        set((s) => {
          const gone = new Set(ids);
          const views = Object.fromEntries(Object.entries(s.views).filter(([id]) => !gone.has(id)));
          return Object.keys(views).length === Object.keys(s.views).length
            ? s
            : { views, ...shown({ ...s, views }) };
        }),
      adopt: (parsed) => set((s) => adoptPatch(s, parsed)),
    }),
    {
      name: 'tickerglass-watchlist-page',
      version: 1,
      // Wire shape: `columns`/`sort` hold the global layout.
      partialize: (s) => ({
        columns: s.global.columns,
        sort: s.global.sort,
        detailOpen: s.detailOpen,
        view: s.view,
        density: s.density,
        widths: s.widths,
        presets: s.presets,
        perList: s.perList,
        views: s.views,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...adoptPatch(current, parsePagePrefs(persisted)),
      }),
    },
  ),
);
