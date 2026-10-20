import { DARK_THEME, LIGHT_THEME, createChart, type Chart } from '@investopen/engine';
import type { CrosshairInfo, SymbolInfo } from '@investopen/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createHistoryStore, type HistoryState } from '../commands/history';
import {
  createCompareRuntimeStore,
  createCompareStore,
  type CompareRuntimeState,
  type CompareStore,
} from '../compare/store';
import {
  createIndicatorPreviewStore,
  createIndicatorRuntimeStore,
  createIndicatorStore,
  type IndicatorPreviewState,
  type IndicatorRuntimeState,
  type IndicatorStore,
} from '../indicators/store';
import { useAppStore } from '../store/app';
import { createChartViewStore, type ChartViewData, type ChartViewState } from '../store/chartView';
import { feed } from './feed';

export { createActiveFacade } from './facade';

/** Id of the chart a single-chart layout has (and the one saved in localStorage). */
export const PRIMARY_CHART_ID = 'c1';

export interface ChartInfoState {
  symbolInfo: SymbolInfo | null;
  crosshair: CrosshairInfo | null;
  loading: boolean;
}

/** Everything one chart in the layout owns: the engine chart and its per-chart stores. */
export interface ChartSession {
  id: string;
  chart: Chart;
  view: StoreApi<ChartViewState>;
  indicators: StoreApi<IndicatorStore>;
  preview: StoreApi<IndicatorPreviewState>;
  indicatorRuntime: StoreApi<IndicatorRuntimeState>;
  compares: StoreApi<CompareStore>;
  compareRuntime: StoreApi<CompareRuntimeState>;
  history: StoreApi<HistoryState>;
  info: StoreApi<ChartInfoState>;
  /** Destroys the engine chart. Detach the controllers (attach* disposers) first. */
  destroy: () => void;
}

/** Create the engine chart in `host` and the stores for chart `id`; `initial` seeds its view. */
export function createChartSession(
  id: string,
  host: HTMLElement,
  initial: Partial<ChartViewData> | null,
): ChartSession {
  const view = createChartViewStore(initial ?? undefined);
  const v = view.getState();
  const app = useAppStore.getState();
  const chart = createChart(host, feed, {
    theme: app.theme === 'dark' ? DARK_THEME : LIGHT_THEME,
    timezone: v.timezone,
    prepost: v.prepost,
    crosshair: app.crosshair,
    magnet: app.magnet,
    showPrevClose: v.showPrevClose,
  });
  chart.setChartStyle(v.chartStyle);
  chart.setChartType(v.chartType);
  const info = createStore<ChartInfoState>()(() => ({
    symbolInfo: null,
    crosshair: null,
    loading: false,
  }));
  return {
    id,
    chart,
    view,
    indicators: createIndicatorStore(id === PRIMARY_CHART_ID),
    preview: createIndicatorPreviewStore(),
    indicatorRuntime: createIndicatorRuntimeStore(),
    compares: createCompareStore(),
    compareRuntime: createCompareRuntimeStore(),
    history: createHistoryStore(),
    info,
    destroy: () => chart.destroy(),
  };
}
