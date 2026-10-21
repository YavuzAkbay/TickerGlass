import { create } from 'zustand';
import type { Chart, CrosshairInfo, SymbolInfo } from '@tickerglass/engine';
import type { ChartSession } from '../chart/session';

interface ChartStore {
  /** One session per chart in the layout. */
  sessions: Map<string, ChartSession>;
  /** The chart the toolbar, commands and panels act on; null before the first chart. */
  activeId: string | null;
  /** The active chart (what getChart() returns). */
  chart: Chart | null;
  /** Mirrors of the active session's `info` store. */
  symbolInfo: SymbolInfo | null;
  crosshair: CrosshairInfo | null;
  loading: boolean;
}

export const useChartStore = create<ChartStore>()(() => ({
  sessions: new Map(),
  activeId: null,
  chart: null,
  symbolInfo: null,
  crosshair: null,
  loading: false,
}));

/** Per-session `info` subscriptions (mirroring into the store while active). */
const infoOffs = new Map<string, () => void>();

function mirror(session: ChartSession | undefined): Partial<ChartStore> {
  const info = session?.info.getState();
  return {
    chart: session?.chart ?? null,
    symbolInfo: info?.symbolInfo ?? null,
    crosshair: info?.crosshair ?? null,
    loading: info?.loading ?? false,
  };
}

/** Add a session; the first one becomes active. */
export function registerSession(session: ChartSession): void {
  infoOffs.get(session.id)?.();
  infoOffs.set(
    session.id,
    session.info.subscribe((info) => {
      if (useChartStore.getState().activeId !== session.id) return;
      useChartStore.setState({
        symbolInfo: info.symbolInfo,
        crosshair: info.crosshair,
        loading: info.loading,
      });
    }),
  );
  useChartStore.setState((s) => {
    const sessions = new Map(s.sessions).set(session.id, session);
    const activeId = s.activeId !== null && sessions.has(s.activeId) ? s.activeId : session.id;
    return { sessions, activeId, ...mirror(sessions.get(activeId)) };
  });
}

/** Remove a session; the first remaining one becomes active if it was. */
export function unregisterSession(id: string): void {
  infoOffs.get(id)?.();
  infoOffs.delete(id);
  useChartStore.setState((s) => {
    const sessions = new Map(s.sessions);
    sessions.delete(id);
    const activeId = s.activeId !== null && sessions.has(s.activeId) ? s.activeId : null;
    const next = activeId ?? sessions.keys().next().value ?? null;
    return { sessions, activeId: next, ...mirror(next === null ? undefined : sessions.get(next)) };
  });
}

/** Make `id` the chart the toolbar, commands and panels act on. */
export function setActiveChart(id: string): void {
  const s = useChartStore.getState();
  if (s.activeId === id || !s.sessions.has(id)) return;
  useChartStore.setState({ activeId: id, ...mirror(s.sessions.get(id)) });
}

/** Chart whose session the active-chart accessors resolve to inside runInSession(). */
let scopedId: string | null = null;

/**
 * Run `fn` (synchronously) with the active-chart facades and getChart()
 * resolving to chart `id` instead of the focused one. For callbacks that
 * originate from a chart that may not be focused (studies lost, drawing
 * gestures, pane removal): their undo steps and store writes belong to that
 * chart. Falls back to the active chart when `id` has no session.
 */
export function runInSession<T>(id: string, fn: () => T): T {
  const prev = scopedId;
  scopedId = id;
  try {
    return fn();
  } finally {
    scopedId = prev;
  }
}

/** The session the active-chart accessors act on (the focused chart, or the runInSession() one). */
export const getActiveSession = (): ChartSession | null => {
  const { sessions, activeId } = useChartStore.getState();
  const id = scopedId !== null && sessions.has(scopedId) ? scopedId : activeId;
  return id === null ? null : (sessions.get(id) ?? null);
};

/** Imperative access for commands. */
export const getChart = (): Chart | null =>
  scopedId === null ? useChartStore.getState().chart : (getActiveSession()?.chart ?? null);

/**
 * `session.chart.on` whose handlers run in runInSession(session.id): store
 * writes and undo steps the handler makes land on this chart even when
 * another one is focused.
 */
export function scopedOn(session: { id: string; chart: Chart }): Chart['on'] {
  return (event, fn) => session.chart.on(event, (p) => runInSession(session.id, () => fn(p)));
}

// Debug/e2e global: `window.chart` always follows the active chart.
if (typeof window !== 'undefined') {
  useChartStore.subscribe((s) => {
    (window as unknown as { chart?: unknown }).chart = s.chart ?? undefined;
  });
}
