// Compare overlays of one chart: mirrors the overlay list into engine studies,
// fetches each overlay symbol (plain or expression), aligns it to the displayed
// bars (left as-of join on the main series) and keeps it live.
import {
  BRICK_TYPES,
  alignKeys,
  alignModeFor,
  asOfIndex,
  asOfIndexAt,
  calendarContext,
  createBucketContext,
  intervalSeconds,
  lowerBound,
  maxStaleSeconds,
  parseInterval,
  type AlignMode,
  type Bar,
  type BucketContext,
  type ChartEvents,
  type ChartState,
  type ChartType,
  type DataFeed,
  type Interval,
  type PriceScaleMode,
  type SeriesChange,
  type SeriesStore,
  type StudyApi,
  type StudyOutputMeta,
  type StudySpec,
  type StudyTarget,
  type SymbolInfo,
  type Unsubscribe,
} from '@investopen/engine';
import { comparePaneId, type ComparePlacement, type CompareState } from './model';
import type { StoreApi } from 'zustand/vanilla';
import type { CompareRuntimeState, CompareStatus } from './store';

/** What the controller needs from the engine chart (Chart implements it). */
export interface CompareHost extends StudyApi {
  readonly store: Pick<SeriesStore, 'length' | 'time' | 'close'>;
  readonly symbolInfo: SymbolInfo | null;
  getSymbol(): string;
  getInterval(): string;
  getState(): ChartState;
  setPriceScaleMode(paneId: string, mode: PriceScaleMode): void;
  on<K extends keyof ChartEvents>(event: K, fn: (p: ChartEvents[K]) => void): () => void;
}

export interface CompareControllerOptions {
  chart: CompareHost;
  feed: DataFeed;
  /** The chart's live per-overlay state (statuses, symbol info) the legends read. */
  runtime: StoreApi<CompareRuntimeState>;
  /** Coalesces live bars (requestAnimationFrame in the app). */
  schedule?: (fn: () => void) => void;
  /** User-facing errors (toasts in the app). */
  onError?: (message: string) => void;
  /** The engine dropped overlays (their pane was removed); the app removes them. */
  onLost?: (ids: string[]) => void;
  /** Extended hours for overlay requests. */
  prepost: () => boolean;
  /** Chart type the app shows (overlays are unavailable on brick types). */
  chartType: () => ChartType;
  /** Bumps whenever fetched data must be refetched (replay start/seek/stop). Default: constant. */
  dataEpoch?: () => number;
}

/** One fetched overlay series, shared by every overlay of that symbol. */
interface Overlay {
  /** symbol|interval|prepost */
  key: string;
  symbol: string;
  interval: Interval;
  prepost: boolean;
  state: 'loading' | 'ready' | 'error';
  message: string;
  info: SymbolInfo | null;
  time: number[];
  close: number[];
  /** Join keys of `time` (see align.ts). */
  keys: number[];
  /** Calendar key context (calendar mode only). */
  ctx: BucketContext | null;
  hasMore: boolean;
  /** A history page is in flight. */
  busy: boolean;
  /** History pages fetched since the main series last reset or prepended. */
  pages: number;
  unsub: Unsubscribe | null;
  /** Dropped from the cache: late results are ignored. */
  dead: boolean;
}

interface Applied {
  symbol: string;
  placement: ComparePlacement;
  visible: boolean;
  color: string;
  lineWidth: number;
  precision: number | null;
}

const MAX_BARS = 20_000;
/** Smallest history page requested when extending an overlay. */
const MIN_PAGE = 300;
/** History pages per extension run (each main reset/prepend starts one). */
const MAX_PAGES = 10;
const OUTPUT_ID = 'close';
const UTC_CTX = createBucketContext({ timezone: null, session: null });

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const overlayKey = (symbol: string, interval: string, prepost: boolean, epoch = 0) =>
  `${symbol}|${interval}|${prepost ? 1 : 0}${epoch ? `|e${epoch}` : ''}`;

function outputs(item: CompareState): StudyOutputMeta[] {
  return [
    {
      type: 'plot',
      id: OUTPUT_ID,
      title: item.symbol,
      visible: true,
      kind: 'line',
      colors: [item.color],
      lineWidth: item.lineWidth,
      lineStyle: 'solid',
      base: null,
      offset: 0,
      showLastValue: true,
    },
  ];
}

const target = (item: CompareState): StudyTarget =>
  item.placement === 'pane' ? { newPane: { id: comparePaneId(item.id) } } : { paneId: 'main' };

const scaleSpec = (p: ComparePlacement): Pick<StudySpec, 'priceScale' | 'compare'> => ({
  priceScale: p === 'own' ? 'own' : 'pane',
  compare: p === 'same',
});

export class CompareController {
  private readonly chart: CompareHost;
  private readonly feed: DataFeed;
  private readonly schedule: (fn: () => void) => void;
  private readonly onError: (message: string) => void;
  private list: readonly CompareState[] = [];
  private readonly applied = new Map<string, Applied>();
  /** Series revision each overlay's full data was last pushed at. */
  private readonly pushed = new Map<string, number>();
  private readonly overlays = new Map<string, Overlay>();
  private offs: (() => void)[] = [];
  private destroyed = false;

  // Main series (as of the last reset/prepend, extended by appends).
  private revision = -1;
  /** Why overlays cannot be shown on the current main series, or null. */
  private unavailable: string | null = null;
  private interval: Interval | null = null;
  private intervalText = '';
  private epoch = 0;
  private prepost = false;
  private mode: AlignMode = 'calendar';
  private stale = 0;
  private mainCtx: BucketContext = UTC_CTX;
  private mainKeys: number[] = [];

  // Live updates waiting for the next frame: first changed main row, per overlay key.
  private pendingMain = Infinity;
  private pendingOverlay = new Map<string, number>();
  private flushQueued = false;

  constructor(private readonly opts: CompareControllerOptions) {
    this.chart = opts.chart;
    this.feed = opts.feed;
    this.schedule = opts.schedule ?? ((fn) => queueMicrotask(fn));
    this.onError = opts.onError ?? ((m) => console.error(m));
    this.offs.push(
      this.chart.on('seriesChange', (c) => this.onSeriesChange(c)),
      this.chart.on('paneRemoved', () => this.onPaneRemoved()),
      this.chart.on('studiesCleared', (e) => this.onStudiesCleared(e.ids)),
    );
    if (this.chart.store.length) this.onReset(this.chart.seriesRevision);
  }

  destroy(): void {
    this.destroyed = true;
    this.offs.forEach((off) => off());
    this.offs = [];
    for (const ov of this.overlays.values()) this.drop(ov);
    this.overlays.clear();
    this.opts.runtime.setState({ status: {}, info: {} });
  }

  /** Mirror the store's overlay list into the engine and fetch what it needs. */
  sync(list: readonly CompareState[]): void {
    if (this.destroyed) return;
    this.list = list;
    const ids = new Set(list.map((i) => i.id));
    for (const id of [...this.applied.keys()]) {
      if (ids.has(id)) continue;
      this.applied.delete(id);
      this.pushed.delete(id);
      this.engine(() => this.chart.removeStudy(id));
    }
    for (const item of list) {
      const prev = this.applied.get(item.id);
      if (prev && prev.symbol !== item.symbol) {
        this.applied.delete(item.id);
        this.pushed.delete(item.id);
        this.engine(() => this.chart.removeStudy(item.id));
      }
      if (!this.applied.has(item.id)) {
        // Re-added (or new) items retry a failed fetch.
        const failed = this.overlayOf(item);
        if (failed?.state === 'error') {
          this.drop(failed);
          this.overlays.delete(failed.key);
        }
        this.add(item);
        continue;
      }
      this.update(item, prev!);
    }
    this.ensureOverlays();
    for (const item of list) {
      const ov = this.overlayOf(item);
      if (ov?.state === 'ready' && this.pushed.get(item.id) !== this.revision)
        this.pushFull(item, ov);
    }
    this.publish();
  }

  // ------------------------------------------------------------- studies

  private add(item: CompareState): void {
    const precision = this.overlayOf(item)?.info?.priceHint ?? null;
    const spec: StudySpec = {
      id: item.id,
      title: item.symbol,
      target: target(item),
      outputs: outputs(item),
      format: 'price',
      precision,
      scaleRange: null,
      ...scaleSpec(item.placement),
      visible: item.visible,
    };
    if (!this.engine(() => this.chart.addStudy(spec))) return;
    this.applied.set(item.id, {
      symbol: item.symbol,
      placement: item.placement,
      visible: item.visible,
      color: item.color,
      lineWidth: item.lineWidth,
      precision,
    });
  }

  private update(item: CompareState, prev: Applied): void {
    const id = item.id;
    if (item.placement !== prev.placement) {
      // compare (same % scale) is only valid on the main pane: set it after
      // moving there, clear it before moving away.
      if (item.placement === 'pane') {
        this.engine(() => this.chart.updateStudySpec(id, scaleSpec(item.placement)));
        this.engine(() => this.chart.moveStudy(id, target(item)));
      } else {
        this.engine(() => this.chart.moveStudy(id, target(item)));
        this.engine(() => this.chart.updateStudySpec(id, scaleSpec(item.placement)));
      }
    }
    if (item.color !== prev.color || item.lineWidth !== prev.lineWidth)
      this.engine(() => this.chart.updateStudySpec(id, { outputs: outputs(item) }));
    if (item.visible !== prev.visible)
      this.engine(() => this.chart.setStudyVisible(id, item.visible));
    this.applied.set(id, { ...prev, ...item, precision: prev.precision });
  }

  /** Overlay precision once the symbol resolved. */
  private applyPrecision(item: CompareState, ov: Overlay): void {
    const a = this.applied.get(item.id);
    const precision = ov.info?.priceHint ?? null;
    if (!a || a.precision === precision) return;
    a.precision = precision;
    this.engine(() => this.chart.updateStudySpec(item.id, { precision }));
  }

  /** Run an engine call; report failures instead of breaking the sync loop. */
  private engine(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.onError(`Chart: ${errText(err)}`);
      return false;
    }
  }

  private onPaneRemoved(): void {
    if (this.destroyed) return;
    const present = new Set(this.chart.getStudies().map((s) => s.id));
    const lost = [...this.applied.keys()].filter((id) => !present.has(id));
    if (!lost.length) return;
    for (const id of lost) {
      this.applied.delete(id);
      this.pushed.delete(id);
    }
    // Synchronously, so the app folds the removal into the pane's undo step.
    this.opts.onLost?.(lost);
  }

  /** setState dropped the engine's studies: re-add them from the overlay list. */
  private onStudiesCleared(ids: string[]): void {
    if (this.destroyed) return;
    for (const id of ids) {
      this.applied.delete(id);
      this.pushed.delete(id);
    }
    this.sync(this.list);
  }

  // ------------------------------------------------------------ main bars

  private onSeriesChange(c: SeriesChange): void {
    if (this.destroyed) return;
    if (c.kind === 'reset' || c.kind === 'prepend') {
      this.onReset(c.revision);
      return;
    }
    if (c.revision !== this.revision || this.unavailable) return;
    const store = this.chart.store;
    const n = store.length;
    if (c.index === this.mainKeys.length && n === c.index + 1) {
      this.mainKeys.push(this.keyOf(store.time[c.index]!, this.mainCtx));
    } else if (c.index >= this.mainKeys.length || n !== this.mainKeys.length) {
      // Out of step with the store: rebuild from scratch.
      this.onReset(c.revision);
      return;
    }
    this.pendingMain = Math.min(this.pendingMain, c.index);
    this.queueFlush();
  }

  private onReset(revision: number): void {
    this.revision = revision;
    this.pendingMain = Infinity;
    this.pendingOverlay.clear();
    this.unavailable = null;
    const chartType = this.opts.chartType();
    if (BRICK_TYPES.has(chartType))
      this.unavailable = 'Compare is not available on this chart type';
    else {
      const text = this.chart.getInterval();
      if (text !== this.intervalText || !this.interval) {
        try {
          this.interval = parseInterval(text);
          this.intervalText = text;
        } catch {
          this.interval = null;
          this.intervalText = '';
        }
      }
      if (!this.interval) this.unavailable = 'Compare is not available for this interval';
    }
    this.prepost = this.opts.prepost();
    this.epoch = this.opts.dataEpoch?.() ?? 0;
    const store = this.chart.store;
    const n = this.unavailable ? 0 : store.length;
    if (this.interval) {
      this.mode = alignModeFor(this.interval);
      this.stale = maxStaleSeconds(this.interval);
    }
    this.mainCtx =
      this.mode === 'calendar' && n
        ? calendarContext(this.chart.symbolInfo?.timezone ?? null, store.time, n)
        : UTC_CTX;
    this.mainKeys = n ? Array.from(alignKeys(store.time, n, this.mode, this.mainCtx)) : [];
    for (const ov of this.overlays.values()) {
      ov.pages = 0;
      // Failed overlays stay cached (no refetch, no repeated toast) until their
      // key changes or the item is re-synced as new (see sync).
    }
    this.ensureOverlays();
    for (const item of this.list) {
      const ov = this.overlayOf(item);
      if (ov?.state === 'ready') this.pushFull(item, ov);
    }
    for (const ov of this.overlays.values()) this.extend(ov);
    this.publish();
  }

  /** Join key of one time (main or overlay). */
  private keyOf(t: number, ctx: BucketContext): number {
    return alignKeys([t], 1, this.mode, ctx)[0]!;
  }

  // ------------------------------------------------------------- overlays

  private overlayOf(item: CompareState): Overlay | undefined {
    if (!this.interval) return undefined;
    return this.overlays.get(overlayKey(item.symbol, this.intervalText, this.prepost, this.epoch));
  }

  /** Fetch overlays the list needs on this interval; drop the ones nothing uses. */
  private ensureOverlays(): void {
    const want = new Set<string>();
    if (this.interval && !this.unavailable && this.mainKeys.length) {
      for (const item of this.list) {
        const key = overlayKey(item.symbol, this.intervalText, this.prepost, this.epoch);
        want.add(key);
        if (!this.overlays.has(key)) this.load(item.symbol, key);
      }
    } else {
      // Keep what is cached until the chart can show overlays again.
      for (const item of this.list) {
        const ov = this.overlayOf(item);
        if (ov) want.add(ov.key);
      }
    }
    for (const [key, ov] of this.overlays) {
      if (want.has(key)) continue;
      this.drop(ov);
      this.overlays.delete(key);
    }
  }

  private drop(ov: Overlay): void {
    ov.dead = true;
    ov.unsub?.();
    ov.unsub = null;
  }

  private load(symbol: string, key: string): void {
    const interval = this.interval!;
    const prepost = this.prepost;
    const ov: Overlay = {
      key,
      symbol,
      interval,
      prepost,
      state: 'loading',
      message: '',
      info: null,
      time: [],
      close: [],
      keys: [],
      ctx: null,
      hasMore: false,
      busy: false,
      pages: 0,
      unsub: null,
      dead: false,
    };
    this.overlays.set(key, ov);
    const store = this.chart.store;
    const n = store.length;
    const first = store.time[0]! - this.stale;
    const end = Math.max(store.time[n - 1]!, Date.now() / 1000);
    const limit = Math.min(
      MAX_BARS,
      Math.max(n, Math.ceil((end - first) / intervalSeconds(interval)) + 2),
    );
    const run = async () => {
      const info = await this.feed.resolveSymbol(symbol);
      if (ov.dead) return;
      ov.info = info;
      const res = await this.feed.getBars({ symbol, interval, limit, prepost });
      if (ov.dead) return;
      const len = res.bars.time.length;
      ov.time = Array.from(res.bars.time.subarray(0, len));
      ov.close = Array.from(res.bars.close.subarray(0, len));
      ov.hasMore = res.hasMore && len > 0;
      ov.state = 'ready';
      this.rekey(ov);
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
      ov.unsub = this.feed.subscribe(
        { symbol, interval, prepost, timezone: info.timezone, session: info.session },
        last,
        (bar) => this.onOverlayBar(ov, bar),
      );
      this.onOverlayData(ov);
    };
    run().catch((err: unknown) => {
      if (ov.dead || this.destroyed) return;
      ov.state = 'error';
      ov.message = errText(err);
      this.onError(`Compare ${symbol}: ${ov.message}`);
      this.publish();
    });
  }

  /** Recompute the overlay's key context and join keys (after load or prepend). */
  private rekey(ov: Overlay): void {
    const n = ov.time.length;
    ov.ctx =
      this.mode === 'calendar' ? calendarContext(ov.info?.timezone ?? null, ov.time, n) : UTC_CTX;
    ov.keys = Array.from(alignKeys(ov.time, n, this.mode, ov.ctx));
  }

  /** New or prepended overlay data: push it to every overlay of that series. */
  private onOverlayData(ov: Overlay): void {
    if (this.destroyed || ov.dead) return;
    for (const item of this.list) {
      if (this.overlayOf(item) !== ov) continue;
      this.applyPrecision(item, ov);
      this.pushFull(item, ov);
    }
    this.publish();
    this.extend(ov);
  }

  /** Fetch older overlay history while it starts after the main series (minus staleness). */
  private extend(ov: Overlay): void {
    if (this.destroyed || ov.dead || ov.busy || ov.state !== 'ready' || !ov.hasMore) return;
    if (ov.pages >= MAX_PAGES || this.unavailable || !this.mainKeys.length || !ov.time.length)
      return;
    if (ov.keys[0]! <= this.mainKeys[0]! - this.stale) return;
    ov.busy = true;
    ov.pages++;
    const to = ov.time[0]!;
    const first = this.chart.store.time[0]! - this.stale;
    const limit = Math.min(
      MAX_BARS,
      Math.max(MIN_PAGE, Math.ceil((to - first) / intervalSeconds(ov.interval)) + 2),
    );
    this.feed
      .getBars({ symbol: ov.symbol, interval: ov.interval, to, limit, prepost: ov.prepost })
      .then((res) => {
        ov.busy = false;
        if (ov.dead || this.destroyed) return;
        const bars = res.bars;
        let len = bars.time.length;
        while (len > 0 && bars.time[len - 1]! >= to) len--;
        ov.hasMore = res.hasMore && len > 0;
        if (!len) return;
        ov.time = [...Array.from(bars.time.subarray(0, len)), ...ov.time];
        ov.close = [...Array.from(bars.close.subarray(0, len)), ...ov.close];
        this.rekey(ov);
        this.onOverlayData(ov);
      })
      .catch((err: unknown) => {
        ov.busy = false;
        if (ov.dead || this.destroyed) return;
        // Keep what is loaded; older history is retried after the next reset.
        ov.pages = MAX_PAGES;
        this.onError(`Compare ${ov.symbol}: ${errText(err)}`);
      });
  }

  private onOverlayBar(ov: Overlay, bar: Bar): void {
    if (ov.dead || this.destroyed || ov.state !== 'ready') return;
    const n = ov.time.length;
    const last = n ? ov.time[n - 1]! : -Infinity;
    if (bar.time < last) return;
    if (bar.time === last) ov.close[n - 1] = bar.close;
    else {
      ov.time.push(bar.time);
      ov.close.push(bar.close);
      ov.keys.push(this.keyOf(bar.time, ov.ctx ?? UTC_CTX));
    }
    const key = ov.keys[ov.keys.length - 1]!;
    const from = lowerBound(this.mainKeys, this.mainKeys.length, key);
    if (from >= this.mainKeys.length) return;
    this.pendingOverlay.set(ov.key, Math.min(this.pendingOverlay.get(ov.key) ?? Infinity, from));
    this.queueFlush();
  }

  // ------------------------------------------------------------- pushing

  /** Aligned overlay closes for main rows [from, n). */
  private values(ov: Overlay, from: number): Float64Array {
    const n = this.mainKeys.length;
    const out = new Float64Array(n - from);
    if (from === 0) {
      const idx = asOfIndex(this.mainKeys, n, ov.keys, ov.keys.length, this.stale);
      for (let i = 0; i < n; i++) out[i] = idx[i]! >= 0 ? ov.close[idx[i]!]! : NaN;
      return out;
    }
    for (let i = from; i < n; i++) {
      const j = asOfIndexAt(this.mainKeys[i]!, ov.keys, ov.keys.length, this.stale);
      out[i - from] = j >= 0 ? ov.close[j]! : NaN;
    }
    return out;
  }

  private pushFull(item: CompareState, ov: Overlay): void {
    if (!this.applied.has(item.id) || this.unavailable) return;
    const n = this.mainKeys.length;
    if (!n || this.revision !== this.chart.seriesRevision) return;
    const revision = this.revision;
    const close = this.values(ov, 0);
    if (
      this.engine(() =>
        this.chart.setStudyData(item.id, { revision, length: n, values: { close }, colors: {} }),
      )
    )
      this.pushed.set(item.id, revision);
  }

  private queueFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.schedule(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    const mainFrom = this.pendingMain;
    const overlayFrom = this.pendingOverlay;
    this.pendingMain = Infinity;
    this.pendingOverlay = new Map();
    if (this.destroyed || this.unavailable) return;
    const revision = this.revision;
    if (revision !== this.chart.seriesRevision) return;
    const n = this.mainKeys.length;
    let changed = false;
    for (const item of this.list) {
      const ov = this.overlayOf(item);
      if (!ov || ov.state !== 'ready' || this.pushed.get(item.id) !== revision) continue;
      const from = Math.max(0, Math.min(mainFrom, overlayFrom.get(ov.key) ?? Infinity));
      if (from >= n) continue;
      const close = this.values(ov, from);
      changed =
        this.engine(() =>
          this.chart.updateStudyData(item.id, {
            revision,
            from,
            length: n,
            values: { close },
            colors: {},
          }),
        ) || changed;
    }
    if (changed) this.opts.runtime.setState((s) => ({ tick: s.tick + 1 }));
  }

  // ------------------------------------------------------------- runtime

  private statusOf(item: CompareState): CompareStatus {
    if (this.unavailable) return { state: 'unavailable', message: this.unavailable };
    const ov = this.overlayOf(item);
    if (!ov || ov.state === 'loading') return { state: 'loading' };
    if (ov.state === 'error') return { state: 'error', message: ov.message };
    return { state: 'ready' };
  }

  /** Report status and resolved symbol info of every overlay. */
  private publish(): void {
    if (this.destroyed) return;
    const status: Record<string, CompareStatus> = {};
    const info: Record<string, SymbolInfo> = {};
    for (const item of this.list) {
      status[item.id] = this.statusOf(item);
      const i = this.overlayOf(item)?.info;
      if (i) info[item.id] = i;
    }
    const cur = this.opts.runtime.getState();
    if (JSON.stringify(cur.status) === JSON.stringify(status) && sameInfo(cur.info, info)) {
      this.opts.runtime.setState((s) => ({ tick: s.tick + 1 }));
      return;
    }
    this.opts.runtime.setState((s) => ({ status, info, tick: s.tick + 1 }));
  }
}

function sameInfo(a: Record<string, SymbolInfo>, b: Record<string, SymbolInfo>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}
