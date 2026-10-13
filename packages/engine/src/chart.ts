import { Emitter } from './events';
import { formatInterval, intervalSeconds, isIntraday, parseInterval } from './feed/intervals';
import { SeriesStore } from './model/series-store';
import { DEFAULT_OPTIONS, type ChartOptions, type ChartTheme } from './options';
import { Pane, div, place } from './pane';
import { CanvasLayer } from './render/canvas';
import { dashedLine, font, hLine, labelBox, vLine } from './render/draw';
import { CandleSeries, type PaneSeries } from './render/series';
import type { PriceScaleMode } from './scale/price-scale';
import { decimalsForMinTick, formatPercent, formatPrice, formatVolume } from './scale/price-ticks';
import {
  computeTimeWeights,
  formatCrosshairTime,
  selectTimeMarks,
  type TimeMark,
} from './scale/time-marks';
import { DEFAULT_BAR_SPACING, TimeScale } from './scale/time-scale';
import { createTzConverter, type TzConverter } from './scale/timezone';
import { InteractionController } from './interaction/controller';
import { applyThemeVars, injectStyle } from './style';
import type { Bar, DataFeed, Interval, SymbolInfo, Unsubscribe } from './types';

const TIME_AXIS_HEIGHT = 28;
const MIN_AXIS_WIDTH = 56;
const COLLAPSED_PANE_HEIGHT = 24;
const MIN_PANE_HEIGHT = 30;
const LAZY_LOAD_THRESHOLD = 150;
const AXIS_LABEL_HEIGHT = 20;

const INVALIDATE_OVERLAY = 1;
const INVALIDATE_MAIN = 2;
const INVALIDATE_LAYOUT = 4;

export interface CrosshairInfo {
  paneId: string | null;
  index: number | null;
  time: number | null;
  price: number | null;
  bar: Bar | null;
}

/** A point on the chart in chart terms (for context menus, drawings, alerts). */
export interface ChartPoint {
  clientX: number;
  clientY: number;
  kind: HitTarget['kind'];
  paneId?: string;
  price?: number;
  index?: number;
  time?: number | null;
  seriesId?: string | null;
}

export interface ChartEvents {
  contextMenu: ChartPoint;
  /** Live update of the last bar (or a newly appended one). */
  barUpdate: Bar;
  crosshairMove: CrosshairInfo;
  visibleRangeChange: { from: number; to: number };
  symbolResolved: SymbolInfo;
  dataLoaded: { symbol: string; interval: string; bars: number };
  loading: boolean;
  error: { message: string };
  stateChange: ChartState;
}

export interface PaneState {
  id: string;
  ratio: number;
  collapsed: boolean;
  priceScale: {
    mode: PriceScaleMode;
    autoScale: boolean;
    invert: boolean;
    min?: number;
    max?: number;
  };
}

export interface ChartState {
  version: 1;
  symbol: string;
  interval: string;
  timeScale: { barSpacing: number; rightOffset: number };
  crosshair: { mode: ChartOptions['crosshair']; magnet: ChartOptions['magnet'] };
  timezone: ChartOptions['timezone'];
  panes: PaneState[];
  maximizedPane: string | null;
}

export type HitTarget =
  | { kind: 'pane'; pane: Pane; x: number; y: number; seriesId: string | null }
  | { kind: 'priceAxis'; pane: Pane; y: number }
  | { kind: 'timeAxis'; x: number }
  | { kind: 'separator'; index: number }
  | { kind: 'none' };

interface CrosshairPos {
  pane: Pane;
  x: number; // snapped to bar centre
  y: number; // snapped by magnet
  index: number;
  rawY: number;
}

export class Chart {
  readonly root: HTMLDivElement;
  readonly store = new SeriesStore();
  readonly timeScale = new TimeScale();
  readonly panes: Pane[] = [];
  readonly events = new Emitter<ChartEvents>();
  options: ChartOptions;
  symbolInfo: SymbolInfo | null = null;

  private feed: DataFeed;
  private symbol = '';
  private interval: Interval = { unit: 'day', count: 1 };
  private tz: TzConverter = createTzConverter('UTC');
  private weights = new Uint8Array(0);
  private decimals = 2;
  private hasMore = false;
  private loadingMore = false;
  private loadPromise: Promise<void> = Promise.resolve();
  private loadGen = 0;
  private unsubscribe: Unsubscribe | null = null;
  private crosshair: CrosshairPos | null = null;
  private maximized: Pane | null = null;
  private separators: HTMLDivElement[] = [];
  private timeAxisEl: HTMLDivElement;
  private timeAxisMain: CanvasLayer;
  private timeAxisOverlay: CanvasLayer;
  private statusEl: HTMLDivElement;
  private width = 0;
  private height = 0;
  private axisWidth = MIN_AXIS_WIDTH;
  private dpr = 1;
  private invalid = 0;
  private frame = 0;
  private marks: TimeMark[] = [];
  private resizeObserver: ResizeObserver;
  private countdownTimer: ReturnType<typeof setInterval>;
  private controller: InteractionController;
  private lastRange = { from: -1, to: -1 };
  private destroyed = false;

  constructor(container: HTMLElement, feed: DataFeed, options: Partial<ChartOptions> = {}) {
    injectStyle();
    this.feed = feed;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.root = div(container, 'io-chart');
    this.root.tabIndex = 0;
    Object.assign(this.root.style, { width: '100%', height: '100%' });
    applyThemeVars(this.root, this.options.theme);

    const main = new Pane(this.root, 3, 'main');
    main.series.push(new CandleSeries(this.store));
    this.panes.push(main);

    this.timeAxisEl = div(this.root, 'io-axis io-time-axis');
    this.timeAxisMain = new CanvasLayer(this.timeAxisEl, 1);
    this.timeAxisOverlay = new CanvasLayer(this.timeAxisEl, 2);
    this.statusEl = div(this.root, 'io-status');

    this.resizeObserver = new ResizeObserver(() => this.invalidate(INVALIDATE_LAYOUT));
    this.resizeObserver.observe(container);
    this.countdownTimer = setInterval(() => {
      if (isIntraday(this.interval) && this.store.length) this.invalidate(INVALIDATE_OVERLAY);
    }, 1000);
    this.controller = new InteractionController(this);
    this.invalidate(INVALIDATE_LAYOUT);
  }

  // ---------------------------------------------------------------- public API

  get theme(): ChartTheme {
    return this.options.theme;
  }

  getSymbol(): string {
    return this.symbol;
  }

  getInterval(): string {
    return formatInterval(this.interval);
  }

  setSymbol(symbol: string): Promise<void> {
    this.symbol = symbol.trim().toUpperCase();
    return this.load();
  }

  /** Resolves when the current symbol/interval load has finished. */
  whenLoaded(): Promise<void> {
    return this.loadPromise;
  }

  setInterval(interval: string): Promise<void> {
    this.interval = parseInterval(interval);
    return this.symbol ? this.load() : Promise.resolve();
  }

  /** Change symbol and interval with a single load. */
  setSymbolAndInterval(symbol: string, interval: string): Promise<void> {
    const sym = symbol.trim().toUpperCase();
    const iv = parseInterval(interval);
    // Idempotent: React effects may re-apply the same pair.
    if (
      this.loadGen > 0 &&
      sym === this.symbol &&
      formatInterval(iv) === formatInterval(this.interval)
    ) {
      return this.loadPromise;
    }
    this.symbol = sym;
    this.interval = iv;
    return this.load();
  }

  /** Force a reload of the current symbol/interval. */
  reload(): Promise<void> {
    return this.load();
  }

  setFeed(feed: DataFeed): Promise<void> {
    this.feed = feed;
    return this.symbol ? this.load() : Promise.resolve();
  }

  applyOptions(opts: Partial<ChartOptions>): void {
    const reload =
      (opts.prepost !== undefined && opts.prepost !== this.options.prepost) ||
      (opts.adjusted !== undefined && opts.adjusted !== this.options.adjusted);
    this.options = { ...this.options, ...opts };
    applyThemeVars(this.root, this.options.theme);
    if (opts.timezone !== undefined) this.updateTimezone();
    if (reload && this.symbol) void this.load();
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  addPane(ratio = 1, id?: string): Pane {
    const pane = new Pane(this.root, ratio, id);
    this.panes.push(pane);
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
    return pane;
  }

  removePane(id: string): void {
    const i = this.panes.findIndex((p) => p.id === id);
    if (i <= 0) return; // the main pane stays
    const [pane] = this.panes.splice(i, 1);
    pane?.destroy();
    if (this.maximized === pane) this.maximized = null;
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  /** Move a pane up (-1) or down (+1). */
  movePane(id: string, dir: -1 | 1): void {
    const i = this.panes.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.panes.length) return;
    [this.panes[i], this.panes[j]] = [this.panes[j]!, this.panes[i]!];
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  maximizePane(id: string | null): void {
    this.maximized = id ? (this.panes.find((p) => p.id === id) ?? null) : null;
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  collapsePane(id: string, collapsed: boolean): void {
    const pane = this.panes.find((p) => p.id === id);
    if (!pane) return;
    pane.collapsed = collapsed;
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  addSeries(paneId: string, series: PaneSeries): void {
    this.panes.find((p) => p.id === paneId)?.series.push(series);
    this.invalidate(INVALIDATE_MAIN);
  }

  setPriceScaleMode(paneId: string, mode: PriceScaleMode): void {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane) return;
    pane.priceScale.mode = mode;
    pane.priceScale.autoScale = true;
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  setAutoScale(paneId: string, on: boolean): void {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane) return;
    pane.priceScale.autoScale = on;
    this.invalidate(INVALIDATE_MAIN);
    this.emitState();
  }

  setInvertScale(paneId: string, invert: boolean): void {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane) return;
    pane.priceScale.invert = invert;
    this.invalidate(INVALIDATE_MAIN);
    this.emitState();
  }

  /** Back to the latest bar with default zoom and auto-scale. */
  resetView(): void {
    this.timeScale.barSpacing = DEFAULT_BAR_SPACING;
    this.timeScale.reset(this.store.length - 1);
    for (const p of this.panes) p.priceScale.autoScale = true;
    this.invalidate(INVALIDATE_MAIN);
    this.emitState();
  }

  /** Fit the bars between two times (unix s) to the width, loading history as needed. */
  async setVisibleTimeRange(from: number, to: number = Infinity): Promise<void> {
    await this.whenLoaded();
    await this.ensureHistory(from);
    const n = this.store.length;
    if (!n) return;
    const i0 = Math.max(0, this.store.indexAtOrBefore(from - 1) + 1);
    const i1 = to === Infinity ? n - 1 : Math.max(i0, this.store.indexAtOrBefore(to));
    this.timeScale.fitRange(i0, i1);
    for (const p of this.panes) p.priceScale.autoScale = true;
    this.viewChanged();
    this.emitState();
  }

  /** Load all available history and fit it to the width. */
  async showAllHistory(): Promise<void> {
    await this.whenLoaded();
    await this.ensureHistory(-Infinity);
    if (this.store.length) await this.setVisibleTimeRange(this.store.time[0]!);
  }

  /** Centre the bar at (or just before) `time`, loading history as needed. */
  async scrollToTime(time: number): Promise<void> {
    await this.whenLoaded();
    await this.ensureHistory(time);
    const i = Math.max(0, this.store.indexAtOrBefore(time));
    const ts = this.timeScale;
    ts.rightOffset = ts.width / ts.barSpacing / 2 - (ts.baseIndex - i);
    ts.clamp();
    this.viewChanged();
    this.emitState();
  }

  /** Composite all layers (panes, axes, legend text) into one canvas. */
  takeScreenshot(): HTMLCanvasElement {
    const dpr = this.dpr;
    const out = document.createElement('canvas');
    out.width = Math.round(this.width * dpr);
    out.height = Math.round(this.height * dpr);
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, out.width, out.height);
    const blit = (layer: CanvasLayer, x: number, y: number) => {
      if (layer.width && layer.height)
        ctx.drawImage(layer.canvas, Math.round(x * dpr), Math.round(y * dpr));
    };
    for (const pane of this.panes) {
      if (pane.height <= 0) continue;
      for (const l of [pane.bg, pane.main, pane.overlay]) blit(l, 0, pane.top);
      for (const l of [pane.axisMain, pane.axisOverlay]) blit(l, this.paneWidth, pane.top);
      // Legend is DOM: redraw its text.
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.font = font(this.theme, 13);
      ctx.fillStyle = this.theme.text;
      ctx.textBaseline = 'top';
      ctx.fillText(pane.legendEl.textContent ?? '', 8, pane.top + 8);
      ctx.restore();
    }
    blit(this.timeAxisMain, 0, this.timeAxisTop);
    blit(this.timeAxisOverlay, 0, this.timeAxisTop);
    ctx.fillStyle = this.theme.border;
    ctx.fillRect(0, Math.round(this.timeAxisTop * dpr), out.width, Math.max(1, Math.floor(dpr)));
    ctx.fillRect(Math.round(this.paneWidth * dpr), 0, Math.max(1, Math.floor(dpr)), out.height);
    return out;
  }

  /** Hit test at viewport coordinates, with chart-space details. */
  describePoint(clientX: number, clientY: number): ChartPoint {
    const r = this.root.getBoundingClientRect();
    const hit = this.hitTest(clientX - r.left, clientY - r.top);
    const base = { clientX, clientY, kind: hit.kind } as ChartPoint;
    if (hit.kind === 'pane' || hit.kind === 'priceAxis') {
      base.paneId = hit.pane.id;
      base.price = hit.pane.priceScale.yToPrice(hit.y);
    }
    if (hit.kind === 'pane' || hit.kind === 'timeAxis') {
      const i = this.timeScale.xToIndex(hit.x);
      base.index = i;
      base.time = this.store.time[Math.max(0, Math.min(i, this.store.length - 1))] ?? null;
    }
    if (hit.kind === 'pane') base.seriesId = hit.seriesId;
    return base;
  }

  scrollToRealtime(): void {
    this.timeScale.reset(this.store.length - 1);
    this.invalidate(INVALIDATE_MAIN);
  }

  getState(): ChartState {
    return {
      version: 1,
      symbol: this.symbol,
      interval: formatInterval(this.interval),
      timeScale: { barSpacing: this.timeScale.barSpacing, rightOffset: this.timeScale.rightOffset },
      crosshair: { mode: this.options.crosshair, magnet: this.options.magnet },
      timezone: this.options.timezone,
      panes: this.panes.map((p) => {
        const ps = p.priceScale;
        return {
          id: p.id,
          ratio: p.ratio,
          collapsed: p.collapsed,
          priceScale: {
            mode: ps.mode,
            autoScale: ps.autoScale,
            invert: ps.invert,
            ...(ps.autoScale ? {} : { min: ps.min, max: ps.max }),
          },
        };
      }),
      maximizedPane: this.maximized?.id ?? null,
    };
  }

  async setState(state: ChartState): Promise<void> {
    this.options = {
      ...this.options,
      crosshair: state.crosshair.mode,
      magnet: state.crosshair.magnet,
      timezone: state.timezone,
    };
    // Recreate extra panes to match the saved list (main pane always first).
    for (const p of this.panes.slice(1)) this.removePane(p.id);
    for (const ps of state.panes) {
      const pane = ps.id === 'main' ? this.panes[0]! : this.addPane(ps.ratio, ps.id);
      pane.ratio = ps.ratio;
      pane.collapsed = ps.collapsed;
      Object.assign(pane.priceScale, {
        mode: ps.priceScale.mode,
        autoScale: ps.priceScale.autoScale,
        invert: ps.priceScale.invert,
      });
      if (
        !ps.priceScale.autoScale &&
        ps.priceScale.min !== undefined &&
        ps.priceScale.max !== undefined
      ) {
        pane.priceScale.min = ps.priceScale.min;
        pane.priceScale.max = ps.priceScale.max;
      }
    }
    this.maximized = this.panes.find((p) => p.id === state.maximizedPane) ?? null;
    this.timeScale.barSpacing = state.timeScale.barSpacing;
    const view = state.timeScale.rightOffset;
    if (state.symbol) {
      await this.setSymbolAndInterval(state.symbol, state.interval);
      this.timeScale.rightOffset = view;
      this.timeScale.clamp();
    }
    this.invalidate(INVALIDATE_LAYOUT);
  }

  on<K extends keyof ChartEvents>(event: K, fn: (p: ChartEvents[K]) => void): () => void {
    return this.events.on(event, fn);
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    clearInterval(this.countdownTimer);
    this.resizeObserver.disconnect();
    this.unsubscribe?.();
    this.controller.destroy();
    this.events.clear();
    this.root.remove();
  }

  // ------------------------------------------------------- used by interaction

  get paneWidth(): number {
    return Math.max(0, this.width - this.axisWidth);
  }

  get timeAxisTop(): number {
    return this.height - TIME_AXIS_HEIGHT;
  }

  visiblePanes(): Pane[] {
    return this.panes.filter((p) => p.height > 0);
  }

  hitTest(x: number, y: number): HitTarget {
    if (y >= this.timeAxisTop)
      return x < this.paneWidth ? { kind: 'timeAxis', x } : { kind: 'none' };
    const visible = this.visiblePanes();
    for (let i = 1; i < visible.length; i++) {
      if (Math.abs(y - visible[i]!.top) <= 3) return { kind: 'separator', index: i };
    }
    const pane = visible.find((p) => y >= p.top && y < p.top + p.height);
    if (!pane) return { kind: 'none' };
    const py = y - pane.top;
    if (x >= this.paneWidth) return { kind: 'priceAxis', pane, y: py };
    return { kind: 'pane', pane, x, y: py, seriesId: this.hitSeries(pane, x, py) };
  }

  private hitSeries(pane: Pane, x: number, y: number): string | null {
    const i = this.timeScale.xToIndex(x);
    const ps = pane.priceScale;
    const price = ps.yToPrice(y);
    const tol = Math.abs(ps.yToPrice(y - 4) - price);
    for (let k = pane.series.length - 1; k >= 0; k--) {
      const s = pane.series[k]!;
      if (s.hitTest(i, price, tol)) return s.id;
    }
    return null;
  }

  /** Separator drag: move the boundary above visible pane `index` by dy px. */
  resizeSeparator(index: number, dy: number): void {
    const visible = this.visiblePanes().filter((p) => !p.collapsed);
    const above = visible[index - 1];
    const below = visible[index];
    if (!above || !below) return;
    const total = above.height + below.height;
    const newAbove = Math.min(
      total - MIN_PANE_HEIGHT,
      Math.max(MIN_PANE_HEIGHT, above.height + dy),
    );
    const ratioSum = above.ratio + below.ratio;
    above.ratio = (ratioSum * newAbove) / total;
    below.ratio = ratioSum - above.ratio;
    this.invalidate(INVALIDATE_LAYOUT);
  }

  setCrosshair(pane: Pane | null, x: number, y: number): void {
    if (!pane || !this.store.length) {
      if (this.crosshair) {
        this.crosshair = null;
        this.invalidate(INVALIDATE_OVERLAY);
        this.emitCrosshair();
      }
      return;
    }
    const index = Math.max(0, Math.min(this.store.length - 1, this.timeScale.xToIndex(x)));
    const snappedX = this.timeScale.indexToX(this.timeScale.xToIndex(x));
    this.crosshair = { pane, x: snappedX, y: this.magnetY(pane, index, y), index, rawY: y };
    this.invalidate(INVALIDATE_OVERLAY);
    this.emitCrosshair();
  }

  private magnetY(pane: Pane, index: number, y: number): number {
    const mode = this.options.magnet;
    if (mode === 'off') return y;
    const ps = pane.priceScale;
    let best = y;
    let bestDist = Infinity;
    for (const s of pane.series) {
      for (const v of s.valuesAt(index)) {
        const vy = ps.priceToY(v);
        const d = Math.abs(vy - y);
        if (d < bestDist) {
          bestDist = d;
          best = vy;
        }
      }
    }
    if (mode === 'weak' && bestDist > 20) return y;
    return best;
  }

  /** Called by the controller after any view change. */
  viewChanged(): void {
    this.invalidate(INVALIDATE_MAIN);
    if (this.crosshair)
      this.setCrosshair(this.crosshair.pane, this.crosshair.x, this.crosshair.rawY);
  }

  viewSettled(): void {
    this.emitState();
  }

  invalidate(level: number): void {
    if (this.destroyed) return;
    this.invalid |= level;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
  }

  // ---------------------------------------------------------------- data flow

  private load(): Promise<void> {
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    const gen = ++this.loadGen;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setStatus('Loading…');
    this.events.emit('loading', true);
    const symbol = this.symbol;
    const interval = this.interval;
    try {
      const info = await this.feed.resolveSymbol(symbol);
      if (gen !== this.loadGen) return;
      this.symbolInfo = info;
      this.decimals = decimalsForMinTick(info.minTick);
      this.updateTimezone();
      this.events.emit('symbolResolved', info);

      const res = await this.feed.getBars({
        symbol,
        interval,
        limit: this.options.pageSize,
        prepost: this.options.prepost,
        adjusted: this.options.adjusted,
      });
      if (gen !== this.loadGen) return;
      this.store.setAll(res.bars);
      this.hasMore = res.hasMore;
      this.recomputeWeights();
      this.timeScale.reset(this.store.length - 1);
      for (const p of this.panes) p.priceScale.autoScale = true;
      this.crosshair = null;
      this.setStatus(this.store.length ? null : 'No data');
      this.subscribeLive(gen);
      this.invalidate(INVALIDATE_LAYOUT);
      this.events.emit('dataLoaded', {
        symbol,
        interval: formatInterval(interval),
        bars: this.store.length,
      });
      this.emitState();
    } catch (err) {
      if (gen !== this.loadGen) return;
      const message = err instanceof Error ? err.message : String(err);
      this.store.clear();
      this.setStatus(message);
      this.invalidate(INVALIDATE_LAYOUT);
      this.events.emit('error', { message });
    } finally {
      if (gen === this.loadGen) this.events.emit('loading', false);
    }
  }

  private subscribeLive(gen: number): void {
    const info = this.symbolInfo;
    this.unsubscribe = this.feed.subscribe(
      {
        symbol: this.symbol,
        interval: this.interval,
        prepost: this.options.prepost,
        timezone: info?.timezone ?? null,
        session: info?.session ?? null,
      },
      this.store.last(),
      (bar) => {
        if (gen !== this.loadGen) return;
        const r = this.store.upsert(bar);
        if (r === 'ignored') return;
        if (r === 'append') {
          this.timeScale.onAppend();
          this.recomputeWeights();
        }
        this.invalidate(INVALIDATE_MAIN);
        if (this.crosshair) this.emitCrosshair();
        this.events.emit('barUpdate', bar);
      },
    );
  }

  private loadMorePromise: Promise<number> | null = null;

  /** Load one older page. Concurrent callers share the in-flight request.
   * Resolves to the number of bars prepended. */
  private loadMore(): Promise<number> {
    if (this.loadMorePromise) return this.loadMorePromise;
    if (!this.hasMore || !this.store.length) return Promise.resolve(0);
    this.loadingMore = true;
    const gen = this.loadGen;
    this.loadMorePromise = (async () => {
      try {
        const res = await this.feed.getBars({
          symbol: this.symbol,
          interval: this.interval,
          to: this.store.time[0]!,
          limit: this.options.pageSize,
          prepost: this.options.prepost,
          adjusted: this.options.adjusted,
        });
        if (gen !== this.loadGen) return 0;
        const n = this.store.prepend(res.bars);
        this.hasMore = res.hasMore && n > 0;
        if (n > 0) {
          this.timeScale.onPrepend(n);
          if (this.crosshair) this.crosshair.index += n;
          this.recomputeWeights();
          this.invalidate(INVALIDATE_MAIN);
        }
        return n;
      } catch (err) {
        this.events.emit('error', { message: err instanceof Error ? err.message : String(err) });
        return 0;
      } finally {
        this.loadingMore = false;
        this.loadMorePromise = null;
      }
    })();
    return this.loadMorePromise;
  }

  /** Load history until the first bar is at or before `time` (or none is left). */
  private async ensureHistory(time: number): Promise<void> {
    const gen = this.loadGen;
    while (
      gen === this.loadGen &&
      this.hasMore &&
      this.store.length &&
      this.store.time[0]! > time
    ) {
      if ((await this.loadMore()) === 0) break;
    }
  }

  private updateTimezone(): void {
    const opt = this.options.timezone;
    const tz = opt === 'exchange' ? (this.symbolInfo?.timezone ?? 'UTC') : opt;
    this.tz = createTzConverter(tz);
    this.recomputeWeights();
    this.invalidate(INVALIDATE_MAIN);
  }

  private recomputeWeights(): void {
    const n = this.store.length;
    if (this.weights.length < n) this.weights = new Uint8Array(Math.ceil(n * 1.25) + 64);
    computeTimeWeights(this.store.time.subarray(0, n), this.tz, this.weights);
  }

  private setStatus(text: string | null): void {
    this.statusEl.textContent = text ?? '';
    this.statusEl.style.display = text ? '' : 'none';
  }

  private emitState(): void {
    this.events.emit('stateChange', this.getState());
  }

  private emitCrosshair(): void {
    const c = this.crosshair;
    const bar = c ? this.store.bar(c.index) : null;
    this.events.emit('crosshairMove', {
      paneId: c?.pane.id ?? null,
      index: c?.index ?? null,
      time: bar?.time ?? null,
      price: c ? c.pane.priceScale.yToPrice(c.y) : null,
      bar,
    });
  }

  // ---------------------------------------------------------------- rendering

  private flush(): void {
    this.frame = 0;
    const level = this.invalid;
    this.invalid = 0;
    if (level & INVALIDATE_LAYOUT) this.layout();
    if (level & (INVALIDATE_LAYOUT | INVALIDATE_MAIN)) this.renderMain();
    this.renderOverlay();
  }

  private layout(): void {
    const rect = this.root.getBoundingClientRect();
    this.width = Math.floor(rect.width);
    this.height = Math.floor(rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.axisWidth = this.measureAxisWidth();
    const paneW = this.paneWidth;
    this.timeScale.width = paneW;
    this.timeScale.clamp();

    const available = Math.max(0, this.timeAxisTop);
    const heights = this.paneHeights(available);
    let top = 0;
    this.panes.forEach((pane, i) => {
      const h = heights[i]!;
      pane.layout(0, top, paneW, h, this.axisWidth, this.dpr);
      top += h;
    });

    place(this.timeAxisEl, 0, this.timeAxisTop, this.width, TIME_AXIS_HEIGHT);
    this.timeAxisMain.resize(this.width, TIME_AXIS_HEIGHT, this.dpr);
    this.timeAxisOverlay.resize(this.width, TIME_AXIS_HEIGHT, this.dpr);

    // Separators between visible panes.
    const visible = this.visiblePanes();
    while (this.separators.length < Math.max(0, visible.length - 1)) {
      this.separators.push(div(this.root, 'io-separator'));
    }
    this.separators.forEach((sep, i) => {
      const pane = visible[i + 1];
      sep.style.display = pane ? '' : 'none';
      if (pane) place(sep, 0, pane.top, this.width, 1);
    });
  }

  private paneHeights(available: number): number[] {
    if (this.maximized) return this.panes.map((p) => (p === this.maximized ? available : 0));
    const collapsed = this.panes.filter((p) => p.collapsed).length;
    const flexible = Math.max(0, available - collapsed * COLLAPSED_PANE_HEIGHT);
    const ratioSum = this.panes.reduce((s, p) => s + (p.collapsed ? 0 : p.ratio), 0) || 1;
    const heights = this.panes.map((p) =>
      p.collapsed ? COLLAPSED_PANE_HEIGHT : Math.floor((flexible * p.ratio) / ratioSum),
    );
    // Give rounding leftovers to the main pane.
    const used = heights.reduce((s, h) => s + h, 0);
    const mainIdx = this.panes.findIndex((p) => !p.collapsed);
    if (mainIdx >= 0) heights[mainIdx]! += available - used;
    return heights;
  }

  private measureAxisWidth(): number {
    const ctx = this.timeAxisMain.ctx;
    ctx.font = font(this.theme);
    let max = 0;
    for (const p of this.panes) {
      const ps = p.priceScale;
      const samples = [ps.max, ps.min].map((v) => this.formatAxisValue(p, ps.fromInternal(v)));
      for (const s of samples) max = Math.max(max, ctx.measureText(s).width);
    }
    const w = Math.ceil(max + 22);
    // Grow freely, shrink only on big changes to avoid jitter while panning.
    if (w > this.axisWidth || w < this.axisWidth - 16) return Math.max(MIN_AXIS_WIDTH, w);
    return Math.max(MIN_AXIS_WIDTH, this.axisWidth);
  }

  private formatAxisValue(pane: Pane, price: number): string {
    const ps = pane.priceScale;
    if (ps.mode === 'percent') return formatPercent(ps.toDisplay(price)).replace('+', '');
    if (ps.mode === 'indexed') return formatPrice(ps.toDisplay(price), 2);
    return pane.id === 'main'
      ? formatPrice(price, this.decimals)
      : formatAxisNumber(price, pane.labelDecimals + 1);
  }

  private renderMain(): void {
    const { from, to } = this.timeScale.visibleRange();
    const t = this.theme;
    const paneW = this.paneWidth;

    if (from !== this.lastRange.from || to !== this.lastRange.to) {
      this.lastRange = { from, to };
      this.events.emit('visibleRangeChange', { from, to });
    }
    if (this.timeScale.logicalRange().from < LAZY_LOAD_THRESHOLD && this.hasMore)
      void this.loadMore();

    // Time marks shared by grid and time axis.
    const n = this.store.length;
    this.marks =
      n && from <= to
        ? selectTimeMarks({
            times: this.store.time.subarray(0, n),
            weights: this.weights.subarray(0, n),
            from,
            to,
            indexToX: (i) => this.timeScale.indexToX(i),
            minSpacingPx: 64,
            tz: this.tz,
            locale: this.options.locale,
          })
        : [];

    let widthChanged = false;
    for (const pane of this.panes) {
      if (pane.height <= 0) continue;
      const ps = pane.priceScale;
      // Auto-scale + percent base.
      const base = pane.series[0]?.baseValue(from);
      if (base) ps.base = base;
      if (ps.autoScale && from <= to) {
        let min = Infinity;
        let max = -Infinity;
        for (const s of pane.series) {
          const r = s.priceRange(from, to);
          if (r) {
            min = Math.min(min, r.min);
            max = Math.max(max, r.max);
          }
        }
        if (min <= max) ps.setAutoRange(min, max);
      }

      // Background + grid.
      const bgCtx = pane.bg.begin();
      bgCtx.fillStyle = t.background;
      bgCtx.fillRect(0, 0, paneW, pane.height);
      const dev = pane.bg.device();
      dev.fillStyle = t.grid;
      for (const m of this.marks) vLine(dev, m.x, 0, pane.height, this.dpr);
      const ticks = ps.ticks(pane.height < 120 ? 24 : 34);
      pane.labelDecimals = decimalsForStep(ticks);
      for (const tk of ticks) hLine(dev, tk.y, 0, paneW, this.dpr);

      // Series.
      pane.main.begin();
      const ctx = pane.main.device();
      if (from <= to) {
        for (const s of pane.series) {
          s.draw({
            ctx,
            dpr: this.dpr,
            width: paneW,
            height: pane.height,
            timeScale: this.timeScale,
            priceScale: ps,
            theme: t,
            from,
            to,
          });
        }
      }
      // Last price line.
      const last = pane.series[0]?.lastValue(t);
      if (last) {
        const c = pane.main.css();
        c.strokeStyle = last.color;
        dashedLine(c, 0, ps.priceToY(last.price), paneW, ps.priceToY(last.price), this.dpr, [1, 2]);
      }

      // Axis tick labels.
      const ac = pane.axisMain.begin();
      ac.fillStyle = t.background;
      ac.fillRect(0, 0, this.axisWidth, pane.height);
      ac.fillStyle = t.text;
      ac.font = font(t);
      ac.textBaseline = 'middle';
      ac.textAlign = 'left';
      for (const tk of ticks) {
        if (tk.y < 6 || tk.y > pane.height - 6) continue;
        const text = this.formatTick(pane, tk.value);
        ac.fillText(text, 9, tk.y);
        if (ac.measureText(text).width + 22 > this.axisWidth + 16) widthChanged = true;
      }
    }

    // Time axis labels.
    const tc = this.timeAxisMain.begin();
    tc.fillStyle = t.background;
    tc.fillRect(0, 0, this.width, TIME_AXIS_HEIGHT);
    tc.fillStyle = t.text;
    tc.font = font(t);
    tc.textBaseline = 'middle';
    tc.textAlign = 'center';
    for (const m of this.marks) {
      tc.font = font(t, t.fontSize, m.weight >= 50 ? '600' : '');
      tc.fillText(m.label, m.x, TIME_AXIS_HEIGHT / 2);
    }

    this.updateLegends();
    if (widthChanged || this.measureAxisWidth() !== this.axisWidth)
      this.invalidate(INVALIDATE_LAYOUT);
  }

  private formatTick(pane: Pane, value: number): string {
    const ps = pane.priceScale;
    if (ps.mode === 'percent') return `${formatPrice(value, 2)}%`;
    if (ps.mode === 'indexed') return formatPrice(value, 2);
    return pane.id === 'main'
      ? formatPrice(value, this.decimals)
      : formatAxisNumber(value, pane.labelDecimals);
  }

  private renderOverlay(): void {
    const t = this.theme;
    const c = this.crosshair;
    const fontStr = font(t);
    const paneW = this.paneWidth;

    for (const pane of this.panes) {
      if (pane.height <= 0) continue;
      const ctx = pane.overlay.begin();
      const ax = pane.axisOverlay.begin();
      const ps = pane.priceScale;

      // Last value labels (+ countdown on the main pane for intraday).
      const last = pane.series[0]?.lastValue(t);
      if (last) {
        const y = ps.priceToY(last.price);
        const text = this.formatAxisValue(pane, last.price);
        const countdown = pane.id === 'main' ? this.countdown() : null;
        const h = countdown ? AXIS_LABEL_HEIGHT + 14 : AXIS_LABEL_HEIGHT;
        const top = Math.max(0, Math.min(pane.height - h, y - AXIS_LABEL_HEIGHT / 2));
        labelBox(ax, text, 1, top, this.axisWidth - 2, h, last.color, '#ffffff', fontStr);
        if (countdown) {
          ax.font = font(t, t.fontSize - 1);
          ax.fillText(countdown, 7, top + AXIS_LABEL_HEIGHT + 4);
        }
      }

      if (!c) continue;
      ctx.strokeStyle = t.crosshair;
      dashedLine(ctx, c.x, 0, c.x, pane.height, this.dpr, [4, 4]);
      if (c.pane === pane) {
        dashedLine(ctx, 0, c.y, paneW, c.y, this.dpr, [4, 4]);
        if (this.options.crosshair === 'dot') {
          ctx.fillStyle = t.crosshair;
          ctx.beginPath();
          ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        const price = ps.yToPrice(c.y);
        const top = Math.max(
          0,
          Math.min(pane.height - AXIS_LABEL_HEIGHT, c.y - AXIS_LABEL_HEIGHT / 2),
        );
        labelBox(
          ax,
          this.formatAxisValue(pane, price),
          1,
          top,
          this.axisWidth - 2,
          AXIS_LABEL_HEIGHT,
          t.crosshairLabelBg,
          t.crosshairLabelText,
          fontStr,
        );
      }
    }

    const tc = this.timeAxisOverlay.begin();
    if (c) {
      const time = this.store.time[c.index];
      if (time !== undefined) {
        const text = formatCrosshairTime(time, this.interval.unit, this.tz, this.options.locale);
        tc.font = fontStr;
        const w = tc.measureText(text).width + 16;
        const x = Math.max(0, Math.min(paneW - w, c.x - w / 2));
        labelBox(
          tc,
          text,
          x,
          3,
          w,
          AXIS_LABEL_HEIGHT,
          t.crosshairLabelBg,
          t.crosshairLabelText,
          fontStr,
          'center',
        );
      }
    }
    this.updateLegends();
  }

  private countdown(): string | null {
    if (!isIntraday(this.interval) || !this.store.length) return null;
    const end = this.store.time[this.store.length - 1]! + intervalSeconds(this.interval);
    const left = Math.floor(end - Date.now() / 1000);
    if (left <= 0 || left > intervalSeconds(this.interval)) return null;
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    const pad = (v: number) => String(v).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  private updateLegends(): void {
    const t = this.theme;
    const n = this.store.length;
    const idx = this.crosshair?.index ?? n - 1;
    for (const pane of this.panes) {
      if (pane.id === 'main') {
        const info = this.symbolInfo;
        const bar = this.store.bar(idx);
        const prev = this.store.bar(idx - 1);
        const title = info
          ? `${info.symbol} · ${formatInterval(this.interval)} · ${info.exchangeName ?? info.exchange ?? ''}`
          : this.symbol;
        let html = `<span class="io-legend-title">${escapeHtml(title)}</span>`;
        if (bar) {
          const color = bar.close >= bar.open ? t.up : t.down;
          const f = (v: number) => formatPrice(v, this.decimals);
          const item = (label: string, v: string) =>
            `<span class="io-legend-item"><span class="io-legend-label">${label}</span><span style="color:${color}">${v}</span></span>`;
          html +=
            item('O', f(bar.open)) +
            item('H', f(bar.high)) +
            item('L', f(bar.low)) +
            item('C', f(bar.close));
          if (prev) {
            const ch = bar.close - prev.close;
            const pct = (ch / prev.close) * 100;
            const sign = ch >= 0 ? '+' : '';
            html += `<span class="io-legend-item" style="color:${color}">${sign}${f(ch)} (${formatPercent(pct)})</span>`;
          }
          html += `<span class="io-legend-item"><span class="io-legend-label">Vol</span><span style="color:${color}">${formatVolume(bar.volume)}</span></span>`;
        }
        setHtml(pane.legendEl, html);
      } else {
        const html = pane.series
          .map((s) => {
            const v = s.valuesAt(idx);
            const val = v.length ? formatAxisNumber(v[v.length - 1]!, pane.labelDecimals + 1) : '—';
            return `<span class="io-legend-title">${escapeHtml(s.title)}</span><span class="io-legend-item">${val}</span>`;
          })
          .join('');
        setHtml(pane.legendEl, html);
      }
    }
  }
}

export function createChart(
  container: HTMLElement,
  feed: DataFeed,
  options: Partial<ChartOptions> = {},
): Chart {
  return new Chart(container, feed, options);
}

function setHtml(el: HTMLElement, html: string): void {
  if (el.innerHTML !== html) el.innerHTML = html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function formatAxisNumber(v: number, decimals: number): string {
  if (Math.abs(v) >= 1e5) return formatVolume(v);
  return formatPrice(v, Math.min(8, decimals));
}

/** Decimals needed to tell adjacent ticks apart (step 0.25 -> 2, 5 -> 0). */
function decimalsForStep(ticks: { value: number }[]): number {
  const a = ticks[0];
  const b = ticks[1];
  if (!a || !b) return 2;
  const step = Math.abs(b.value - a.value);
  if (!(step > 0)) return 2;
  let d = 0;
  while (d < 8 && Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) > 1e-9 * 10 ** d) d++;
  return d;
}
