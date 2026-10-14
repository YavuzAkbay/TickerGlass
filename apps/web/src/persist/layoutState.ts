/**
 * What a layout stores (docs/persistence.md §6): the engine chart state, the
 * indicator instances, the compare overlays and the chart settings that live
 * in the app store.
 * The client owns this shape; bump LAYOUT_SCHEMA_VERSION and add an upgrade
 * step when it changes.
 */
import type { Chart, ChartState, ChartStyle, ChartType, DeepPartial } from '@investopen/engine';
import { useHistory } from '../commands/history';
import { parseCompareLayout, type CompareLayout } from '../compare/model';
import { currentCompareLayout, useCompareStore } from '../compare/store';
import { DEFAULT_VOLUME_ID, withLegacyVolume, type IndicatorState } from '../indicators/model';
import { useIndicatorPreview, useIndicatorStore } from '../indicators/store';
import { normalizeSymbol, useAppStore } from '../store/app';
import { useChartStore } from '../store/chart';
import { isObj } from './net';

export const LAYOUT_SCHEMA_VERSION = 3;

export interface ChartSettings {
  chartType: ChartType;
  chartStyle: DeepPartial<ChartStyle>;
  showPrevClose: boolean;
  timezone: string;
  prepost: boolean;
}

export interface LayoutState {
  /** null until the chart existed (e.g. a layout created before the chart mounted). */
  chart: ChartState | null;
  indicators: IndicatorState[];
  compares: CompareLayout;
  chartSettings: ChartSettings;
}

export function currentChartSettings(): ChartSettings {
  const s = useAppStore.getState();
  return {
    chartType: s.chartType,
    chartStyle: s.chartStyle,
    showPrevClose: s.showPrevClose,
    timezone: s.timezone,
    prepost: s.prepost,
  };
}

/** The current layout state (chart from `chart`, or a minimal one from the app store). */
export function captureLayoutState(
  chart: Chart | null = useChartStore.getState().chart,
): LayoutState {
  return {
    chart: chart ? chart.getState() : null,
    indicators: useIndicatorStore.getState().instances,
    compares: currentCompareLayout(),
    chartSettings: currentChartSettings(),
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

/** Upgrade steps: `UPGRADES[v]` turns a version-v state into version v + 1. */
const UPGRADES: Record<number, (old: Record<string, unknown>) => Record<string, unknown>> = {
  1: migrateLegacyVolume,
  // v2 -> v3: compare overlays (none before). Content based like v1 -> v2.
  2: (s) => ('compares' in s ? s : { ...s, compares: { items: [], scaleRestore: null } }),
};

/**
 * Read a stored layout state of `schemaVersion`. Missing or invalid parts fall
 * back to the current app values; null if the version is newer than this client.
 */
export function parseLayoutState(raw: unknown, schemaVersion = 1): LayoutState | null {
  if (schemaVersion > LAYOUT_SCHEMA_VERSION) return null;
  let state: Record<string, unknown> = isObj(raw) ? raw : {};
  for (let v = schemaVersion; v < LAYOUT_SCHEMA_VERSION; v++) state = UPGRADES[v]?.(state) ?? state;
  const base = currentChartSettings();
  const cs = isObj(state.chartSettings) ? state.chartSettings : {};
  const pick = <K extends keyof ChartSettings>(k: K, ok: (v: unknown) => boolean) =>
    (ok(cs[k]) ? cs[k] : base[k]) as ChartSettings[K];
  return {
    chart: isChartState(state.chart) ? state.chart : null,
    indicators: Array.isArray(state.indicators)
      ? state.indicators.filter(isIndicator).map((i) => ({
          ...i,
          visible: i.visible !== false,
          visibility: i.visibility ?? null,
          placement: i.placement ?? 'auto',
        }))
      : [],
    compares: parseCompareLayout(state.compares),
    chartSettings: {
      chartType: pick('chartType', (v) => typeof v === 'string'),
      chartStyle: pick('chartStyle', isObj),
      showPrevClose: pick('showPrevClose', (v) => typeof v === 'boolean'),
      timezone: pick('timezone', (v) => typeof v === 'string'),
      prepost: pick('prepost', (v) => typeof v === 'boolean'),
    },
  };
}

/** Stable comparison key (JSON) of a state, for "did anything change". */
export const stateKey = (s: LayoutState): string => JSON.stringify(s);

/**
 * Make the app show `state`: chart settings and symbol/interval in the app
 * store, the indicator and compare lists, then the engine state (panes,
 * scales, view). The lists go first: setState drops the engine's studies and
 * the controllers re-add them from the stores.
 * Clears the undo history (steps of another layout make no sense here).
 */
export async function applyLayoutState(
  state: LayoutState,
  chart: Chart | null = useChartStore.getState().chart,
): Promise<void> {
  const app = useAppStore.getState();
  const patch: Parameters<typeof app.set>[0] = { ...state.chartSettings };
  if (state.chart) {
    patch.symbol = normalizeSymbol(state.chart.symbol);
    patch.interval = state.chart.interval;
  }
  app.set(patch);
  useIndicatorPreview.setState({ overrides: {} });
  useIndicatorStore.getState().replaceAll(state.indicators);
  useCompareStore.getState().replaceAll(state.compares);
  useHistory.getState().clear();
  if (!chart || !state.chart) return;
  // Crosshair/magnet are user preferences, not layout state: keep the current ones.
  const now = useAppStore.getState();
  try {
    await chart.setState({
      ...state.chart,
      chartType: state.chartSettings.chartType,
      // Volume is the Volume indicator; the engine's built-in one stays off.
      volume: 'hidden',
      timezone: state.chartSettings.timezone,
      crosshair: { mode: now.crosshair, magnet: now.magnet },
    });
  } catch (err) {
    // A failed bar load is reported by the chart itself; the layout is applied.
    console.error(err);
  }
}
