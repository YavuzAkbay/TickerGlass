import type { ChartMarker, ChartPriceLine, SymbolInfo } from '@investopen/engine';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ChartInfoState, ChartSession } from '../chart/session';
import { useChartView, type ChartViewState } from '../store/chartView';
import { useAlerts } from '../alerts/store';
import { getActiveSession, useChartStore } from '../store/chart';
import { replayFeed } from '../chart/feed';
import { toast } from '../ui/Toast';
import { ReplayAlerts } from './alerts';
import { ReplayController } from './controller';
import { useReplayStore } from './store';
import { useTradingPrefs } from './prefs';
import { ReplayTrading, useTrading } from './trading';

/**
 * The replay chart: the active chart when replay began, pinned until it ends.
 * Moving focus to another chart retargets the toolbar, not the replay.
 */
export function getReplaySession(): ChartSession | null {
  const { sessions } = useChartStore.getState();
  const id = useReplayStore.getState().chartId;
  return id === null ? getActiveSession() : (sessions.get(id) ?? null);
}

/**
 * Pin the replay chart to `id` when none is pinned yet (starting replay).
 * Returns whether `id` is the replay chart, i.e. may start or move the replay.
 */
export function pinReplayChart(id: string): boolean {
  const pinned = useReplayStore.getState().chartId;
  if (pinned === null) useReplayStore.getState().set({ chartId: id });
  return (pinned ?? id) === id;
}

// Unpin when replay ends.
useReplayStore.subscribe((s, prev) => {
  if (s.status === 'off' && prev.status !== 'off' && s.chartId !== null)
    useReplayStore.setState({ chartId: null });
});

const replaySymbol = () => getReplaySession()?.view.getState().symbol ?? '';
const replayChart = () => getReplaySession()?.chart ?? null;

/** Raw (untransformed) last revealed bar of the replay chart's symbol, or null. */
const lastBar = () => replayFeed.revealedBar(replaySymbol());

const alerts = new ReplayAlerts({
  alerts: () => useAlerts.getState().alerts,
  symbol: replaySymbol,
  lastBar,
  setMarkers: (group: string, markers: readonly ChartMarker[]) =>
    replayChart()?.setMarkers(group, markers),
  notify: (message) => toast(message, 'info'),
});

export const trading = new ReplayTrading({
  symbol: replaySymbol,
  lastBar,
  clock: () => useReplayStore.getState().last,
  ready: () => ['paused', 'playing', 'ended'].includes(useReplayStore.getState().status),
  setMarkers: (group: string, markers: readonly ChartMarker[]) =>
    replayChart()?.setMarkers(group, markers),
  setPriceLines: (group: string, lines: readonly ChartPriceLine[]) =>
    replayChart()?.setPriceLines(group, lines),
  notify: (message) => toast(message, 'info', 8000),
});

// Display preferences (Settings -> Trading) apply to what is already drawn.
useTradingPrefs.subscribe(() => trading.redraw());

export const replay = new ReplayController({
  feed: replayFeed,
  getChart: replayChart,
  getOtherCharts: () => {
    const { sessions } = useChartStore.getState();
    const id = getReplaySession()?.id;
    return [...sessions.values()].filter((x) => x.id !== id).map((x) => x.chart);
  },
  prepost: () => getReplaySession()?.view.getState().prepost ?? false,
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

const NO_INFO = createStore<ChartInfoState>(() => ({
  symbolInfo: null,
  crosshair: null,
  loading: false,
  error: null,
}));

function useReplaySession(): ChartSession | undefined {
  const id = useReplayStore((s) => s.chartId);
  return useChartStore((s) => s.sessions.get(id ?? s.activeId ?? ''));
}

/** The replay chart's view (symbol, interval, timezone), not the focused chart's. */
export function useReplayView<T>(selector: (s: ChartViewState) => T): T {
  const session = useReplaySession();
  return useStore(session?.view ?? (useChartView as StoreApi<ChartViewState>), selector);
}

/** Symbol info of the replay chart. */
export function useReplaySymbolInfo(): SymbolInfo | null {
  const session = useReplaySession();
  return useStore(session?.info ?? NO_INFO, (s) => s.symbolInfo);
}
