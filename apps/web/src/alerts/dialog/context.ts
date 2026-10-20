/** `AlertContext` from the live stores and the chart (the dialog and the commands read it on open). */
import { useChartView } from '../../store/chartView';
import { getChart } from '../../store/chart';
import { currentDrawings } from '../../drawings/actions';
import { useIndicatorRuntime, useIndicatorStore } from '../../indicators/store';
import { useQuoteStore } from '../../quotes/store';
import type { AlertContext, LastBar } from './sources';

export function currentAlertContext(): AlertContext {
  const app = useChartView.getState();
  const chart = getChart();
  const store = chart?.store;
  const last = store && store.length > 0 ? store.length - 1 : -1;
  const lastBar: LastBar | null =
    store && last >= 0
      ? {
          time: store.time[last]!,
          open: store.open[last]!,
          high: store.high[last]!,
          low: store.low[last]!,
          close: store.close[last]!,
          volume: store.volume[last]!,
        }
      : null;
  const hint = chart?.symbolInfo?.priceHint;
  const panes = useIndicatorRuntime.getState().panes;
  return {
    symbol: app.symbol,
    interval: app.interval,
    prepost: app.prepost,
    chartType: app.chartType,
    decimals: typeof hint === 'number' && Number.isInteger(hint) && hint >= 0 ? hint : 2,
    indicators: useIndicatorStore.getState().instances,
    paneOf: (id) => panes[id],
    indicatorValue: (instanceId, outputId) => {
      if (!chart || last < 0) return undefined;
      const v = chart.getStudyValues(instanceId, last).find((x) => x.outputId === outputId)?.value;
      return v !== undefined && Number.isFinite(v) ? v : undefined;
    },
    drawings: currentDrawings().map((d) => ({
      id: d.id,
      type: d.type,
      paneId: d.paneId,
      pointCount: d.points.length,
      scope: d.scope,
      symbol: d.symbol,
    })),
    scaleOf: (paneId) =>
      chart?.getState().panes.find((p) => p.id === paneId)?.priceScale.mode === 'log'
        ? 'log'
        : 'linear',
    lastPrice: (symbol) => {
      if (symbol === app.symbol && lastBar) return lastBar.close;
      return useQuoteStore.getState().quotes[symbol]?.last ?? undefined;
    },
    lastBar,
  };
}
