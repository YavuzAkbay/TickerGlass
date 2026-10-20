/**
 * Sync bus: mirrors one chart's symbol, interval, crosshair, pan position and
 * date range onto the other charts of the layout, as far as the layout's sync
 * flags allow. The bus only reacts to entry points (commands, chart events from
 * user gestures); what it writes into other charts is applied with causes the
 * bus ignores (`setSyncedCrosshair` emits no event, `setRightEdgeTime` is
 * cause 'api'), so there are no echo loops.
 */
import type { Chart, CrosshairInfo } from '@investopen/engine';
import type { ChartSession } from '../chart/session';
import { getActiveSession, useChartStore } from '../store/chart';
import type { SyncFlags } from './grid';
import { useLayoutGrid } from './store';

/** What the bus needs of a chart session. */
export type SyncSession = Pick<ChartSession, 'id' | 'view' | 'info'> & {
  chart: Pick<
    Chart,
    | 'setSyncedCrosshair'
    | 'setRightEdgeTime'
    | 'setVisibleTimeRange'
    | 'showAllHistory'
    | 'scrollToTime'
  >;
};

export interface SyncState {
  sessions: SyncSession[];
  flags: SyncFlags;
}

export interface SyncBusOptions {
  /** Frame scheduler (default: requestAnimationFrame, or a 16 ms timer without a window). */
  raf?: (cb: () => void) => unknown;
}

const defaultRaf = (cb: () => void): unknown =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => cb())
    : setTimeout(cb, 16);

export class SyncBus {
  private readonly raf: (cb: () => void) => unknown;
  private scheduled = false;
  private pendingCrosshair: { from: string; c: CrosshairInfo | null } | null = null;
  private pendingView: { from: string; rightEdge: number } | null = null;

  constructor(
    private readonly get: () => SyncState,
    opts: SyncBusOptions = {},
  ) {
    this.raf = opts.raf ?? defaultRaf;
  }

  setSymbol(from: string, symbol: string): void {
    const { sessions, flags } = this.get();
    for (const s of sessions)
      if (flags.symbol || s.id === from) s.view.getState().setSymbol(symbol);
  }

  setInterval(from: string, interval: string): void {
    const { sessions, flags } = this.get();
    for (const s of sessions)
      if (flags.interval || s.id === from) s.view.getState().setInterval(interval);
  }

  /** The crosshair of chart `from` moved (null: it left the chart). At most one broadcast per frame. */
  crosshair(from: string, c: CrosshairInfo | null): void {
    if (!this.get().flags.crosshair) return;
    this.pendingCrosshair = { from, c };
    this.schedule();
  }

  /** The user moved chart `from`; `rightEdge` is the time at its right edge. At most one broadcast per frame. */
  view(from: string, rightEdge: number): void {
    if (!this.get().flags.time) return;
    this.pendingView = { from, rightEdge };
    this.schedule();
  }

  /** Show a time range (or all history) on chart `from`, and on every chart with date-range sync. */
  async range(from: string, r: { from: number; to: number } | 'all'): Promise<void> {
    const { sessions, flags } = this.get();
    await Promise.all(
      sessions
        .filter((s) => flags.dateRange || s.id === from)
        .map((s) =>
          r === 'all' ? s.chart.showAllHistory() : s.chart.setVisibleTimeRange(r.from, r.to),
        ),
    );
  }

  /** Scroll chart `from`, and with date-range sync every chart, to `time`. */
  async goTo(from: string, time: number): Promise<void> {
    const { sessions, flags } = this.get();
    await Promise.all(
      sessions
        .filter((s) => flags.dateRange || s.id === from)
        .map((s) => s.chart.scrollToTime(time)),
    );
  }

  /** Remove the mirrored crosshair from every chart (sync turned off, a chart left). */
  clearCrosshairs(): void {
    this.pendingCrosshair = null;
    for (const s of this.get().sessions) s.chart.setSyncedCrosshair(null);
  }

  /** Chart `id` is going away: stop broadcasting for it. */
  drop(id: string): void {
    if (this.pendingView?.from === id) this.pendingView = null;
    if (this.pendingCrosshair?.from === id) this.pendingCrosshair = null;
    this.get().sessions.forEach((s) => {
      if (s.id !== id) s.chart.setSyncedCrosshair(null);
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.raf(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const ch = this.pendingCrosshair;
    const vw = this.pendingView;
    this.pendingCrosshair = null;
    this.pendingView = null;
    const { sessions, flags } = this.get();
    if (ch && flags.crosshair) this.flushCrosshair(sessions, ch.from, ch.c);
    if (vw && flags.time) {
      for (const s of sessions)
        if (s.id !== vw.from)
          void s.chart.setRightEdgeTime(vw.rightEdge).catch((e) => console.error(e));
    }
  }

  private flushCrosshair(sessions: SyncSession[], from: string, c: CrosshairInfo | null): void {
    const src = sessions.find((s) => s.id === from);
    const others = sessions.filter((s) => s.id !== from);
    if (!src || c === null || c.time === null) {
      for (const s of others) s.chart.setSyncedCrosshair(null);
      return;
    }
    // Whatever the other charts showed here is stale now that this chart has its own crosshair.
    src.chart.setSyncedCrosshair(null);
    const { symbol, interval } = src.view.getState();
    const timezone = src.info.getState().symbolInfo?.timezone ?? null;
    for (const s of others) {
      // A price only means something on the same symbol.
      const price = s.view.getState().symbol === symbol ? c.price : null;
      try {
        s.chart.setSyncedCrosshair({ time: c.time, interval, timezone, price });
      } catch (e) {
        console.error(e); // an interval the engine cannot parse
      }
    }
  }
}

const bus = new SyncBus(() => ({
  sessions: [...useChartStore.getState().sessions.values()],
  flags: useLayoutGrid.getState().sync,
}));
export const syncBus = bus;

/** The chart commands act on (the focused one, or the session a callback runs in). */
export const activeChartId = (): string | null => getActiveSession()?.id ?? null;

/**
 * Wire chart events of `session` to the bus (call when the chart mounts;
 * the returned function detaches). Only user gestures are broadcast.
 */
export function attachSync(session: Pick<ChartSession, 'id'> & { chart: Chart }): () => void {
  const { id, chart } = session;
  const offs = [
    chart.on('crosshairMove', (c) => bus.crosshair(id, c)),
    chart.on('viewChange', ({ cause }) => {
      if (cause !== 'user') return;
      const r = chart.getVisibleTimeRange();
      if (r) bus.view(id, r.to);
    }),
  ];
  return () => {
    offs.forEach((off) => off());
    bus.drop(id);
  };
}

// Turning crosshair sync off removes the mirrored crosshairs.
useLayoutGrid.subscribe((s, prev) => {
  if (prev.sync.crosshair && !s.sync.crosshair) bus.clearCrosshairs();
});
