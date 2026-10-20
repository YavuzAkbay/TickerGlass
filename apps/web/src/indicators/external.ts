// External symbols of one chart's indicators (Correlation, `sym:` sources):
// fetches each required symbol through the chart's DataFeed, aligns it to the
// displayed bars with Compare's rules (../compare/aligned.ts) and keeps it live,
// posting the aligned bars to the indicator worker.
import {
  BRICK_TYPES,
  intervalSeconds,
  parseInterval,
  type Bar,
  type BarColumns,
  type ChartType,
  type DataFeed,
  type Interval,
  type SymbolInfo,
  type Unsubscribe,
} from '@investopen/engine';
import { AlignedSeries, buildGrid, pushGridKey, type AlignGrid } from '../compare/aligned';
import type { ToWorker } from './protocol';

/** The displayed bars the series are aligned to (the controller's chart). */
export interface ExternalChart {
  readonly store: { readonly length: number; readonly time: Float64Array };
  readonly symbolInfo: SymbolInfo | null;
  getInterval(): string;
}

export interface ExternalOptions {
  chart: ExternalChart;
  feed: DataFeed;
  post: (msg: ToWorker, transfer: Transferable[]) => void;
  /** Coalesces live bars (requestAnimationFrame in the app). */
  schedule: (fn: () => void) => void;
  chartType: () => ChartType;
  prepost: () => boolean;
  /** Bumps whenever fetched data must be refetched (replay start/seek/stop). Default: constant. */
  dataEpoch?: () => number;
  /** A symbol could not be loaded (message) or loads again (null). */
  onProblem: (symbol: string, message: string | null) => void;
}

interface Entry {
  symbol: string;
  series: AlignedSeries;
  loaded: boolean;
  hasMore: boolean;
  busy: boolean;
  /** History pages fetched since the displayed series last reset. */
  pages: number;
  unsub: Unsubscribe | null;
  dead: boolean;
}

const MAX_BARS = 20_000;
const MIN_PAGE = 300;
const MAX_PAGES = 10;
export const BRICK_MESSAGE = 'External symbols are not available on this chart type';

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const buffers = (c: BarColumns): Transferable[] => [
  c.time.buffer,
  c.open.buffer,
  c.high.buffer,
  c.low.buffer,
  c.close.buffer,
  c.volume.buffer,
];

export class ExternalSymbols {
  private readonly entries = new Map<string, Entry>();
  private required: string[] = [];
  private grid: AlignGrid | null = null;
  private interval: Interval | null = null;
  private intervalText = '';
  private prepost = false;
  private epoch = 0;
  private revision = -1;
  /** Why symbols cannot be aligned to the current displayed series, or null. */
  private unavailable: string | null = null;
  private destroyed = false;
  private pendingFrom = new Map<string, number>();
  private flushQueued = false;

  constructor(private readonly opts: ExternalOptions) {}

  /** Why external symbols cannot be shown right now, or null. */
  get unavailableReason(): string | null {
    return this.unavailable;
  }

  destroy(): void {
    this.destroyed = true;
    for (const e of this.entries.values()) this.drop(e);
    this.entries.clear();
  }

  /** The symbols the worker needs (its `symbols` message). */
  setRequired(symbols: string[]): void {
    if (this.destroyed) return;
    this.required = symbols;
    this.ensure();
  }

  /** The displayed series was replaced (reset, prepend, interval change): realign everything. */
  reset(revision: number): void {
    if (this.destroyed) return;
    this.revision = revision;
    this.pendingFrom.clear();
    const { chart } = this.opts;
    this.unavailable = null;
    let interval: Interval | null = null;
    if (BRICK_TYPES.has(this.opts.chartType())) this.unavailable = BRICK_MESSAGE;
    else {
      try {
        interval = parseInterval(chart.getInterval());
      } catch {
        this.unavailable = 'External symbols are not available for this interval';
      }
    }
    const prepost = this.opts.prepost();
    const text = chart.getInterval();
    const epoch = this.opts.dataEpoch?.() ?? 0;
    if (text !== this.intervalText || prepost !== this.prepost || epoch !== this.epoch) {
      // Fetched bars belong to one interval/session setting and data epoch.
      for (const e of this.entries.values()) this.drop(e);
      this.entries.clear();
    }
    this.interval = interval;
    this.intervalText = text;
    this.prepost = prepost;
    this.epoch = epoch;
    const n = chart.store.length;
    this.grid =
      interval && !this.unavailable && n
        ? buildGrid(interval, chart.store.time, n, chart.symbolInfo?.timezone ?? null)
        : null;
    for (const e of this.entries.values()) e.pages = 0;
    this.ensure();
    for (const e of this.entries.values()) {
      if (e.loaded) this.sendFull(e);
      this.extend(e);
    }
  }

  /**
   * Displayed bars [from, length) changed live (update/append): send the
   * aligned rows to the worker now, before the bars themselves, so the worker
   * never sees a chart longer than the external series.
   */
  onBars(from: number): void {
    if (this.destroyed || !this.grid) return;
    const { chart } = this.opts;
    const n = chart.store.length;
    const grid = this.grid;
    if (n < grid.keys.length) return; // out of step: the next reset rebuilds
    for (let i = grid.keys.length; i < n; i++) pushGridKey(grid, chart.store.time[i]!);
    for (const e of this.entries.values()) if (e.loaded) this.sendRows(e, Math.min(from, n - 1));
  }

  // ------------------------------------------------------------------ fetch

  private ensure(): void {
    const want = new Set(this.required);
    if (this.interval && !this.unavailable && this.grid)
      for (const symbol of want) if (!this.entries.has(symbol)) this.load(symbol);
    for (const [symbol, e] of this.entries) {
      if (want.has(symbol)) continue;
      this.drop(e);
      this.entries.delete(symbol);
      this.opts.onProblem(symbol, null);
    }
  }

  private drop(e: Entry): void {
    e.dead = true;
    e.unsub?.();
    e.unsub = null;
  }

  private load(symbol: string): void {
    const { chart, feed } = this.opts;
    const interval = this.interval!;
    const prepost = this.prepost;
    const store = chart.store;
    const n = store.length;
    const e: Entry = {
      symbol,
      series: new AlignedSeries(null),
      loaded: false,
      hasMore: false,
      busy: false,
      pages: 0,
      unsub: null,
      dead: false,
    };
    this.entries.set(symbol, e);
    const stale = this.grid!.stale;
    const first = store.time[0]! - stale;
    const end = Math.max(store.time[n - 1]!, Date.now() / 1000);
    const limit = Math.min(
      MAX_BARS,
      Math.max(n, Math.ceil((end - first) / intervalSeconds(interval)) + 2),
    );
    const run = async () => {
      const info = await feed.resolveSymbol(symbol);
      if (e.dead) return;
      e.series = new AlignedSeries(info.timezone ?? null);
      const res = await feed.getBars({ symbol, interval, limit, prepost });
      if (e.dead) return;
      const len = res.bars.time.length;
      e.series.set(res.bars, len);
      e.hasMore = res.hasMore && len > 0;
      e.loaded = true;
      if (this.grid) e.series.rekey(this.grid);
      const last: Bar | null = len
        ? {
            time: res.bars.time[len - 1]!,
            open: res.bars.open[len - 1]!,
            high: res.bars.high[len - 1]!,
            low: res.bars.low[len - 1]!,
            close: res.bars.close[len - 1]!,
            volume: res.bars.volume[len - 1]!,
          }
        : null;
      e.unsub = feed.subscribe(
        { symbol, interval, prepost, timezone: info.timezone, session: info.session },
        last,
        (bar) => this.onLiveBar(e, bar),
      );
      this.opts.onProblem(symbol, null);
      this.sendFull(e);
      this.extend(e);
    };
    run().catch((err: unknown) => {
      if (e.dead || this.destroyed) return;
      // Stays cached (no refetch loop) until the interval changes or the symbol is removed.
      this.opts.onProblem(symbol, errText(err));
    });
  }

  /** Fetch older history while the series starts after the displayed bars (minus staleness). */
  private extend(e: Entry): void {
    const grid = this.grid;
    if (this.destroyed || e.dead || e.busy || !e.loaded || !e.hasMore || !grid) return;
    if (e.pages >= MAX_PAGES || !grid.keys.length || !e.series.length) return;
    if (e.series.keys[0]! <= grid.keys[0]! - grid.stale) return;
    e.busy = true;
    e.pages++;
    const to = e.series.time[0]!;
    const interval = this.interval!;
    const first = this.opts.chart.store.time[0]! - grid.stale;
    const limit = Math.min(
      MAX_BARS,
      Math.max(MIN_PAGE, Math.ceil((to - first) / intervalSeconds(interval)) + 2),
    );
    this.opts.feed
      .getBars({ symbol: e.symbol, interval, to, limit, prepost: this.prepost })
      .then((res) => {
        e.busy = false;
        if (e.dead || this.destroyed) return;
        let len = res.bars.time.length;
        while (len > 0 && res.bars.time[len - 1]! >= to) len--;
        e.hasMore = res.hasMore && len > 0;
        if (!len) return;
        e.series.prepend(res.bars, len);
        if (this.grid) e.series.rekey(this.grid);
        this.sendFull(e);
        this.extend(e);
      })
      .catch((err: unknown) => {
        e.busy = false;
        if (e.dead || this.destroyed) return;
        // Keep what is loaded; older history is retried after the next reset.
        e.pages = MAX_PAGES;
        this.opts.onProblem(e.symbol, errText(err));
      });
  }

  // ------------------------------------------------------------------ post

  private sendFull(e: Entry): void {
    const grid = this.grid;
    if (!grid || this.revision < 0) return;
    const n = this.opts.chart.store.length;
    if (grid.keys.length !== n) return;
    const bars = e.series.columns(grid, this.opts.chart.store.time, 0);
    this.opts.post(
      { type: 'extBars', revision: this.revision, symbol: e.symbol, bars },
      buffers(bars),
    );
  }

  private sendRows(e: Entry, from: number): void {
    const grid = this.grid;
    if (!grid || this.revision < 0 || from >= grid.keys.length) return;
    const bars = e.series.columns(grid, this.opts.chart.store.time, from);
    this.opts.post(
      { type: 'extUpdate', revision: this.revision, symbol: e.symbol, from, bars },
      buffers(bars),
    );
  }

  private onLiveBar(e: Entry, bar: Bar): void {
    if (e.dead || this.destroyed || !e.loaded || !this.grid) return;
    const from = e.series.upsert(bar, this.grid);
    if (from < 0 || from >= this.grid.keys.length) return;
    this.pendingFrom.set(e.symbol, Math.min(this.pendingFrom.get(e.symbol) ?? Infinity, from));
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.opts.schedule(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    const pending = this.pendingFrom;
    this.pendingFrom = new Map();
    if (this.destroyed) return;
    for (const [symbol, from] of pending) {
      const e = this.entries.get(symbol);
      if (e?.loaded) this.sendRows(e, from);
    }
  }
}
