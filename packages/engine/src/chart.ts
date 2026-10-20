import { Emitter } from './events';
import { formatInterval, intervalSeconds, isIntraday, parseInterval } from './feed/intervals';
import { SeriesStore } from './model/series-store';
import { DEFAULT_OPTIONS, type ChartOptions, type ChartTheme } from './options';
import { Pane, div, place } from './pane';
import { CanvasLayer } from './render/canvas';
import { dashedLine, font, hLine, labelBox, vLine } from './render/draw';
import {
  drawMarkers,
  drawMarkerTooltip,
  hitMarker,
  layoutMarkers,
  type ChartMarker,
  type PlacedMarker,
} from './render/markers';
import {
  drawPriceLineAxisLabels,
  drawPriceLines,
  hitPriceLine,
  layoutPriceLines,
  type ChartPriceLine,
  type PlacedPriceLine,
} from './render/price-lines';
import { type PaneSeries } from './render/series';
import { MainSeries, VolumeSeries, type VolumeMode } from './render/main-series';
import {
  BRICK_TYPES,
  defaultChartStyle,
  type ChartStyle,
  type ChartType,
  type TransformExtra,
} from './chart-types';
import {
  heikinAshi,
  kagi,
  lastAtr,
  lineBreak,
  pointFigure,
  rangeBars,
  renko,
  roundBoxSize,
} from './transforms';
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
import { formatStudyTick, formatStudyValue } from './studies/format';
import { commonPrefix, diffTail, snapshotSeries, type SeriesSnapshot } from './studies/series-diff';
import { Study } from './studies/study';
import { StudySeries, type StudyLastValue } from './studies/study-series';
import type {
  LegendSlotKind,
  SeriesChange,
  StudyApi,
  StudyData,
  StudyDataPatch,
  StudyEvents,
  StudyInfo,
  StudyLegendValue,
  StudyOutputStylePatch,
  StudySpec,
  StudyTarget,
} from './studies/types';
import { DrawingInteraction, type DrawingPointerTarget } from './drawings/interaction';
import { cloneDrawing, DrawingLayer, type DrawingHit, type DrawingHost } from './drawings/layer';
import { isPaneCoords, withTime } from './drawings/geometry';
import { buildTradingCalendar, type TradingCalendar } from './drawings/calendar';
import { logicalToTime, timeToLogical, type AnchorTimeline } from './drawings/mapping';
import { getDrawingTool } from './drawings/registry';
import { mapSyncTime, type SyncTimeRef } from './sync/time-map';
import type {
  Drawing,
  DrawingApi,
  DrawingAxisLabel,
  DrawingBounds,
  DrawingChange,
  DrawingClipboard,
  DrawingEvents,
  DrawingFormat,
  DrawingInput,
  DrawingOptions,
  DrawingPasteOptions,
  DrawingPatch,
  DrawingPoint,
  DrawingToolOptions,
} from './drawings/types';
import './drawings/tools';

const TIME_AXIS_HEIGHT = 28;
const MIN_AXIS_WIDTH = 56;
const COLLAPSED_PANE_HEIGHT = 24;
const MIN_PANE_HEIGHT = 30;
const LAZY_LOAD_THRESHOLD = 150;
const AXIS_LABEL_HEIGHT = 20;
/** Width of the "+" box at the left edge of the price label (axis-relative from x = 1). */
const PLUS_WIDTH = 18;

const INVALIDATE_OVERLAY = 1;
const INVALIDATE_MAIN = 2;
const INVALIDATE_LAYOUT = 4;
/** Tolerance (bar slots) for pane edges computed in floating point. */
const EDGE_EPS = 1e-6;

/** Ids reserved for built-in series. */
const RESERVED_STUDY_IDS = new Set(['main', 'volume', 'volume-pane']);

export interface CrosshairInfo {
  paneId: string | null;
  index: number | null;
  time: number | null;
  price: number | null;
  bar: Bar | null;
}

/**
 * What moved the view: a pointer/keyboard gesture that moved the time axis
 * ('user'), a price-scale-only gesture ('price'; the visible time range is
 * unchanged), an API call, or a data load.
 */
export type ViewChangeCause = 'user' | 'price' | 'api' | 'data';

/** Crosshair position from another chart of a layout (see `setSyncedCrosshair`). */
export interface SyncedCrosshair {
  /** Open time (unix s) of the source chart's bar under its crosshair. */
  time: number;
  /** Source chart interval, e.g. "5m", "1D". */
  interval: string;
  /** Exchange timezone (IANA) of the source symbol; null = UTC. */
  timezone: string | null;
  /** Price for the horizontal line; null = vertical line only (another symbol). */
  price: number | null;
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
  /** Drawing under the point, if any. */
  drawingId?: string | null;
}

export interface ChartEvents extends StudyEvents, DrawingEvents {
  contextMenu: ChartPoint;
  /** Live update of the last bar (or a newly appended one). */
  barUpdate: Bar;
  crosshairMove: CrosshairInfo;
  visibleRangeChange: { from: number; to: number };
  /** The time scale moved or zoomed, or the bars under it changed. */
  viewChange: { cause: ViewChangeCause };
  symbolResolved: SymbolInfo;
  dataLoaded: { symbol: string; interval: string; bars: number };
  loading: boolean;
  error: { message: string };
  stateChange: ChartState;
  /** The "+" on the price axis label was clicked. */
  priceAxisPlus: { paneId: string; price: number };
  markerClick: { group: string; id: string };
  priceLineClick: { group: string; id: string };
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
  chartType?: ChartType;
  volume?: VolumeMode;
  timeScale: { barSpacing: number; rightOffset: number };
  crosshair: { mode: ChartOptions['crosshair']; magnet: ChartOptions['magnet'] };
  timezone: ChartOptions['timezone'];
  panes: PaneState[];
  maximizedPane: string | null;
}

export type HitTarget =
  | {
      kind: 'pane';
      pane: Pane;
      x: number;
      y: number;
      seriesId: string | null;
      /** Study output under the pointer when `seriesId` is a study. */
      outputId?: string | null;
      /** Only a study fill's interior is under the pointer (a weak hit: no
       * pointer cursor; any line, mark or bar of any series wins over it). */
      fill?: boolean;
      /** Drawing part under the pointer (drawings sit above all series). With a
       * drawing hit, `seriesId` is null unless the drawing hit is weak. */
      drawing?: DrawingHit;
      /** Marker or price line under the pointer (checked before drawings on click). */
      marker?: { group: string; id: string };
      priceLine?: { group: string; id: string };
    }
  | {
      kind: 'priceAxis';
      pane: Pane;
      y: number;
      /** The "+" box of the price label is under the pointer. */
      plus?: boolean;
      /** A price line's axis label is under the pointer. */
      priceLine?: { group: string; id: string };
    }
  | { kind: 'timeAxis'; x: number }
  | { kind: 'separator'; index: number }
  | { kind: 'none' };

interface CrosshairPos {
  pane: Pane;
  x: number; // snapped to bar centre
  y: number; // snapped by magnet
  index: number;
  rawX: number;
  rawY: number;
}

export class Chart implements StudyApi, DrawingApi {
  readonly root: HTMLDivElement;
  /** Bars as loaded from the feed. */
  private readonly raw = new SeriesStore();
  /** Transformed bars (Heikin Ashi, bricks) when the chart type needs them. */
  private readonly derived = new SeriesStore();
  private _chartType: ChartType = 'candles';
  private styleOverrides: DeepPartial<ChartStyle> = {};
  private _chartStyle: ChartStyle;
  private _extra: TransformExtra = {};
  /** For transformed views: source (raw) bar index of each displayed bar. */
  private sourceIndex: Int32Array | null = null;
  /** Brick size resolved at load time (ATR mode), kept stable for live updates. */
  private brickSize: number | null = null;
  /** Built-in volume (kept for API compatibility; the app shows volume as a study). */
  private volumeMode: VolumeMode = 'hidden';
  private volumeOverlay: VolumeSeries;
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
  /** Crosshair mirrored from another chart; `logical` is cached per `key` (bars, chart type). */
  private synced: { ref: SyncTimeRef; price: number | null; logical: number; key: string } | null =
    null;
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
  /** Studies by id (each also sits in its pane's series list). */
  private readonly studies = new Map<string, StudySeries>();
  private _seriesRevision = 0;
  private hoveredStudy: { id: string; outputId: string | null } | null = null;
  private readonly drawingLayer: DrawingLayer;
  /** Drawing pointer/keyboard state machine (used by the InteractionController). */
  readonly drawingInput: DrawingInteraction;
  private readonly timeline = {
    time: new Float64Array(0) as ArrayLike<number>,
    length: 0,
    interval: { unit: 'day', count: 1 } as Interval,
    bricks: false,
    endTime: NaN,
    calendar: null as TradingCalendar | null,
  };
  private calendarKey = '';
  /** Bumped when the raw bars are replaced or extended backwards (not on live bars). */
  private rawEpoch = 0;
  private readonly drawingFormats = new Map<string, DrawingFormat>();
  private readonly intervalCache: { iv: Interval | null; str: string } = { iv: null, str: '' };
  private readonly axisLabelBuf: DrawingAxisLabel[] = [];
  private readonly markerGroups = new Map<string, readonly ChartMarker[]>();
  private readonly lineGroups = new Map<string, readonly ChartPriceLine[]>();
  /** Pointer over a price axis (drives the price label + "+" without the crosshair). */
  private axisHover: { pane: Pane; y: number } | null = null;

  constructor(container: HTMLElement, feed: DataFeed, options: Partial<ChartOptions> = {}) {
    injectStyle();
    this.feed = feed;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.root = div(container, 'io-chart');
    this.root.tabIndex = 0;
    Object.assign(this.root.style, { width: '100%', height: '100%' });
    applyThemeVars(this.root, this.options.theme);

    const main = new Pane(this.root, 3, 'main');
    this._chartStyle = defaultChartStyle(this.options.theme);
    main.series.push(new MainSeries(this));
    this.volumeOverlay = new VolumeSeries('volume', this, true);
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
    this.drawingLayer = new DrawingLayer(this.createDrawingHost());
    this.drawingInput = new DrawingInteraction(this.drawingLayer);
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
    if (opts.theme)
      this._chartStyle = mergeDeep(defaultChartStyle(opts.theme), this.styleOverrides);
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

  /** Removes a non-main pane with everything on it. Emits paneRemoved when
   * it held studies, so the app can drop their instances. */
  removePane(id: string): void {
    const studyIds = this.dropPane(id);
    if (studyIds?.length) this.events.emit('paneRemoved', { paneId: id, studyIds });
  }

  /** Remove a non-main pane; returns the ids of the studies dropped with it
   * (null when nothing was removed). Emits no study events. */
  private dropPane(id: string): string[] | null {
    const i = this.panes.findIndex((p) => p.id === id);
    if (i <= 0) return null; // the main pane stays
    const [pane] = this.panes.splice(i, 1);
    // Drawings on the pane stay in the model (not drawn); stop any gesture there.
    if (this.drawingInput.busy) this.drawingInput.abort();
    const studyIds: string[] = [];
    for (const s of pane?.series ?? []) {
      if (s instanceof StudySeries) {
        studyIds.push(s.id);
        this.studies.delete(s.id);
        if (this.hoveredStudy?.id === s.id) this.hoverStudy(null);
      }
    }
    pane?.destroy();
    if (this.maximized === pane) this.maximized = null;
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
    return studyIds;
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

  // ---------------------------------------------------------------- studies

  /** Increments on every 'reset' SeriesChange. */
  get seriesRevision(): number {
    return this._seriesRevision;
  }

  addStudy(spec: StudySpec): string {
    if (RESERVED_STUDY_IDS.has(spec.id)) throw new Error(`Reserved study id: ${spec.id}`);
    if (this.studies.has(spec.id)) throw new Error(`Study already exists: ${spec.id}`);
    const pane = this.resolveStudyTarget(spec.target);
    const series = new StudySeries(new Study(spec, pane.id), this);
    pane.series.push(series);
    this.studies.set(spec.id, series);
    this.invalidate(INVALIDATE_LAYOUT);
    return pane.id;
  }

  removeStudy(id: string): void {
    const s = this.studies.get(id);
    if (!s) return;
    this.studies.delete(id);
    if (this.hoveredStudy?.id === id) this.hoverStudy(null);
    this.detachStudy(s);
    this.invalidate(INVALIDATE_LAYOUT);
  }

  moveStudy(id: string, target: StudyTarget): string {
    const s = this.studies.get(id);
    if (!s) throw new Error(`Unknown study: ${id}`);
    if ('paneId' in target && target.paneId === s.study.paneId) return target.paneId;
    if ('newPane' in target && target.newPane.id === s.study.paneId) return s.study.paneId;
    const pane = this.resolveStudyTarget(target);
    this.detachStudy(s);
    pane.series.push(s);
    s.study.paneId = pane.id;
    this.invalidate(INVALIDATE_LAYOUT);
    return pane.id;
  }

  getStudies(): StudyInfo[] {
    return [...this.studies.values()].map((s) => ({
      id: s.id,
      paneId: s.study.paneId,
      title: s.study.spec.title,
      visible: s.study.spec.visible,
    }));
  }

  /** Replaces all values. Data computed on an older series revision is ignored. */
  setStudyData(id: string, data: StudyData): void {
    const s = this.studies.get(id);
    if (!s || data.revision !== this._seriesRevision) return;
    s.study.setData(data);
    s.dataVersion++;
    this.invalidate(INVALIDATE_MAIN);
  }

  updateStudyData(id: string, patch: StudyDataPatch): void {
    const s = this.studies.get(id);
    if (!s?.study.patch(patch, this._seriesRevision)) return;
    s.dataVersion++;
    this.invalidate(INVALIDATE_MAIN);
  }

  setStudyVisible(id: string, visible: boolean): void {
    const s = this.studies.get(id);
    if (!s || s.study.spec.visible === visible) return;
    s.study.spec.visible = visible;
    this.invalidate(INVALIDATE_MAIN);
  }

  updateStudySpec(id: string, patch: Partial<Omit<StudySpec, 'id' | 'target'>>): void {
    const s = this.studies.get(id);
    if (!s) return;
    s.study.updateSpec(patch);
    this.invalidate(INVALIDATE_LAYOUT);
  }

  setStudyStyle(id: string, outputId: string, style: StudyOutputStylePatch): void {
    if (this.studies.get(id)?.study.setStyle(outputId, style)) this.invalidate(INVALIDATE_MAIN);
  }

  getStudyValues(id: string, index: number): StudyLegendValue[] {
    const s = this.studies.get(id);
    return s ? s.study.legendValues(index, this._seriesRevision, this.decimals) : [];
  }

  getLegendSlot(paneId: string, kind: LegendSlotKind = 'studies'): HTMLElement | null {
    const pane = this.panes.find((p) => p.id === paneId);
    if (!pane) return null;
    return kind === 'compare' ? pane.legendCompare : pane.legendSlot;
  }

  /** Decimals of the symbol's price format (study text labels). */
  get symbolDecimals(): number {
    return this.decimals;
  }

  /** Base value of the main pane's price series at displayed bar `i`: the
   * reference compare overlays ('same % scale') are rescaled to. */
  compareReference(i: number): number | null {
    return this.panes.find((p) => p.id === 'main')?.series[0]?.baseValue(i) ?? null;
  }

  /** True when `id` is a study on this chart. */
  isStudy(id: string | null | undefined): boolean {
    return !!id && this.studies.has(id);
  }

  /** Track the study under the pointer; emits studyHover on change. */
  hoverStudy(hit: HitTarget | null): void {
    const id = hit?.kind === 'pane' ? hit.seriesId : null;
    const next =
      hit?.kind === 'pane' && id && this.studies.has(id)
        ? { id, outputId: hit.outputId ?? null }
        : null;
    const prev = this.hoveredStudy;
    if (prev?.id === next?.id && prev?.outputId === next?.outputId) return;
    this.hoveredStudy = next;
    this.events.emit('studyHover', next ?? { id: null, outputId: null });
  }

  /** Emit a study click/double-click if `hit` is on a study. Returns whether it was. */
  emitStudyPointer(
    event: 'studyClick' | 'studyDoubleClick',
    hit: HitTarget,
    clientX: number,
    clientY: number,
  ): boolean {
    if (hit.kind !== 'pane' || !hit.seriesId || !this.isStudy(hit.seriesId)) return false;
    this.events.emit(event, { id: hit.seriesId, outputId: hit.outputId ?? null, clientX, clientY });
    return true;
  }

  private resolveStudyTarget(target: StudyTarget): Pane {
    if ('paneId' in target) {
      const pane = this.panes.find((p) => p.id === target.paneId);
      if (!pane) throw new Error(`Unknown pane: ${target.paneId}`);
      return pane;
    }
    const { id, ratio } = target.newPane;
    // Re-adding to an existing own pane (undo, layout restore) reuses it.
    const existing = id === undefined ? undefined : this.panes.find((p) => p.id === id);
    return existing ?? this.addPane(ratio ?? 1, id);
  }

  /** Take a study out of its pane; an emptied non-main pane is removed. */
  private detachStudy(s: StudySeries): void {
    const pane = this.panes.find((p) => p.id === s.study.paneId);
    if (!pane) return;
    const k = pane.series.indexOf(s);
    if (k >= 0) pane.series.splice(k, 1);
    if (pane.id !== 'main' && pane.series.length === 0 && this.dropPane(pane.id))
      this.events.emit('paneRemoved', { paneId: pane.id, studyIds: [] });
  }

  /** The study defining a non-main pane's axis format (its first series), if any. */
  private paneStudy(pane: Pane): StudySeries | null {
    const s0 = pane.series[0];
    return pane.id !== 'main' && s0 instanceof StudySeries ? s0 : null;
  }

  /**
   * New revision. `keep` (live brick rebuilds): leading displayed bars that
   * did not change; studies keep drawing their values there (no blank flash)
   * until the app sends data computed on the new series.
   */
  private emitSeriesReset(keep = 0): void {
    const prev = this._seriesRevision;
    this._seriesRevision++;
    if (keep > 0)
      for (const s of this.studies.values()) s.study.truncate(keep, prev, this._seriesRevision);
    this.emitSeriesChange({
      kind: 'reset',
      revision: this._seriesRevision,
      length: this.store.length,
    });
  }

  /** History prepend: new revision; studies keep drawing their data shifted
   * by `added` until the app sends values computed on the new series. */
  private emitSeriesPrepend(added: number): void {
    const prev = this._seriesRevision;
    this._seriesRevision++;
    for (const s of this.studies.values()) s.study.shift(added, prev, this._seriesRevision);
    this.emitSeriesChange({
      kind: 'prepend',
      revision: this._seriesRevision,
      length: this.store.length,
      added,
    });
  }

  private emitSeriesChange(change: SeriesChange): void {
    this.events.emit('seriesChange', change);
  }

  // --------------------------------------------------------------- drawings

  setActiveTool(type: string | null, opts?: DrawingToolOptions): void {
    this.drawingInput.setActiveTool(type, opts);
  }

  getActiveTool(): string | null {
    return this.drawingInput.activeTool;
  }

  /** The finished transient measurement's anchors (Measure tool / quick measure), or null. */
  getMeasure(): DrawingPoint[] | null {
    const m = this.drawingLayer.measure;
    return m ? m.points.map((p) => ({ ...p })) : null;
  }

  setDrawingOptions(patch: Partial<DrawingOptions>): void {
    this.drawingLayer.options = { ...this.drawingLayer.options, ...patch };
    if (this.drawingLayer.options.hideAll || this.drawingLayer.options.lockAll)
      this.drawingInput.abort();
    this.drawingLayer.pruneSelection();
    this.invalidate(INVALIDATE_OVERLAY);
  }

  getDrawingOptions(): DrawingOptions {
    return { ...this.drawingLayer.options };
  }

  addDrawing(input: DrawingInput): Drawing {
    const layer = this.drawingLayer;
    return cloneDrawing(layer.insert(layer.build(input)));
  }

  updateDrawing(id: string, patch: DrawingPatch): void {
    // An API edit wins over a gesture on the same drawing.
    if (this.drawingInput.busy && this.drawingLayer.editing.has(id)) this.drawingInput.abort();
    if (this.drawingLayer.update(id, patch)) this.drawingLayer.pruneSelection();
  }

  replaceDrawing(d: Drawing): void {
    if (this.drawingInput.busy && this.drawingLayer.editing.has(d.id)) this.drawingInput.abort();
    if (this.drawingLayer.replace(d)) this.drawingLayer.pruneSelection();
  }

  removeDrawings(ids: readonly string[]): void {
    this.drawingLayer.remove(ids);
  }

  getDrawingBounds(ids: readonly string[]): DrawingBounds | null {
    return this.drawingLayer.bounds(ids);
  }

  getDrawings(): Drawing[] {
    return this.drawingLayer.list().map(cloneDrawing);
  }

  getDrawing(id: string): Drawing | null {
    const d = this.drawingLayer.items.get(id);
    return d ? cloneDrawing(d) : null;
  }

  setDrawings(list: readonly Drawing[]): void {
    this.drawingInput.abort();
    this.drawingLayer.replaceAll(list);
  }

  selectDrawings(ids: readonly string[], opts: { add?: boolean } = {}): void {
    const layer = this.drawingLayer;
    layer.setSelection(opts.add ? [...layer.selection, ...ids] : ids);
  }

  getSelection(): string[] {
    return [...this.drawingLayer.selection];
  }

  selectAllDrawings(): void {
    const layer = this.drawingLayer;
    layer.setSelection(
      layer
        .list()
        .filter((d) => layer.isShown(d))
        .map((d) => d.id),
    );
  }

  copyDrawings(ids: readonly string[]): string {
    const want = new Set(ids);
    const clip: DrawingClipboard = {
      version: 1,
      drawings: this.drawingLayer
        .list()
        .filter((d) => want.has(d.id))
        .map(cloneDrawing),
    };
    return JSON.stringify(clip);
  }

  pasteDrawings(json: string, opts: DrawingPasteOptions = {}): Drawing[] {
    const layer = this.drawingLayer;
    const clip = JSON.parse(json) as Partial<DrawingClipboard> | null;
    if (!clip || clip.version !== 1 || !Array.isArray(clip.drawings))
      throw new Error('Not a drawings clipboard');
    const src = clip.drawings.filter(
      (d) => d && typeof d.type === 'string' && Array.isArray(d.points) && getDrawingTool(d.type),
    );
    if (!src.length) return [];
    this.drawingInput.abort();
    // Drawings from a pane this chart does not have (a study pane) land on the main pane.
    const paneOf = (d: Drawing) => (this.panes.some((p) => p.id === d.paneId) ? d.paneId : 'main');
    const tl = layer.refreshView().timeline;
    // `at`: the earliest anchor of the group lands on at.time (bars) / at.price.
    let dl = opts.offset ?? 0;
    let dp = 0;
    let refPane: string | null = null;
    if (opts.at && tl.length) {
      let first: { l: number; price: number; pane: string } | null = null;
      // Pane-coordinate drawings stay where they were on screen (no offset/at).
      for (const d of src.filter((d) => !isPaneCoords(d.type)))
        for (const p of d.points) {
          const l = timeToLogical(tl, p);
          if (Number.isFinite(l) && (!first || l < first.l))
            first = { l, price: p.price, pane: paneOf(d) };
        }
      if (first) {
        dl += Math.round(timeToLogical(tl, opts.at) - first.l);
        dp = opts.at.price - first.price;
        refPane = first.pane;
      }
    }
    const out: Drawing[] = [];
    let z = layer.topZ();
    for (const d of src) {
      const fixed = isPaneCoords(d.type);
      const points = d.points.map((p) => {
        let q = { ...p };
        if (fixed) return q;
        if (dl && tl.length) {
          const t = logicalToTime(tl, timeToLogical(tl, p) + dl);
          if (t) q = withTime(q, t);
        }
        if (dp && paneOf(d) === refPane) q.price += dp;
        return q;
      });
      const { id: _id, ...rest } = d;
      const pasted = layer.build({
        ...rest,
        paneId: paneOf(d),
        points,
        zIndex: ++z,
        symbol: d.scope === 'all' ? d.symbol : this.symbol,
      });
      out.push(layer.insert(pasted));
    }
    for (const d of out) this.events.emit('drawingCreated', { drawing: cloneDrawing(d) });
    layer.setSelection(out.map((d) => d.id));
    return out.map(cloneDrawing);
  }

  bringToFront(ids: readonly string[]): DrawingChange[] {
    return this.drawingLayer.reorder(ids, 'front');
  }

  sendToBack(ids: readonly string[]): DrawingChange[] {
    return this.drawingLayer.reorder(ids, 'back');
  }

  bringForward(ids: readonly string[]): DrawingChange[] {
    return this.drawingLayer.reorder(ids, 'forward');
  }

  sendBackward(ids: readonly string[]): DrawingChange[] {
    return this.drawingLayer.reorder(ids, 'backward');
  }

  /** Drawing target of a hit (for the drawing state machine), or null off-pane. */
  drawingTarget(hit: HitTarget): DrawingPointerTarget | null {
    return hit.kind === 'pane' ? { pane: hit.pane, drawing: hit.drawing ?? null } : null;
  }

  /** `formatInterval(this.interval)`, cached per interval object (assignments
   * replace it), so per-drawing visibility checks do not allocate. */
  private intervalString(): string {
    const c = this.intervalCache;
    if (c.iv !== this.interval) {
      c.iv = this.interval;
      c.str = formatInterval(this.interval);
    }
    return c.str;
  }

  private createDrawingHost(): DrawingHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const chart = this;
    return {
      get timeScale() {
        return chart.timeScale;
      },
      get theme() {
        return chart.theme;
      },
      get paneWidth() {
        return chart.paneWidth;
      },
      get symbol() {
        return chart.symbol;
      },
      get interval() {
        return chart.intervalString();
      },
      get magnet() {
        return chart.options.magnet;
      },
      magnetValues: (paneId, index) => this.drawingMagnetValues(paneId, index),
      timeline: () => this.refreshTimeline(),
      bars: () => this.store,
      pane: (id) => this.panes.find((p) => p.id === id) ?? null,
      format: (paneId) => this.drawingFormat(paneId),
      invalidate: () => this.invalidate(INVALIDATE_OVERLAY),
      zoomTo: (paneId, from, to, minPrice, maxPrice) => {
        this.setVisibleLogicalRange(from, to);
        const ps = this.panes.find((p) => p.id === paneId)?.priceScale;
        if (ps && minPrice !== undefined && maxPrice !== undefined) {
          ps.setManualRange(minPrice, maxPrice);
          this.invalidate(INVALIDATE_MAIN);
          this.emitState();
        }
      },
      // ChartEvents extends DrawingEvents, so this view of the emitter is exact.
      emit: (event, payload) =>
        (this.events as unknown as Emitter<DrawingEvents>).emit(event, payload),
    };
  }

  /** Drawing magnet targets at displayed bar `index`: OHLC of the displayed
   * series (bricks on brick types) on 'main', series values on other panes. */
  private drawingMagnetValues(paneId: string, index: number): number[] {
    if (paneId === 'main') {
      const s = this.store;
      if (index < 0 || index >= s.length) return [];
      return [s.open[index]!, s.high[index]!, s.low[index]!, s.close[index]!];
    }
    const pane = this.panes.find((p) => p.id === paneId);
    return pane ? pane.series.flatMap((s) => s.valuesAt(index)) : [];
  }

  /**
   * The displayed series as drawings map anchors (bricks on brick types,
   * session-aware future slots): use with `timeToLogical`/`logicalToTime` for
   * bar numbers that match the chart (additive API). A new object each call,
   * but `time` is the chart's live time column, not a copy (O(1), fine per
   * frame): treat it as read-only and valid while `seriesRevision` is
   * unchanged (appends add bars past `length`; resets and history prepends
   * bump the revision). Call again after a change instead of keeping it.
   */
  getAnchorTimeline(): AnchorTimeline {
    return { ...this.refreshTimeline() };
  }

  /** The displayed series as an anchor timeline (one reused object). */
  private refreshTimeline(): AnchorTimeline {
    const tl = this.timeline;
    const s = this.store;
    tl.time = s.time;
    tl.length = s.length;
    tl.interval = this.interval;
    tl.bricks = BRICK_TYPES.has(this._chartType);
    tl.endTime = this.raw.length ? this.raw.time[this.raw.length - 1]! : NaN;
    tl.calendar = this.tradingCalendar();
    return tl;
  }

  /**
   * Trading calendar of the raw bars (exchange timezone). Built once per load
   * (symbol, interval, extended hours) and history prepend, not per live bar,
   * so anchors past the last bar keep their slots as bars arrive. The regular
   * session shapes the day unless extended hours are shown.
   */
  private tradingCalendar(): TradingCalendar | null {
    const r = this.raw;
    const n = r.length;
    const tz = this.symbolInfo?.timezone ?? 'UTC';
    const session = this.options.prepost ? null : (this.symbolInfo?.session ?? null);
    const key = n ? `${this.rawEpoch}|${this.intervalString()}|${tz}|${session ?? ''}` : '';
    if (key !== this.calendarKey) {
      this.calendarKey = key;
      this.timeline.calendar = n
        ? buildTradingCalendar(r.time, n, this.interval, tz, session)
        : null;
    }
    return this.timeline.calendar;
  }

  private drawingFormat(paneId: string): DrawingFormat {
    let f = this.drawingFormats.get(paneId);
    if (!f) {
      f = {
        price: (v) => {
          const pane = this.panes.find((p) => p.id === paneId);
          return pane ? this.formatValue(pane, v) : formatPrice(v, this.decimals);
        },
        percent: (v) => formatPercent(v),
        time: (t) => formatCrosshairTime(t, this.interval.unit, this.tz, this.options.locale),
      };
      this.drawingFormats.set(paneId, f);
    }
    return f;
  }

  /** A value in the pane's own units (price for main), ignoring percent/indexed display. */
  private formatValue(pane: Pane, v: number): string {
    const st = this.paneStudy(pane)?.study.spec;
    if (st) return formatStudyValue(v, st.format, st.precision, pane.labelDecimals + 1);
    return pane.id === 'main'
      ? formatPrice(v, this.decimals)
      : formatAxisNumber(v, pane.labelDecimals + 1);
  }

  // ------------------------------------------------------------ chart types

  /** Displayed bars (transformed for Heikin Ashi / brick types). */
  get store(): SeriesStore {
    return this.usesTransform ? this.derived : this.raw;
  }

  get view(): SeriesStore {
    return this.store;
  }

  get chartType(): ChartType {
    return this._chartType;
  }

  get chartStyle(): ChartStyle {
    return this._chartStyle;
  }

  get transformExtra(): TransformExtra {
    return this._extra;
  }

  /** For transformed views, the raw (time) bar index behind displayed bar i. */
  sourceIndexOf(i: number): number {
    return this.sourceIndex ? (this.sourceIndex[i] ?? -1) : i;
  }

  private get usesTransform(): boolean {
    return this._chartType === 'heikinAshi' || BRICK_TYPES.has(this._chartType);
  }

  setChartType(type: ChartType): void {
    if (type === this._chartType) return;
    const wasBrick = BRICK_TYPES.has(this._chartType);
    const wasTransform = this.usesTransform;
    this._chartType = type;
    this.brickSize = null;
    this.rebuildView();
    this.recomputeWeights();
    // Brick indices have no relation to time bars: start from the latest brick.
    if (wasBrick || BRICK_TYPES.has(type)) this.resetBrickView();
    else this.timeScale.baseIndex = this.store.length - 1;
    this.crosshair = null;
    for (const p of this.panes) p.priceScale.autoScale = true;
    this.invalidate(INVALIDATE_LAYOUT);
    // Plain types share the raw store, so indices only change through a transform.
    if (wasTransform || this.usesTransform) this.emitSeriesReset();
    this.emitViewChange('data');
    this.emitState();
  }

  /** Override parts of the per-type styles (merged over theme defaults). */
  setChartStyle(overrides: DeepPartial<ChartStyle>): void {
    const brickBefore = JSON.stringify(this.brickParams());
    this.styleOverrides = overrides;
    this._chartStyle = mergeDeep(defaultChartStyle(this.options.theme), overrides);
    if (JSON.stringify(this.brickParams()) !== brickBefore) {
      this.brickSize = null;
      this.rebuildView();
      this.recomputeWeights();
      this.resetBrickView();
      if (this.usesTransform) this.emitSeriesReset();
      this.emitViewChange('data');
    }
    this.invalidate(INVALIDATE_MAIN);
  }

  getVolumeMode(): VolumeMode {
    return this.volumeMode;
  }

  setVolumeMode(mode: VolumeMode, force = false): void {
    if (mode === this.volumeMode && !force) return;
    this.volumeMode = mode;
    const main = this.panes[0]!;
    const idx = main.series.indexOf(this.volumeOverlay);
    if (idx >= 0) main.series.splice(idx, 1);
    const volPane = this.panes.find((p) => p.id === 'volume');
    if (volPane?.series.some((s) => s instanceof StudySeries)) {
      // Keep a volume pane that also holds studies; drop only the volume series.
      const k = volPane.series.findIndex((s) => s.id === 'volume-pane');
      if (k >= 0) volPane.series.splice(k, 1);
    } else this.removePane('volume');
    if (mode === 'overlay') main.series.push(this.volumeOverlay);
    else if (mode === 'pane') {
      const pane = this.panes.find((p) => p.id === 'volume') ?? this.addPane(1, 'volume');
      pane.series.unshift(new VolumeSeries('volume-pane', this, false));
    }
    this.invalidate(INVALIDATE_LAYOUT);
    this.emitState();
  }

  /** Start at the latest bar; sparse brick series (few bars) fill the width. */
  private resetBrickView(): void {
    const n = this.store.length;
    const ts = this.timeScale;
    ts.reset(n - 1);
    if (BRICK_TYPES.has(this._chartType) && n > 0 && n * ts.barSpacing < ts.width * 0.8)
      ts.fitRange(0, n - 1);
  }

  private brickParams(): unknown {
    const t = this._chartType;
    return BRICK_TYPES.has(t) ? this._chartStyle[t] : null;
  }

  /** Resolve an ATR-or-fixed size option to a price amount. */
  private resolveSize(mode: string, fixed: number, atrLength: number): number {
    if (mode !== 'atr') return fixed;
    const size =
      this.brickSize ?? roundBoxSize(lastAtr(this.raw, atrLength), this.symbolInfo?.minTick);
    this.brickSize = size;
    return size;
  }

  /** Recompute the displayed series from raw bars for the active chart type. */
  private rebuildView(): void {
    const t = this._chartType;
    const st = this._chartStyle;
    this._extra = {};
    this.sourceIndex = null;
    if (!this.usesTransform || !this.raw.length) {
      if (this.usesTransform) this.derived.clear();
      return;
    }
    if (t === 'heikinAshi') {
      this.derived.setFrom(heikinAshi(this.raw));
      return;
    }
    let res;
    switch (t) {
      case 'renko': {
        const o = st.renko;
        res = renko(this.raw, {
          boxSize: this.resolveSize(o.boxSizeMode, o.boxSize, o.atrLength),
          source: o.source,
          wicks: o.wicks,
        });
        break;
      }
      case 'lineBreak':
        res = lineBreak(this.raw, { lines: st.lineBreak.lines });
        break;
      case 'kagi': {
        const o = st.kagi;
        const percent = o.reversalMode === 'percent';
        res = kagi(this.raw, {
          reversal: percent
            ? o.reversal
            : this.resolveSize(o.reversalMode, o.reversal, o.atrLength),
          reversalMode: percent ? 'percent' : 'fixed',
          source: o.source,
        });
        break;
      }
      case 'pointFigure': {
        const o = st.pointFigure;
        res = pointFigure(this.raw, {
          boxSize: this.resolveSize(o.boxSizeMode, o.boxSize, o.atrLength),
          reversal: o.reversal,
          source: o.source,
        });
        break;
      }
      default: {
        const o = st.range;
        res = rangeBars(this.raw, {
          range: this.resolveSize(o.rangeMode, o.range, o.atrLength),
          tick: this.symbolInfo?.minTick ?? 0,
        });
      }
    }
    this.derived.setFrom(res.bars);
    this.sourceIndex = res.sourceIndex;
    this._extra = res.extra;
  }

  /** Back to the latest bar with default zoom and auto-scale. */
  resetView(): void {
    this.timeScale.barSpacing = DEFAULT_BAR_SPACING;
    this.timeScale.reset(this.store.length - 1);
    for (const p of this.panes) p.priceScale.autoScale = true;
    this.invalidate(INVALIDATE_MAIN);
    this.emitViewChange('api');
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
    this.viewChanged('api');
    this.emitState();
  }

  /** Show logical bar indices [from, to] (fractional, may extend past the data)
   * across the pane width; the inverse of the visible logical span. Price scales
   * are left alone. Ignored unless both are finite and from < to. */
  setVisibleLogicalRange(from: number, to: number): void {
    if (!this.timeScale.setVisibleLogicalRange(from, to)) return;
    this.viewChanged('api');
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
    this.viewChanged('api');
    this.emitState();
  }

  /**
   * Times (unix s) of the first and last bar slots (at least partly) visible at
   * the pane edges; past the last bar these are future slots (session-aware).
   * The `to` slot is the one `setRightEdgeTime` puts at the right edge. Null
   * without bars.
   */
  getVisibleTimeRange(): { from: number; to: number } | null {
    const tl = this.refreshTimeline();
    if (!tl.length || this.timeScale.width <= 0) return null;
    const { from, to } = this.timeScale.logicalRange();
    // Slot k spans logical [k - 0.5, k + 0.5); an edge exactly on a boundary
    // belongs to the slot inside the pane.
    const a = logicalToTime(tl, Math.floor(from + 0.5 + EDGE_EPS));
    const b = logicalToTime(tl, Math.ceil(to - 0.5 - EDGE_EPS));
    return a && b ? { from: a.time, to: b.time } : null;
  }

  /**
   * Scroll so the bar slot at `time` (unix s, may be in the future) ends at the
   * right pane edge, loading history as needed. Bar spacing is kept. Emits
   * `viewChange` with cause 'api'.
   */
  async setRightEdgeTime(time: number): Promise<void> {
    await this.whenLoaded();
    await this.ensureHistory(time);
    if (!this.store.length || !Number.isFinite(time)) return;
    const l = timeToLogical(this.refreshTimeline(), { time });
    if (!Number.isFinite(l)) return;
    const ts = this.timeScale;
    // Right edge of slot l at x = width (see TimeScale.indexToX).
    ts.rightOffset = l - ts.baseIndex;
    ts.clamp();
    this.viewChanged('api');
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
    if (hit.kind === 'pane') {
      base.seriesId = hit.seriesId;
      base.drawingId = hit.drawing?.id ?? null;
    }
    return base;
  }

  scrollToRealtime(): void {
    this.timeScale.reset(this.store.length - 1);
    this.invalidate(INVALIDATE_MAIN);
    this.emitViewChange('api');
  }

  getState(): ChartState {
    return {
      version: 1,
      symbol: this.symbol,
      interval: formatInterval(this.interval),
      chartType: this._chartType,
      volume: this.volumeMode,
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
    // Studies are re-added by the app after setState (it persists its own list;
    // studiesCleared below tells it when).
    const cleared = [...this.studies.keys()];
    for (const s of this.studies.values()) {
      const pane = this.panes.find((p) => p.id === s.study.paneId);
      const k = pane ? pane.series.indexOf(s) : -1;
      if (k >= 0) pane?.series.splice(k, 1);
    }
    this.studies.clear();
    this.hoverStudy(null);
    // Recreate extra panes to match the saved list (main pane always first).
    for (const p of this.panes.slice(1)) this.dropPane(p.id);
    for (const ps of state.panes) {
      if (ps.id === 'volume') continue; // recreated by setVolumeMode below
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
    if (state.chartType) this.setChartType(state.chartType);
    if (state.volume) this.setVolumeMode(state.volume, true);
    this.maximized = this.panes.find((p) => p.id === state.maximizedPane) ?? null;
    if (cleared.length) this.events.emit('studiesCleared', { ids: cleared });
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
    if (x >= this.paneWidth) {
      const axisX = x - this.paneWidth;
      const plus = this.plusRect(pane);
      const inPlus =
        plus !== null &&
        axisX >= 1 &&
        axisX < 1 + PLUS_WIDTH &&
        py >= plus.top &&
        py < plus.top + AXIS_LABEL_HEIGHT;
      if (inPlus) return { kind: 'priceAxis', pane, y: py, plus: true };
      const line = hitPriceLine(this.placedLines(pane), x, py, this.paneWidth, pane.height);
      return {
        kind: 'priceAxis',
        pane,
        y: py,
        ...(line ? { priceLine: { group: line.group, id: line.line.id } } : {}),
      };
    }
    const s = this.hitSeries(pane, x, py);
    const marker = pane.id === 'main' ? hitMarker(this.placedMarkers(), x, py) : null;
    const line = marker
      ? null
      : hitPriceLine(this.placedLines(pane), x, py, this.paneWidth, pane.height);
    return {
      kind: 'pane',
      pane,
      x,
      y: py,
      seriesId: s.id,
      outputId: s.outputId,
      ...(s.fill ? { fill: true } : {}),
      ...(s.drawing ? { drawing: s.drawing } : {}),
      ...(marker ? { marker: { group: marker.group, id: marker.marker.id } } : {}),
      ...(line ? { priceLine: { group: line.group, id: line.line.id } } : {}),
    };
  }

  // ------------------------------------------------- markers, lines, "+" button

  /**
   * Replaces the markers of `group` (`[]` clears it). Markers are time-based
   * (mapped through the time scale, so they follow interval changes), culled to
   * the visible range, drawn on the main pane, and not part of `getState()`.
   */
  setMarkers(group: string, markers: readonly ChartMarker[]): void {
    if (markers.length)
      this.markerGroups.set(
        group,
        markers.map((m) => ({ ...m })),
      );
    else this.markerGroups.delete(group);
    this.invalidate(INVALIDATE_OVERLAY);
  }

  /** Replaces the price lines of `group` (`[]` clears it). Not part of `getState()`. */
  setPriceLines(group: string, lines: readonly ChartPriceLine[]): void {
    if (lines.length)
      this.lineGroups.set(
        group,
        lines.map((l) => ({ ...l })),
      );
    else this.lineGroups.delete(group);
    this.invalidate(INVALIDATE_OVERLAY);
  }

  /** Pointer position over a price axis (null: left it). Called by the controller. */
  setAxisHover(pane: Pane | null, y: number): void {
    const prev = this.axisHover;
    if (!pane || !this.store.length || !this.options.priceAxisPlusButton) {
      if (prev) {
        this.axisHover = null;
        this.invalidate(INVALIDATE_OVERLAY);
      }
      return;
    }
    if (prev && prev.pane === pane && prev.y === y) return;
    this.axisHover = { pane, y };
    this.invalidate(INVALIDATE_OVERLAY);
  }

  /** Emits `priceAxisPlus` for the price under the current label of `pane`. */
  firePriceAxisPlus(pane: Pane): void {
    const r = this.plusRect(pane);
    if (!r) return;
    this.events.emit('priceAxisPlus', { paneId: pane.id, price: pane.priceScale.yToPrice(r.y) });
  }

  /** Emits `markerClick` / `priceLineClick` for a click on `hit`. Returns whether one fired. */
  emitOverlayClick(hit: HitTarget): boolean {
    if (hit.kind === 'pane' && hit.marker) {
      this.events.emit('markerClick', hit.marker);
      return true;
    }
    if ((hit.kind === 'pane' || hit.kind === 'priceAxis') && hit.priceLine) {
      this.events.emit('priceLineClick', hit.priceLine);
      return true;
    }
    return false;
  }

  /** Where the price label sits on `pane` (crosshair, else axis hover): raw y and clamped box top. */
  private plusRect(pane: Pane): { y: number; top: number } | null {
    if (!this.options.priceAxisPlusButton || !this.store.length) return null;
    const c = this.crosshair;
    const y = c && c.pane === pane ? c.y : this.axisHover?.pane === pane ? this.axisHover.y : null;
    if (y === null) return null;
    return {
      y,
      top: Math.max(0, Math.min(pane.height - AXIS_LABEL_HEIGHT, y - AXIS_LABEL_HEIGHT / 2)),
    };
  }

  private placedMarkers(): PlacedMarker[] {
    if (!this.markerGroups.size) return [];
    const main = this.panes[0];
    if (!main || main.height <= 0) return [];
    const s = this.store;
    return layoutMarkers(this.markerGroups, {
      timeline: this.refreshTimeline(),
      high: s.high,
      low: s.low,
      indexToX: (i) => this.timeScale.indexToX(i),
      priceToY: (p) => main.priceScale.priceToY(p),
      paneWidth: this.paneWidth,
      paneHeight: main.height,
    });
  }

  private placedLines(pane: Pane): PlacedPriceLine[] {
    if (!this.lineGroups.size) return [];
    return layoutPriceLines(this.lineGroups, pane.id, pane.height, (p) =>
      pane.priceScale.priceToY(p),
    );
  }

  /** Topmost object under (x, y), in this order: drawings (handles, strokes,
   * strong parts), lines/marks/bars of every series, weak drawing parts
   * (background fills), marks of background ('none') studies, study fill interiors. */
  private hitSeries(
    pane: Pane,
    x: number,
    y: number,
  ): { id: string | null; outputId: string | null; fill: boolean; drawing?: DrawingHit } {
    const dh = this.drawingLayer.hitTest(pane, x, y);
    if (dh.strong) return { id: null, outputId: null, fill: false, drawing: dh.strong };
    const i = this.timeScale.xToIndex(x);
    const ps = pane.priceScale;
    const price = ps.yToPrice(y);
    const tol = Math.abs(ps.yToPrice(y - 4) - price);
    for (let k = pane.series.length - 1; k >= 0; k--) {
      const s = pane.series[k]!;
      if (s instanceof StudySeries) {
        if (s.behind) continue; // background overlay: tested below
        const out = s.hitTestPx(x, y, 'marks');
        if (out !== null) return { id: s.id, outputId: out, fill: false };
      } else if (s.hitTest(i, price, tol)) return { id: s.id, outputId: null, fill: false };
    }
    if (dh.weak) return { id: null, outputId: null, fill: false, drawing: dh.weak };
    // Own-scale studies (e.g. Volume at the bottom of the price pane) are drawn
    // behind the price series and drawings, so those win where they overlap.
    for (let k = pane.series.length - 1; k >= 0; k--) {
      const s = pane.series[k]!;
      if (!(s instanceof StudySeries) || !s.behind) continue;
      const out = s.hitTestPx(x, y, 'marks');
      if (out !== null) return { id: s.id, outputId: out, fill: false };
    }
    for (let k = pane.series.length - 1; k >= 0; k--) {
      const s = pane.series[k]!;
      if (!(s instanceof StudySeries)) continue;
      const out = s.hitTestPx(x, y, 'fills');
      if (out !== null) return { id: s.id, outputId: out, fill: true };
    }
    return { id: null, outputId: null, fill: false };
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
    this.crosshair = {
      pane,
      x: snappedX,
      y: this.magnetY(pane, index, y),
      index,
      rawX: x,
      rawY: y,
    };
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

  /** Called by the controller after any view change (and by view API calls with 'api'). */
  viewChanged(cause: ViewChangeCause): void {
    this.invalidate(INVALIDATE_MAIN);
    if (this.crosshair)
      this.setCrosshair(this.crosshair.pane, this.crosshair.x, this.crosshair.rawY);
    this.emitViewChange(cause);
  }

  private emitViewChange(cause: ViewChangeCause): void {
    if (this.synced) this.synced.key = '';
    this.events.emit('viewChange', { cause });
  }

  /**
   * Show (or with null, clear) a crosshair mirrored from another chart: a
   * vertical line at the bar matching `p.time` (see `mapSyncTime`), plus a
   * horizontal line and price label when `p.price` is not null. Drawn only
   * while this chart has no crosshair of its own; never emits `crosshairMove`.
   * Throws on an invalid `p.interval`.
   */
  setSyncedCrosshair(p: SyncedCrosshair | null): void {
    if (!p) {
      if (!this.synced) return;
      this.synced = null;
      this.invalidate(INVALIDATE_OVERLAY);
      return;
    }
    const ref: SyncTimeRef = {
      time: p.time,
      interval: parseInterval(p.interval),
      timezone: p.timezone,
    };
    const price = p.price !== null && Number.isFinite(p.price) ? p.price : null;
    this.synced = { ref, price, logical: NaN, key: '' };
    this.invalidate(INVALIDATE_OVERLAY);
  }

  /** Logical index of the synced crosshair (NaN: none), recomputed when bars or the view change. */
  private syncedIndex(): number {
    const s = this.synced;
    if (!s) return NaN;
    const key = `${this._seriesRevision}|${this.rawEpoch}|${this.store.length}|${this._chartType}`;
    if (s.key !== key) {
      s.key = key;
      s.logical = mapSyncTime(s.ref, this.refreshTimeline(), this.symbolInfo?.timezone ?? null);
    }
    return s.logical;
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
    // Symbol/interval changed: drawings shown there may differ (scope, visibility).
    if (this.drawingInput.busy) this.drawingInput.abort();
    this.drawingLayer.measure = null;
    this.drawingLayer.pruneSelection();
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
      this.raw.setAll(res.bars);
      this.rawEpoch++;
      this.brickSize = null;
      this.rebuildView();
      this.hasMore = res.hasMore;
      this.recomputeWeights();
      this.resetBrickView();
      for (const p of this.panes) p.priceScale.autoScale = true;
      this.crosshair = null;
      this.setStatus(this.store.length ? null : 'No data');
      this.subscribeLive(gen);
      this.invalidate(INVALIDATE_LAYOUT);
      this.emitSeriesReset();
      this.events.emit('dataLoaded', {
        symbol,
        interval: formatInterval(interval),
        bars: this.store.length,
      });
      this.emitViewChange('data');
      this.emitState();
    } catch (err) {
      if (gen !== this.loadGen) return;
      const message = err instanceof Error ? err.message : String(err);
      this.raw.clear();
      this.rebuildView();
      this.setStatus(message);
      this.invalidate(INVALIDATE_LAYOUT);
      this.emitSeriesReset();
      this.emitViewChange('data');
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
        adjusted: this.options.adjusted,
      },
      this.raw.last(),
      (bar) => {
        if (gen !== this.loadGen) return;
        const lengthBefore = this.store.length;
        const r = this.raw.upsert(bar);
        if (r === 'ignored') return;
        // Brick views can change more than their tail: compare with a snapshot.
        const snapshot: SeriesSnapshot | null = BRICK_TYPES.has(this._chartType)
          ? snapshotSeries(this.derived)
          : null;
        if (this.usesTransform) {
          const before = this.store.length;
          this.rebuildView();
          const added = this.store.length - before;
          for (let k = 0; k < added; k++) this.timeScale.onAppend();
          if (added) this.recomputeWeights();
        } else if (r === 'append') {
          this.timeScale.onAppend();
          this.recomputeWeights();
        }
        this.invalidate(INVALIDATE_MAIN);
        // Plain and Heikin Ashi views change exactly like the raw bar.
        const tail = snapshot
          ? diffTail(snapshot, this.derived)
          : [{ kind: r, index: this.store.length - 1 }];
        if (!tail) this.emitSeriesReset(snapshot ? commonPrefix(snapshot, this.derived) : 0);
        else
          for (const c of tail)
            this.emitSeriesChange({ kind: c.kind, revision: this._seriesRevision, index: c.index });
        if (this.crosshair) this.emitCrosshair();
        if (this.store.length !== lengthBefore) this.emitViewChange('data');
        this.events.emit('barUpdate', bar);
      },
    );
  }

  private loadMorePromise: Promise<number> | null = null;

  /** Load one older page. Concurrent callers share the in-flight request.
   * Resolves to the number of bars prepended. */
  private loadMore(): Promise<number> {
    if (this.loadMorePromise) return this.loadMorePromise;
    if (!this.hasMore || !this.raw.length) return Promise.resolve(0);
    this.loadingMore = true;
    const gen = this.loadGen;
    this.loadMorePromise = (async () => {
      try {
        const res = await this.feed.getBars({
          symbol: this.symbol,
          interval: this.interval,
          to: this.raw.time[0]!,
          limit: this.options.pageSize,
          prepost: this.options.prepost,
          adjusted: this.options.adjusted,
        });
        if (gen !== this.loadGen) return 0;
        const before = this.store.length;
        const n = this.raw.prepend(res.bars);
        if (n > 0) this.rawEpoch++;
        this.hasMore = res.hasMore && n > 0;
        if (n > 0) {
          this.rebuildView();
          const added = this.store.length - before;
          this.timeScale.onPrepend(added);
          if (this.crosshair) this.crosshair.index += added;
          this.recomputeWeights();
          this.invalidate(INVALIDATE_MAIN);
          // Brick views are rebuilt from the first bar, so they can differ anywhere.
          if (BRICK_TYPES.has(this._chartType) || added <= 0) this.emitSeriesReset();
          else this.emitSeriesPrepend(added);
          this.emitViewChange('data');
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
    while (gen === this.loadGen && this.hasMore && this.raw.length && this.raw.time[0]! > time) {
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

  /** Axis label of a study's last value: the study's own value on own-scale
   * studies and linear/log panes, else in the pane's units (percent/indexed). */
  private studyLabelText(pane: Pane, s: StudySeries, lv: StudyLastValue): string {
    const mode = pane.priceScale.mode;
    if (lv.y === undefined && mode !== 'linear' && mode !== 'log')
      return this.formatAxisValue(pane, lv.price);
    const { format, precision } = s.study.spec;
    return formatStudyValue(lv.raw, format, precision, this.decimals);
  }

  private formatAxisValue(pane: Pane, price: number): string {
    const ps = pane.priceScale;
    if (ps.mode === 'percent') return formatPercent(ps.toDisplay(price)).replace('+', '');
    if (ps.mode === 'indexed') return formatPrice(ps.toDisplay(price), 2);
    const st = this.paneStudy(pane)?.study.spec;
    if (st && (st.format === 'volume' || st.format === 'percent' || st.precision !== null))
      return formatStudyValue(price, st.format, st.precision, pane.labelDecimals + 1);
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
      if (pane.id === 'main' && from <= to) this.shadeExtendedHours(dev, from, to, pane.height);

      // Series.
      pane.main.begin();
      const ctx = pane.main.device();
      if (from <= to) {
        // Background overlays (volume) go behind the price series.
        const ordered = [...pane.series].sort((a, b) => Number(!!b.behind) - Number(!!a.behind));
        for (const s of ordered) {
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
      const prevClose = pane.id === 'main' ? this.prevDayClose() : null;
      if (prevClose !== null) {
        const c = pane.main.css();
        c.strokeStyle = t.prevClose;
        const y = ps.priceToY(prevClose);
        dashedLine(c, 0, y, paneW, y, this.dpr, [6, 4]);
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
    const st = this.paneStudy(pane)?.study.spec;
    const text = st ? formatStudyTick(value, st.format, pane.labelDecimals) : null;
    if (text !== null) return text;
    return pane.id === 'main'
      ? formatPrice(value, this.decimals)
      : formatAxisNumber(value, pane.labelDecimals);
  }

  /** Crosshair-style price label at pane-relative `y`, with the "+" box when `plus` (default: enabled). */
  private drawPriceLabel(
    ax: CanvasRenderingContext2D,
    pane: Pane,
    y: number,
    fontStr: string,
    plus = this.options.priceAxisPlusButton,
  ): void {
    const t = this.theme;
    const top = Math.max(0, Math.min(pane.height - AXIS_LABEL_HEIGHT, y - AXIS_LABEL_HEIGHT / 2));
    labelBox(
      ax,
      this.formatAxisValue(pane, pane.priceScale.yToPrice(y)),
      1,
      top,
      this.axisWidth - 2,
      AXIS_LABEL_HEIGHT,
      t.crosshairLabelBg,
      t.crosshairLabelText,
      fontStr,
      'left',
      plus ? PLUS_WIDTH + 4 : 6,
    );
    if (!plus) return;
    const cx = 1 + PLUS_WIDTH / 2;
    const cy = top + AXIS_LABEL_HEIGHT / 2;
    ax.fillStyle = t.crosshairLabelText;
    ax.globalAlpha = 0.18;
    ax.fillRect(1, top, PLUS_WIDTH, AXIS_LABEL_HEIGHT);
    ax.globalAlpha = 1;
    ax.fillRect(cx - 4, cy - 0.5, 8, 1);
    ax.fillRect(cx - 0.5, cy - 4, 1, 8);
  }

  private renderOverlay(): void {
    const t = this.theme;
    const c = this.crosshair;
    const fontStr = font(t);
    const paneW = this.paneWidth;
    // Mirrored crosshair from another chart, only while this chart has none.
    let syncIndex = c ? NaN : this.syncedIndex();
    const syncX = this.timeScale.indexToX(syncIndex);
    if (!(syncX >= 0 && syncX <= paneW)) syncIndex = NaN;
    const syncPrice = this.synced?.price ?? null;

    for (const pane of this.panes) {
      if (pane.height <= 0) continue;
      const ctx = pane.overlay.begin();
      const ax = pane.axisOverlay.begin();
      const ps = pane.priceScale;
      this.drawingLayer.render(pane, ctx, this.dpr);
      const lines = this.placedLines(pane);
      if (lines.length) drawPriceLines(ctx, lines, paneW, this.dpr, fontStr);
      if (pane.id === 'main') {
        const placed = this.placedMarkers();
        if (placed.length) {
          drawMarkers(ctx, placed);
          const hov = c && c.pane === pane ? hitMarker(placed, c.rawX, c.rawY) : null;
          if (hov) drawMarkerTooltip(ctx, hov, t, paneW);
        }
      }

      // Study last values (below the series' own label).
      for (const s of pane.series) {
        if (!(s instanceof StudySeries)) continue;
        for (const lv of s.lastValues()) {
          const y = lv.y ?? ps.priceToY(lv.price);
          if (y < 0 || y > pane.height) continue;
          const top = Math.max(
            0,
            Math.min(pane.height - AXIS_LABEL_HEIGHT, y - AXIS_LABEL_HEIGHT / 2),
          );
          const text = this.studyLabelText(pane, s, lv);
          labelBox(
            ax,
            text,
            1,
            top,
            this.axisWidth - 2,
            AXIS_LABEL_HEIGHT,
            lv.color,
            '#ffffff',
            fontStr,
          );
        }
      }

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

      const prevClose = pane.id === 'main' ? this.prevDayClose() : null;
      if (prevClose !== null) {
        const y = ps.priceToY(prevClose);
        if (y >= 0 && y <= pane.height) {
          const top = Math.max(
            0,
            Math.min(pane.height - AXIS_LABEL_HEIGHT, y - AXIS_LABEL_HEIGHT / 2),
          );
          labelBox(
            ax,
            this.formatAxisValue(pane, prevClose),
            1,
            top,
            this.axisWidth - 2,
            AXIS_LABEL_HEIGHT,
            t.prevClose,
            '#ffffff',
            fontStr,
          );
        }
      }

      // Drawing price labels (above last-value labels, below the crosshair label).
      const labels = this.axisLabelBuf;
      labels.length = 0;
      this.drawingLayer.axisLabels('price', pane, labels);
      for (const l of labels) {
        const y = ps.priceToY(l.value);
        if (!(y >= 0 && y <= pane.height)) continue;
        const top = Math.max(
          0,
          Math.min(pane.height - AXIS_LABEL_HEIGHT, y - AXIS_LABEL_HEIGHT / 2),
        );
        labelBox(
          ax,
          this.formatAxisValue(pane, l.value),
          1,
          top,
          this.axisWidth - 2,
          AXIS_LABEL_HEIGHT,
          l.color,
          l.textColor ?? '#ffffff',
          fontStr,
        );
      }

      if (lines.length) {
        drawPriceLineAxisLabels(
          ax,
          lines,
          this.axisWidth,
          pane.height,
          (p) => this.formatAxisValue(pane, p),
          fontStr,
        );
      }

      const hover = this.axisHover;
      if (!c && hover && hover.pane === pane) {
        this.drawPriceLabel(ax, pane, hover.y, fontStr);
      }

      if (!c) {
        if (Number.isNaN(syncIndex)) continue;
        ctx.strokeStyle = t.crosshair;
        dashedLine(ctx, syncX, 0, syncX, pane.height, this.dpr, [4, 4]);
        if (pane.id !== 'main' || syncPrice === null) continue;
        const y = ps.priceToY(syncPrice);
        if (!(y >= 0 && y <= pane.height)) continue;
        dashedLine(ctx, 0, y, paneW, y, this.dpr, [4, 4]);
        this.drawPriceLabel(ax, pane, y, fontStr, false);
        continue;
      }
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
        this.drawPriceLabel(ax, pane, c.y, fontStr);
      }
    }

    const tc = this.timeAxisOverlay.begin();
    const tLabels = this.axisLabelBuf;
    tLabels.length = 0;
    this.drawingLayer.axisLabels('time', null, tLabels);
    if (tLabels.length) {
      const tl = this.refreshTimeline();
      tc.font = fontStr;
      for (const l of tLabels) {
        const x = this.timeScale.indexToX(timeToLogical(tl, { time: l.value }));
        if (!(x >= 0 && x <= paneW)) continue;
        const text = formatCrosshairTime(l.value, this.interval.unit, this.tz, this.options.locale);
        const w = tc.measureText(text).width + 16;
        const lx = Math.max(0, Math.min(paneW - w, x - w / 2));
        labelBox(
          tc,
          text,
          lx,
          3,
          w,
          AXIS_LABEL_HEIGHT,
          l.color,
          l.textColor ?? '#ffffff',
          fontStr,
          'center',
        );
      }
    }
    const cross = c
      ? { time: this.store.time[c.index], x: c.x }
      : Number.isNaN(syncIndex)
        ? null
        : { time: logicalToTime(this.refreshTimeline(), syncIndex)?.time, x: syncX };
    if (cross) {
      const time = cross.time;
      if (time !== undefined) {
        const text = formatCrosshairTime(time, this.interval.unit, this.tz, this.options.locale);
        tc.font = fontStr;
        const w = tc.measureText(text).width + 16;
        const x = Math.max(0, Math.min(paneW - w, cross.x - w / 2));
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

  /** Regular session as [startMinute, endMinute] in exchange time, if known. */
  private sessionMinutes(): [number, number] | null {
    const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(this.symbolInfo?.session ?? '');
    if (!m) return null;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    // 24h markets have nothing to shade.
    return end - start >= 23 * 60 ? null : [start, end];
  }

  private outOfSession(t: number, session: [number, number]): boolean {
    // Minutes in exchange time, regardless of the chart's display timezone.
    const tz = this.exchangeTz;
    const m = Math.floor((((tz.toLocal(t) % 86_400) + 86_400) % 86_400) / 60);
    const [a, b] = session;
    return a <= b ? m < a || m >= b : m >= b && m < a;
  }

  private get exchangeTz(): TzConverter {
    return createTzConverter(this.symbolInfo?.timezone ?? 'UTC');
  }

  /** Shade pre/post-market bars (intraday with extended hours on). */
  private shadeExtendedHours(
    dev: CanvasRenderingContext2D,
    from: number,
    to: number,
    height: number,
  ): void {
    if (!this.options.prepost || !isIntraday(this.interval) || this.usesTransform) return;
    const session = this.sessionMinutes();
    if (!session) return;
    const ts = this.timeScale;
    const half = ts.barSpacing / 2;
    const time = this.store.time;
    dev.fillStyle = this.theme.extendedHoursBg;
    let runStart = -1;
    const flush = (end: number) => {
      const x0 = Math.round((ts.indexToX(runStart) - half) * this.dpr);
      const x1 = Math.round((ts.indexToX(end) + half) * this.dpr);
      dev.fillRect(x0, 0, x1 - x0, Math.round(height * this.dpr));
      runStart = -1;
    };
    for (let i = from; i <= to; i++) {
      const out = this.outOfSession(time[i]!, session);
      if (out && runStart < 0) runStart = i;
      else if (!out && runStart >= 0) flush(i - 1);
    }
    if (runStart >= 0) flush(to);
  }

  /** Close of the previous trading day's regular session (intraday charts). */
  private prevDayClose(): number | null {
    if (!this.options.showPrevClose || !isIntraday(this.interval) || this.usesTransform)
      return null;
    const s = this.store;
    const n = s.length;
    if (n < 2) return null;
    const tz = this.exchangeTz;
    const session = this.sessionMinutes();
    const day = (t: number) => Math.floor(tz.toLocal(t) / 86_400);
    const lastDay = day(s.time[n - 1]!);
    for (let i = n - 1; i >= 0; i--) {
      const t = s.time[i]!;
      if (day(t) >= lastDay) continue;
      if (session && this.outOfSession(t, session)) continue;
      return s.close[i]!;
    }
    return null;
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
          if (this.volumeMode !== 'hidden')
            html += `<span class="io-legend-item"><span class="io-legend-label">Vol</span><span style="color:${color}">${formatVolume(bar.volume)}</span></span>`;
        }
        setHtml(pane.legendInfo, html);
      } else {
        // Study legends are rendered by the app into pane.legendSlot.
        const html = pane.series
          .filter((s) => !(s instanceof StudySeries))
          .map((s) => {
            const v = s.valuesAt(idx);
            const val = v.length ? formatAxisNumber(v[v.length - 1]!, pane.labelDecimals + 1) : '—';
            return `<span class="io-legend-title">${escapeHtml(s.title)}</span><span class="io-legend-item">${val}</span>`;
          })
          .join('');
        setHtml(pane.legendInfo, html);
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

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeDeep<T extends object>(base: T, over: DeepPartial<T>): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object'
        ? mergeDeep(b as object, v as DeepPartial<object>)
        : v;
  }
  return out as T;
}
