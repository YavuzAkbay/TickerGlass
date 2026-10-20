/**
 * View values a chart starts with when its cell mounts: set by the code that
 * adds the chart (e.g. "open in new chart") or taken from the layout slot
 * being applied. Read once per mount; dropped right after (React may mount a
 * cell twice in a row in development).
 */
import type { ChartViewData } from '../store/chartView';
import { useLayoutGrid } from './store';

const seeds = new Map<string, Partial<ChartViewData>>();

export const setSeed = (chartId: string, seed: Partial<ChartViewData>): void => {
  seeds.set(chartId, seed);
};

export const dropSeed = (chartId: string): void => {
  seeds.delete(chartId);
};

/** The starting view values of chart `chartId`, if any are known. */
export function takeSeed(chartId: string): Partial<ChartViewData> | null {
  const explicit = seeds.get(chartId);
  if (explicit) setTimeout(() => seeds.delete(chartId), 0);
  const slot = useLayoutGrid.getState().slots[chartId];
  if (!explicit && !slot) return null;
  return {
    ...(slot ? slot.chartSettings : {}),
    ...(slot?.chart ? { symbol: slot.chart.symbol, interval: slot.chart.interval } : {}),
    ...explicit,
  };
}
