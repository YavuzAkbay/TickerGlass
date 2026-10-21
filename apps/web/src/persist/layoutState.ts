/**
 * What a layout stores (docs/persistence.md §6): the chart grid, the sync
 * flags, the active chart, and per chart the engine chart state, the
 * indicator instances, the compare overlays and the chart settings.
 * The client owns this shape; bump LAYOUT_SCHEMA_VERSION and add an upgrade
 * step when it changes.
 */
import type { Chart, ChartState, ChartStyle, ChartType, DeepPartial } from '@tickerglass/engine';
import { resolveIndicatorId } from '@tickerglass/indicators';
import type { StoreApi } from 'zustand';
import { PRIMARY_CHART_ID } from '../chart/ids';
import { useHistory, type HistoryState } from '../commands/history';
import { comparePaneId, parseCompareLayout, type CompareLayout } from '../compare/model';
import { compareLayoutOf, useCompareStore, type CompareStore } from '../compare/store';
import { DEFAULT_VOLUME_ID, withLegacyVolume, type IndicatorState } from '../indicators/model';
import {
  useIndicatorPreview,
  useIndicatorStore,
  type IndicatorPreviewState,
  type IndicatorStore,
} from '../indicators/store';
import {
  DEFAULT_SYNC_FLAGS,
  leaf,
  leaves,
  mapLeaves,
  normalise,
  parseSyncFlags,
  type GridNode,
  type SyncFlags,
} from '../layout/grid';
import { useLayoutGrid } from '../layout/store';
import { whenMounted } from '../layout/mounted';
import { MAX_CHARTS, template as templateTree } from '../layout/templates';
import { normalizeSymbol, useAppStore } from '../store/app';
import {
  parseStatusLine,
  useChartView,
  type ChartViewState,
  type StatusLineSettings,
} from '../store/chartView';
import { setActiveChart, useChartStore } from '../store/chart';
import { isObj } from './net';

export const LAYOUT_SCHEMA_VERSION = 5;

export interface ChartSettings {
  chartType: ChartType;
  chartStyle: DeepPartial<ChartStyle>;
  showPrevClose: boolean;
  timezone: string;
  prepost: boolean;
  statusLine: StatusLineSettings;
}

/** One chart of a layout. */
export interface ChartSlotState {
  id: string;
  /** null until the chart existed (e.g. a layout created before the chart mounted). */
  chart: ChartState | null;
  indicators: IndicatorState[];
  compares: CompareLayout;
  chartSettings: ChartSettings;
}

export interface LayoutState {
  /** Picker label of the template the grid came from; the grid itself is stored resolved. */
  template: string | null;
  grid: GridNode;
  /** In grid (reading) order. */
  charts: ChartSlotState[];
  activeChartId: string;
  sync: SyncFlags;
}

/** The stores one chart slot is captured from and applied to (a ChartSession, or the facades). */
interface SlotStores {
  view: StoreApi<ChartViewState>;
  indicators: StoreApi<IndicatorStore>;
  preview: StoreApi<IndicatorPreviewState>;
  compares: StoreApi<CompareStore>;
  history: StoreApi<HistoryState>;
}

/** The active chart's stores. */
const ACTIVE: SlotStores = {
  view: useChartView,
  indicators: useIndicatorStore,
  preview: useIndicatorPreview,
  compares: useCompareStore,
  history: useHistory,
};

const chartSettingsOf = (view: StoreApi<ChartViewState>): ChartSettings => {
  const s = view.getState();
  return {
    chartType: s.chartType,
    chartStyle: s.chartStyle,
    showPrevClose: s.showPrevClose,
    timezone: s.timezone,
    prepost: s.prepost,
    statusLine: s.statusLine,
  };
};

/** The active chart's settings. */
export const currentChartSettings = (): ChartSettings => chartSettingsOf(useChartView);

const captureSlot = (id: string, stores: SlotStores, chart: Chart | null): ChartSlotState => ({
  id,
  chart: chart ? chart.getState() : null,
  indicators: stores.indicators.getState().instances,
  compares: compareLayoutOf(stores.compares),
  chartSettings: chartSettingsOf(stores.view),
});

/** The slot of `state` the single mounted chart shows: the active one, else the first. */
export const activeSlot = (state: LayoutState): ChartSlotState =>
  state.charts.find((c) => c.id === state.activeChartId) ?? state.charts[0]!;

/**
 * Whether slot `id` (which has no session of its own) is shown by the
 * focused chart: until the grid mounts one cell per slot, the active slot of
 * a layout whose ids differ from the mounted charts' is shown there.
 */
function bridgesToFocused(id: string, slotIds: readonly string[]): boolean {
  const { sessions, activeId } = useChartStore.getState();
  if (sessions.has(id)) return false;
  return activeId === null || !slotIds.includes(activeId);
}

/**
 * The current layout state. Each grid leaf is captured from its chart
 * session; the layout's active slot falls back to the focused chart (and
 * `chart`); slots without a mounted chart keep their last applied state.
 */
export function captureLayoutState(
  chart: Chart | null = useChartStore.getState().chart,
): LayoutState {
  const lg = useLayoutGrid.getState();
  const { sessions, activeId: focused } = useChartStore.getState();
  const ids = leaves(lg.grid);
  const charts = ids.map((id) => {
    const session = sessions.get(id);
    if (session) return captureSlot(id, session, session.chart);
    if (id === lg.activeId && bridgesToFocused(id, ids)) return captureSlot(id, ACTIVE, chart);
    return (
      lg.slots[id] ?? {
        id,
        chart: null,
        indicators: [],
        compares: { items: [], scaleRestore: null },
        chartSettings: currentChartSettings(),
      }
    );
  });
  return {
    template: lg.template,
    grid: lg.grid,
    charts,
    activeChartId: focused !== null && ids.includes(focused) ? focused : lg.activeId,
    sync: lg.sync,
  };
}

const isIndicator = (v: unknown): v is IndicatorState =>
  isObj(v) &&
  typeof v.id === 'string' &&
  typeof v.type === 'string' &&
  isObj(v.inputs) &&
  isObj(v.styles);

const isChartState = (v: unknown): v is ChartState =>
  isObj(v) &&
  v.version === 1 &&
  typeof v.symbol === 'string' &&
  typeof v.interval === 'string' &&
  isObj(v.timeScale) &&
  Array.isArray(v.panes);

/**
 * v1 -> v2: the engine's built-in volume (`chartSettings.volume`, mirrored in
 * `chart.volume`) became the Volume indicator. 'overlay' adds it to the price
 * pane, 'pane' to its own pane (taking over the old volume pane's size); the
 * built-in volume is dropped. Idempotent and content based, because the local
 * cache and recovery copies store no schema version and are read as v1.
 */
export function migrateLegacyVolume(state: Record<string, unknown>): Record<string, unknown> {
  const cs = isObj(state.chartSettings) ? state.chartSettings : null;
  const chart = isObj(state.chart) ? state.chart : null;
  const mode = cs && 'volume' in cs ? cs.volume : chart?.volume;
  if (mode === undefined) return state;
  const out: Record<string, unknown> = { ...state };
  if (cs) {
    const { volume: _v, ...rest } = cs;
    out.chartSettings = rest;
  }
  const list = (Array.isArray(state.indicators) ? state.indicators : []).filter(isObj);
  const indicators = withLegacyVolume(list as { type: string }[], mode);
  const added = indicators.length > list.length;
  if (added) out.indicators = indicators;
  if (chart) {
    const ownPane = `pane-${DEFAULT_VOLUME_ID}`;
    out.chart = { ...chart, volume: 'hidden' };
    if (Array.isArray(chart.panes))
      // The old volume pane keeps its size as the Volume indicator's own pane.
      (out.chart as Record<string, unknown>).panes =
        added && mode === 'pane'
          ? chart.panes.map((p) => (isObj(p) && p.id === 'volume' ? { ...p, id: ownPane } : p))
          : chart.panes.filter((p) => !(isObj(p) && p.id === 'volume'));
  }
  return out;
}

/** v3 -> v4: instances of renamed built-ins get their current type id. */
export function migrateRenamedIndicators(s: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(s.indicators)) return s;
  return {
    ...s,
    indicators: s.indicators.map((i) =>
      isObj(i) && typeof i.type === 'string' ? { ...i, type: resolveIndicatorId(i.type) } : i,
    ),
  };
}

/**
 * v4 -> v5: one chart became a grid of charts. The single-chart state becomes
 * chart 'c1' of a one-leaf grid with the default sync flags. Content based
 * (a state that already has `charts` is unchanged) and deterministic, so
 * unversioned cached copies read as v1 upgrade to the same state every time.
 */
export function wrapSingleChart(s: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(s.charts)) return s;
  const slot: Record<string, unknown> = { id: PRIMARY_CHART_ID };
  for (const k of ['chart', 'indicators', 'compares', 'chartSettings'] as const)
    if (k in s) slot[k] = s[k];
  return {
    template: '1',
    grid: leaf(PRIMARY_CHART_ID),
    charts: [slot],
    activeChartId: PRIMARY_CHART_ID,
    sync: { ...DEFAULT_SYNC_FLAGS },
  };
}

/** Upgrade steps: `UPGRADES[v]` turns a version-v state into version v + 1. */
const UPGRADES: Record<number, (old: Record<string, unknown>) => Record<string, unknown>> = {
  1: migrateLegacyVolume,
  // v2 -> v3: compare overlays (none before). Content based like v1 -> v2.
  2: (s) =>
    'compares' in s || Array.isArray(s.charts)
      ? s
      : { ...s, compares: { items: [], scaleRestore: null } },
  // v3 -> v4: some built-in indicators were renamed (see LEGACY_INDICATOR_IDS).
  3: migrateRenamedIndicators,
  4: wrapSingleChart,
};

/** One stored chart slot; null without a usable id. Missing parts fall back to `base`. */
function parseSlot(raw: unknown, base: ChartSettings): ChartSlotState | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const cs = isObj(raw.chartSettings) ? raw.chartSettings : {};
  const pick = <K extends keyof ChartSettings>(k: K, ok: (v: unknown) => boolean) =>
    (ok(cs[k]) ? cs[k] : base[k]) as ChartSettings[K];
  return {
    id: raw.id,
    chart: isChartState(raw.chart) ? raw.chart : null,
    indicators: Array.isArray(raw.indicators)
      ? raw.indicators.filter(isIndicator).map((i) => ({
          ...i,
          visible: i.visible !== false,
          visibility: i.visibility ?? null,
          placement: i.placement ?? 'auto',
        }))
      : [],
    compares: parseCompareLayout(raw.compares),
    chartSettings: {
      chartType: pick('chartType', (v) => typeof v === 'string'),
      chartStyle: pick('chartStyle', isObj),
      showPrevClose: pick('showPrevClose', (v) => typeof v === 'boolean'),
      timezone: pick('timezone', (v) => typeof v === 'string'),
      prepost: pick('prepost', (v) => typeof v === 'boolean'),
      // Layouts saved before the status line settings have none: defaults.
      statusLine: parseStatusLine(cs.statusLine ?? base.statusLine),
    },
  };
}

/**
 * Read a stored layout state of `schemaVersion`. Missing or invalid parts fall
 * back to the current app values; null if the version is newer than this client.
 * Charts need a unique id and a grid leaf (charts without one are dropped);
 * an invalid grid is rebuilt from the template for the chart count.
 */
export function parseLayoutState(raw: unknown, schemaVersion = 1): LayoutState | null {
  if (schemaVersion > LAYOUT_SCHEMA_VERSION) return null;
  let state: Record<string, unknown> = isObj(raw) ? raw : {};
  for (let v = schemaVersion; v < LAYOUT_SCHEMA_VERSION; v++) state = UPGRADES[v]?.(state) ?? state;
  const base = currentChartSettings();
  const seen = new Set<string>();
  let charts = (Array.isArray(state.charts) ? state.charts : []).flatMap((c) => {
    const slot = parseSlot(c, base);
    if (!slot || seen.has(slot.id)) return [];
    seen.add(slot.id);
    return [slot];
  });
  if (charts.length === 0) charts = [parseSlot({ id: PRIMARY_CHART_ID }, base)!];
  // A layout holds at most MAX_CHARTS charts; later ones (and their cells) are dropped.
  if (charts.length > MAX_CHARTS) {
    charts = charts.slice(0, MAX_CHARTS);
    seen.clear();
    charts.forEach((c) => seen.add(c.id));
  }
  let grid = normalise(state.grid, seen);
  if (!grid) {
    const ids = charts.map((c) => c.id);
    const tree = templateTree(ids.length) ?? templateTree(1)!;
    grid = mapLeaves(tree, (_, i) => ids[i]!);
  }
  const order = leaves(grid);
  const byId = new Map(charts.map((c) => [c.id, c]));
  charts = order.map((id) => byId.get(id)!);
  const activeChartId =
    typeof state.activeChartId === 'string' && byId.has(state.activeChartId)
      ? state.activeChartId
      : order[0]!;
  return {
    template: typeof state.template === 'string' ? state.template : null,
    grid,
    charts,
    activeChartId,
    sync: parseSyncFlags(state.sync),
  };
}

/** Indicator instances from untrusted data (an indicator template), upgraded like a layout's. */
export const parseIndicatorList = (raw: unknown): IndicatorState[] =>
  parseLayoutState({ indicators: raw })?.charts[0]?.indicators ?? [];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `state` with every chart id that is not a UUID (the legacy 'c1') or is
 * repeated given a fresh one, in the grid and as the active chart too. Run
 * before chart-bound drawings exist: their chartId must be unique across
 * layouts.
 */
export function ensureUniqueChartIds(
  state: LayoutState,
  newId: () => string = () => crypto.randomUUID(),
): LayoutState {
  const seen = new Set<string>();
  const renamed = new Map<string, string>();
  const charts = state.charts.map((c) => {
    if (UUID.test(c.id) && !seen.has(c.id)) {
      seen.add(c.id);
      return c;
    }
    let id = newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    renamed.set(c.id, id);
    return { ...c, id };
  });
  if (renamed.size === 0) return state;
  return {
    ...state,
    grid: mapLeaves(state.grid, (id) => renamed.get(id) ?? id),
    charts,
    activeChartId: renamed.get(state.activeChartId) ?? state.activeChartId,
  };
}

/**
 * `state` with a fresh id for every chart (grid and active chart too). For
 * "Save as" and "Copy": chart-bound drawings reference chart ids, so the copy
 * must not share ids with the layout it came from. The copy starts without the
 * source's chart-bound drawings (shared drawings are unaffected).
 */
export function rekeyChartIds(
  state: LayoutState,
  newId: () => string = () => crypto.randomUUID(),
): LayoutState {
  const renamed = new Map<string, string>();
  const charts = state.charts.map((c) => {
    const id = newId();
    renamed.set(c.id, id);
    return { ...c, id };
  });
  return {
    ...state,
    grid: mapLeaves(state.grid, (id) => renamed.get(id) ?? id),
    charts,
    activeChartId: renamed.get(state.activeChartId) ?? state.activeChartId,
  };
}

/** Stable comparison key (JSON) of a state, for "did anything change". */
export const stateKey = (s: LayoutState): string => JSON.stringify(s);

/**
 * Make chart `stores`/`chart` show `slot`: chart settings and symbol/interval
 * in the view store, the indicator and compare lists, then the engine state
 * (panes, scales, view). The lists go first: setState drops the engine's
 * studies and the controllers re-add them from the stores.
 * Clears the undo history (steps of another layout make no sense here).
 */
async function applySlot(slot: ChartSlotState, stores: SlotStores, chart: Chart | null) {
  const patch: Parameters<ChartViewState['set']>[0] = { ...slot.chartSettings };
  if (slot.chart) {
    patch.symbol = normalizeSymbol(slot.chart.symbol);
    patch.interval = slot.chart.interval;
  }
  stores.view.getState().set(patch);
  stores.preview.setState({ overrides: {} });
  stores.indicators.getState().replaceAll(slot.indicators);
  // Fires the compare controller's sync before chart.setState: harmless, as
  // setState emits studiesCleared and the controller re-adds every study then.
  stores.compares.getState().replaceAll(slot.compares);
  stores.history.getState().clear();
  if (!chart || !slot.chart) return;
  // Crosshair/magnet are user preferences, not layout state: keep the current ones.
  const now = useAppStore.getState();
  try {
    await chart.setState({
      ...slot.chart,
      chartType: slot.chartSettings.chartType,
      // Volume is the Volume indicator; the engine's built-in one stays off.
      volume: 'hidden',
      timezone: slot.chartSettings.timezone,
      crosshair: { mode: now.crosshair, magnet: now.magnet },
    });
  } catch (err) {
    // A failed bar load is reported by the chart itself; the layout is applied.
    console.error(err);
  }
  removeOrphanComparePanes(chart, slot.compares);
}

/**
 * Make the app show `state`: the grid, sync flags and every slot go to the
 * layout grid store; each slot with a mounted chart session is applied to it,
 * and the active slot to the focused chart (and `chart`) when it has no
 * session of its own.
 */
export async function applyLayoutState(
  state: LayoutState,
  chart: Chart | null = useChartStore.getState().chart,
): Promise<void> {
  const active = activeSlot(state);
  useLayoutGrid.setState({
    template: state.template,
    grid: state.grid,
    sync: state.sync,
    activeId: active.id,
    slots: Object.fromEntries(state.charts.map((c) => [c.id, c])),
  });
  const ids = state.charts.map((c) => c.id);
  // The grid mounts a cell per chart; their sessions must exist before slots apply.
  await whenMounted(ids);
  setActiveChart(active.id);
  const { sessions } = useChartStore.getState();
  await Promise.all(
    state.charts.map((slot) => {
      const session = sessions.get(slot.id);
      if (session) return applySlot(slot, session, session.chart);
      if (slot === active && bridgesToFocused(slot.id, ids)) return applySlot(slot, ACTIVE, chart);
      return undefined;
    }),
  );
}

/** Drops `pane-cmp-*` panes whose compare item parseCompareLayout dropped. */
function removeOrphanComparePanes(chart: Chart, compares: CompareLayout): void {
  const keep = new Set(compares.items.map((i) => comparePaneId(i.id)));
  for (const p of chart.getState().panes)
    if (p.id.startsWith('pane-cmp-') && !keep.has(p.id)) chart.removePane(p.id);
}
