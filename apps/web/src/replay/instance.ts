import type { ChartMarker, ChartPriceLine } from '@investopen/engine';
import { useAlerts } from '../alerts/store';
import { getChart } from '../store/chart';
import { useChartView } from '../store/chartView';
import { replayFeed } from '../chart/feed';
import { toast } from '../ui/Toast';
import { ReplayAlerts } from './alerts';
import { ReplayController } from './controller';
import { useReplayStore } from './store';
import { ReplayTrading, useTrading } from './trading';

/** Raw (untransformed) last revealed bar of the chart symbol, or null. */
const lastBar = () => replayFeed.revealedBar(useChartView.getState().symbol);

const alerts = new ReplayAlerts({
  alerts: () => useAlerts.getState().alerts,
  symbol: () => useChartView.getState().symbol,
  lastBar,
  setMarkers: (group: string, markers: readonly ChartMarker[]) =>
    getChart()?.setMarkers(group, markers),
  notify: (message) => toast(message, 'info'),
});

export const trading = new ReplayTrading({
  symbol: () => useChartView.getState().symbol,
  lastBar,
  clock: () => useReplayStore.getState().last,
  ready: () => ['paused', 'playing', 'ended'].includes(useReplayStore.getState().status),
  setMarkers: (group: string, markers: readonly ChartMarker[]) =>
    getChart()?.setMarkers(group, markers),
  setPriceLines: (group: string, lines: readonly ChartPriceLine[]) =>
    getChart()?.setPriceLines(group, lines),
  notify: (message) => toast(message, 'info', 8000),
});

export const replay = new ReplayController({
  feed: replayFeed,
  getChart,
  prepost: () => useChartView.getState().prepost,
  onError: (message) => toast(message, 'error'),
  sessions: [alerts, trading],
});

// Expose for debugging and e2e tests.
if (typeof window !== 'undefined' && (import.meta.env.DEV || import.meta.env.VITE_E2E === '1')) {
  (window as unknown as { replay?: unknown }).replay = {
    controller: replay,
    store: useReplayStore,
    feed: replayFeed,
    trading,
    tradingStore: useTrading,
  };
}
