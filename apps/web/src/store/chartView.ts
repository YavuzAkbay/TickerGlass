import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChartStyle, ChartType, DeepPartial } from '@investopen/engine';
import { createActiveFacade } from '../chart/facade';
import { normalizeSymbol, useAppStore } from './app';

/** What one chart shows: its symbol, interval and chart settings. */
export interface ChartViewData {
  symbol: string;
  interval: string;
  chartType: ChartType;
  /** Per-type style overrides on top of theme defaults. */
  chartStyle: DeepPartial<ChartStyle>;
  showPrevClose: boolean;
  timezone: string; // 'exchange' | 'local' | 'UTC' | IANA
  prepost: boolean;
}

export interface ChartViewState extends ChartViewData {
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
  set: (patch: Partial<ChartViewData>) => void;
}

export const DEFAULT_CHART_VIEW: ChartViewData = {
  symbol: 'AAPL',
  interval: '1D',
  chartType: 'candles',
  chartStyle: {},
  showPrevClose: false,
  timezone: 'exchange',
  prepost: false,
};

export const CHART_VIEW_KEYS = Object.keys(DEFAULT_CHART_VIEW) as (keyof ChartViewData)[];

/** The view fields of `s` (a copy for a new chart). */
export const pickChartView = (s: ChartViewData): ChartViewData => ({
  symbol: s.symbol,
  interval: s.interval,
  chartType: s.chartType,
  chartStyle: s.chartStyle,
  showPrevClose: s.showPrevClose,
  timezone: s.timezone,
  prepost: s.prepost,
});

export function createChartViewStore(initial?: Partial<ChartViewData>): StoreApi<ChartViewState> {
  return createStore<ChartViewState>()((set) => ({
    ...DEFAULT_CHART_VIEW,
    ...initial,
    // Upper-cased like the engine (Chart.setSymbol), so drawing bucket keys
    // match the symbol the engine filters by.
    setSymbol: (raw) => {
      const symbol = normalizeSymbol(raw);
      set({ symbol });
      useAppStore.setState((s) => ({
        recentSymbols: [symbol, ...s.recentSymbols.filter((x) => x !== symbol)].slice(0, 12),
      }));
    },
    setInterval: (interval) => set({ interval }),
    set: (patch) => set(patch),
  }));
}

/** The active chart's symbol, interval and chart settings. */
export const useChartView = createActiveFacade((s) => s.view, createChartViewStore);
