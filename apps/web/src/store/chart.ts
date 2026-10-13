import { create } from 'zustand';
import type { Chart, CrosshairInfo, SymbolInfo } from '@investopen/engine';

interface ChartStore {
  /** The active chart (multi-chart layouts in Phase 14 switch this). */
  chart: Chart | null;
  symbolInfo: SymbolInfo | null;
  crosshair: CrosshairInfo | null;
  loading: boolean;
  setChart: (chart: Chart | null) => void;
}

export const useChartStore = create<ChartStore>()((set) => ({
  chart: null,
  symbolInfo: null,
  crosshair: null,
  loading: false,
  setChart: (chart) => set({ chart }),
}));

/** Imperative access for commands. */
export const getChart = (): Chart | null => useChartStore.getState().chart;
