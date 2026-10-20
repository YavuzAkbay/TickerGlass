// Main-thread side of the indicator worker for one chart: forwards displayed
// bars, mirrors the instance list into the engine (studies) and the worker
// (computation), fetches higher-timeframe series and routes results.
import {
  intervalSeconds,
  parseInterval,
  type Bar,
  type BarColumns,
  type ChartEvents,
  type ChartType,
  type DataFeed,
  type SeriesChange,
  type SeriesStore,
  type StudyApi,
  type StudySpec,
  type StudyTarget,
  type SymbolInfo,
  type Unsubscribe,
} from '@investopen/engine';
import {
  externalSymbols,
  getIndicator,
  isUserScriptType,
  resolveOutputs,
  type AnyIndicatorDefinition,
  type InstanceStatus,
  type RuntimeContext,
} from '@investopen/indicators';
import {
  sourceRefOf,
  studyTitle,
  timeframeMap,
  visibleOnInterval,
  type IndicatorState,
} from './model';
import { BRICK_MESSAGE, ExternalSymbols } from './external';
import { MAX_SCRIPT_INSTANCES_PER_CHART, SCRIPT_INSTANCE_CAP_MESSAGE } from './sandbox/limits';
import { userScriptProblem } from '../scripts/definitions';
import type { FromWorker, ToWorker } from './protocol';
import { useIndicatorRuntime } from './store';

/** What the controller needs from the engine chart (Chart implements it). */
export interface ChartHost extends StudyApi {
  readonly store: Pick<
    SeriesStore,
    'length' | 'time' | 'open' | 'high' | 'low' | 'close' | 'volume' | 'bar'
  >;
  readonly symbolInfo: SymbolInfo | null;
  getSymbol(): string;
  getInterval(): string;
  on<K extends keyof ChartEvents>(event: K, fn: (p: ChartEvents[K]) => void): () => void;
}

/** Message port to the worker (a real Worker in the app, in-process in tests). */
export interface WorkerPort {
  post(msg: ToWorker, transfer?: Transferable[]): void;
  /** Worker load/runtime failures are delivered as a fatal `{ type: 'error' }` (no id). */
  listen(fn: (msg: FromWorker) => void): void;
  terminate(): void;
}

export function createIndicatorWorker(): WorkerPort {
  const w = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
    name: 'indicators',
  });
  return {
    post: (msg, transfer = []) => w.postMessage(msg, transfer),
    listen: (fn) => {
      w.onmessage = (e: MessageEvent<FromWorker>) => fn(e.data);
      w.onerror = (e) => fn({ type: 'error', message: `Indicator worker failed: ${e.message}` });
      w.onmessageerror = () =>
        fn({ type: 'error', message: 'Indicator worker failed: unreadable message' });
    },
    terminate: () => w.terminate(),
  };
}

export interface ControllerOptions {
  chart: ChartHost;
  feed: DataFeed;
  worker: WorkerPort;
  /** Coalesces live bars (requestAnimationFrame in the app). */
  schedule?: (fn: () => void) => void;
  /** User-facing errors (toasts in the app). */
  onError?: (message: string) => void;
  /** The engine dropped studies (e.g. their pane was removed); the app removes the instances. */
  onStudiesLost?: (ids: string[]) => void;
  /** Extended hours for timeframe requests. */
  prepost?: () => boolean;
  /** Chart type the app shows (external symbols are unavailable on brick types). Default: candles. */
  chartType?: () => ChartType;
  /** Bumps whenever fetched data must be refetched (replay start/seek/stop). Default: constant. */
  dataEpoch?: () => number;
}

interface Applied {
  inputsKey: string;
  title: string;
  outputsKey: string;
  visible: boolean;
  targetKey: string;
  priceScale: StudySpec['priceScale'];
}

interface TfSeries {
  /** The request finished with bars (until then it is in flight). */
  loaded: boolean;
  /** First bar time (meaningful once loaded). */
  first: number;
  /** No older history available (or the request cap was hit). */
  complete: boolean;
  unsub: Unsubscribe | null;
}

/** Bars of warm-up requested before the chart's first bar for timeframe series. */
const TF_WARMUP = 300;
const TF_MAX_BARS = 5000;
/** Consecutive resyncs of one series revision before the worker is given up on. */
const MAX_RESYNCS = 3;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Interval in seconds, 0 when the string does not parse. */
export function secondsOf(interval: string): number {
  try {
    return intervalSeconds(parseInterval(interval));
  } catch {
    // Unknown interval strings (e.g. brick-only charts) mean "interval unknown" to indicators.
    return 0;
  }
}

/** Copies of bars `[from, n)` of the columns (the script editor's Check uses the latest ones). */
export function copyColumns(src: ChartHost['store'] | BarColumns, n: number, from = 0): BarColumns {
  return {
    time: src.time.slice(from, n),
    open: src.open.slice(from, n),
    high: src.high.slice(from, n),
    low: src.low.slice(from, n),
    close: src.close.slice(from, n),
    volume: src.volume.slice(from, n),
  };
}

const buffers = (c: BarColumns): Transferable[] => [
  c.time.buffer,
  c.open.buffer,
  c.high.buffer,
  c.low.buffer,
  c.close.buffer,
  c.volume.buffer,
];

export class IndicatorController {
  private readonly chart: ChartHost;
  private readonly feed: DataFeed;
  private readonly worker: WorkerPort;
  private readonly schedule: (fn: () => void) => void;
  private readonly onError: (message: string) => void;
  private list: readonly IndicatorState[] = [];
  private readonly applied = new Map<string, Applied>();
  /**
   * Applied script instances whose definition went away (script deleted or
   * broken): the router stopped their sandbox, so they hold no cap slot.
   */
  private readonly stalled = new Set<string>();
  private hidden = false;
  private sentRevision = -1;
  private symbol: string | null = null;
  private interval: string | null = null;
  private tfMapKey = '';
  private tfMap: Record<string, string> = {};
  private contextKey = '';
  /** In a reset: the context goes with the bars, not on its own. */
  private deferContext = false;
  private required: string[] = [];
  private readonly tfSeries = new Map<string, TfSeries>();
  private readonly external: ExternalSymbols;
  private dataEpoch = 0;
  /** External symbols that failed to load, with the message. */
  private readonly symbolProblems = new Map<string, string>();
  private pending = new Map<number, Bar>();
  private flushQueued = false;
  private offs: (() => void)[] = [];
  private destroyed = false;
  /** `bars` messages posted (the worker echoes its count in resync). */
  private barsSent = 0;
  /** Resyncs of the current revision since a live bar last applied cleanly. */
  private resyncs = 0;
  /** A fatal worker error was reported: no more resyncs, no repeated toasts. */
  private failed = false;

  constructor(private readonly opts: ControllerOptions) {
    this.chart = opts.chart;
    this.feed = opts.feed;
    this.worker = opts.worker;
    this.schedule = opts.schedule ?? ((fn) => queueMicrotask(fn));
    this.onError = opts.onError ?? ((m) => console.error(m));
    this.external = new ExternalSymbols({
      chart: this.chart,
      feed: this.feed,
      post: (msg, transfer) => this.worker.post(msg, transfer),
      schedule: this.schedule,
      chartType: opts.chartType ?? (() => 'candles'),
      prepost: () => this.opts.prepost?.() ?? false,
      dataEpoch: () => this.opts.dataEpoch?.() ?? 0,
      onProblem: (symbol, message) => this.onSymbolProblem(symbol, message),
    });
    this.worker.listen((msg) => this.onMessage(msg));
    this.offs.push(
      this.chart.on('seriesChange', (c) => this.onSeriesChange(c)),
      this.chart.on('paneRemoved', () => this.onPaneRemoved()),
      this.chart.on('studiesCleared', (e) => this.onStudiesCleared(e.ids)),
    );
    this.interval = this.chart.getInterval();
    this.sendContext();
    if (this.chart.store.length) {
      this.sendBars(this.chart.seriesRevision);
      this.external.reset(this.chart.seriesRevision);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.offs.forEach((off) => off());
    this.offs = [];
    for (const s of this.tfSeries.values()) s.unsub?.();
    this.tfSeries.clear();
    this.external.destroy();
    this.worker.terminate();
    useIndicatorRuntime.setState({ status: {}, panes: {} });
  }

  /** Global "hide indicators" (left toolbar hide button). */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.sync(this.list);
  }

  /** Mirror the store's instance list into the engine and the worker. */
  sync(list: readonly IndicatorState[]): void {
    if (this.destroyed) return;
    this.list = list;
    const ids = new Set(list.map((i) => i.id));
    for (const id of [...this.applied.keys()]) {
      if (ids.has(id)) continue;
      this.applied.delete(id);
      this.stalled.delete(id);
      this.worker.post({ type: 'remove', id });
      this.engine(() => this.chart.removeStudy(id));
      this.forget(id);
    }
    this.sendTimeframeMap(false);
    // Script instances already running keep their slot; others (new, or whose
    // definition just came back) start only while fewer than the cap run.
    let scripts = 0;
    for (const inst of list)
      if (
        isUserScriptType(inst.type) &&
        getIndicator(inst.type) &&
        this.applied.has(inst.id) &&
        !this.stalled.has(inst.id)
      )
        scripts++;
    for (const inst of list) {
      const def = getIndicator(inst.type);
      if (!def) {
        // Its sandbox is stopped: no slot while the definition is gone.
        if (this.applied.has(inst.id)) this.stalled.add(inst.id);
        const problem = userScriptProblem(inst.type);
        // A user script before the scripts are loaded: no error, the load syncs again.
        if (problem === undefined && isUserScriptType(inst.type)) {
          this.clearStatus(inst.id);
          continue;
        }
        this.setStatus(inst.id, {
          state: 'error',
          message: problem ?? `Unknown indicator "${inst.type}"`,
        });
        continue;
      }
      const prev = this.applied.get(inst.id);
      if (isUserScriptType(inst.type) && (!prev || this.stalled.has(inst.id))) {
        if (scripts >= MAX_SCRIPT_INSTANCES_PER_CHART) {
          if (prev) {
            // Its definition came back with no slot free: take it off the chart (and
            // the router), so a later sync adds it afresh once there is room.
            this.applied.delete(inst.id);
            this.stalled.delete(inst.id);
            this.worker.post({ type: 'remove', id: inst.id });
            this.engine(() => this.chart.removeStudy(inst.id));
          }
          this.setStatus(inst.id, { state: 'error', message: SCRIPT_INSTANCE_CAP_MESSAGE });
          continue;
        }
        scripts++;
        this.stalled.delete(inst.id);
      }
      const next = this.describe(inst, def);
      if (!prev) {
        this.add(inst, def, next);
        continue;
      }
      if (next.inputsKey !== prev.inputsKey)
        this.worker.post({ type: 'setInputs', id: inst.id, inputs: inst.inputs });
      if (next.title !== prev.title || next.outputsKey !== prev.outputsKey) {
        const outputs = resolveOutputs(def, inst.inputs, inst.styles);
        this.engine(() => this.chart.updateStudySpec(inst.id, { title: next.title, outputs }));
      }
      if (next.visible !== prev.visible)
        this.engine(() => this.chart.setStudyVisible(inst.id, next.visible));
      if (next.targetKey !== prev.targetKey) {
        const target = this.target(inst, def);
        this.engine(() => this.setPane(inst.id, this.chart.moveStudy(inst.id, target)));
      }
      if (next.priceScale !== prev.priceScale)
        this.engine(() => this.chart.updateStudySpec(inst.id, { priceScale: next.priceScale }));
      this.applied.set(inst.id, next);
    }
  }

  // ------------------------------------------------------------- instances

  private lookup = (id: string) => this.list.find((i) => i.id === id);

  private describe(inst: IndicatorState, def: AnyIndicatorDefinition): Applied {
    return {
      inputsKey: JSON.stringify(inst.inputs),
      title: studyTitle(def, inst.inputs, this.lookup),
      outputsKey: JSON.stringify(resolveOutputs(def, inst.inputs, inst.styles)),
      visible: this.effectiveVisible(inst),
      targetKey: inst.placement,
      priceScale: this.priceScale(inst, def),
    };
  }

  /**
   * 'none' (own scale at the bottom of the pane, like a volume
   * overlay) for volume-scaled studies in the price pane and for studies that
   * plot them (e.g. an SMA on Volume), so they never squash the price scale.
   */
  private priceScale(inst: IndicatorState, def: AnyIndicatorDefinition): StudySpec['priceScale'] {
    // The pane it is in, or goes to when added or its placement changed.
    const placed = this.applied.get(inst.id)?.targetKey === inst.placement;
    const target = this.target(inst, def);
    const paneId = placed
      ? useIndicatorRuntime.getState().panes[inst.id]
      : 'paneId' in target
        ? target.paneId
        : null;
    if (paneId !== 'main') return 'pane';
    let cur: IndicatorState | undefined = inst;
    let d: AnyIndicatorDefinition | undefined = def;
    // Bounded: validateInstances rejects source cycles.
    for (let depth = 0; cur && d && depth <= this.list.length; depth++) {
      const format = d.format ?? 'inherit';
      if (format === 'volume') return 'none';
      if (format !== 'inherit') return 'pane';
      const ref = sourceRefOf(cur);
      cur = ref ? this.lookup(ref.instanceId) : undefined;
      d = cur ? getIndicator(cur.type) : undefined;
    }
    return 'pane';
  }

  private effectiveVisible(inst: IndicatorState): boolean {
    return (
      !this.hidden && inst.visible && visibleOnInterval(inst.visibility, this.chart.getInterval())
    );
  }

  private target(inst: IndicatorState, def: AnyIndicatorDefinition): StudyTarget {
    const own: StudyTarget = { newPane: { id: `pane-${inst.id}` } };
    if (inst.placement === 'main') return { paneId: 'main' };
    if (inst.placement === 'own') return own;
    const ref = sourceRefOf(inst);
    const srcPane = ref ? useIndicatorRuntime.getState().panes[ref.instanceId] : undefined;
    if (srcPane) return { paneId: srcPane };
    return def.overlay ? { paneId: 'main' } : own;
  }

  private add(inst: IndicatorState, def: AnyIndicatorDefinition, next: Applied): void {
    const format = def.format ?? 'inherit';
    const spec: StudySpec = {
      id: inst.id,
      title: next.title,
      target: this.target(inst, def),
      outputs: resolveOutputs(def, inst.inputs, inst.styles),
      format,
      precision: def.precision ?? null,
      scaleRange: def.scaleRange ? { ...def.scaleRange } : null,
      priceScale: next.priceScale,
      visible: next.visible,
    };
    const ok = this.engine(() => this.setPane(inst.id, this.chart.addStudy(spec)));
    if (!ok) {
      this.setStatus(inst.id, { state: 'error', message: 'Could not add to the chart' });
      return;
    }
    this.applied.set(inst.id, next);
    this.worker.post({ type: 'add', spec: { id: inst.id, type: inst.type, inputs: inst.inputs } });
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

  private setPane(id: string, paneId: string): void {
    useIndicatorRuntime.setState((s) => ({ panes: { ...s.panes, [id]: paneId } }));
  }

  private setStatus(id: string, status: InstanceStatus): void {
    useIndicatorRuntime.setState((s) => ({ status: { ...s.status, [id]: status } }));
  }

  private clearStatus(id: string): void {
    if (!(id in useIndicatorRuntime.getState().status)) return;
    useIndicatorRuntime.setState((s) => {
      const { [id]: _s, ...status } = s.status;
      return { status };
    });
  }

  private forget(id: string): void {
    useIndicatorRuntime.setState((s) => {
      const { [id]: _s, ...status } = s.status;
      const { [id]: _p, ...panes } = s.panes;
      return { status, panes };
    });
  }

  private onPaneRemoved(): void {
    const panes: Record<string, string> = {};
    for (const s of this.chart.getStudies()) panes[s.id] = s.paneId;
    useIndicatorRuntime.setState({ panes });
    const lost = [...this.applied.keys()].filter((id) => !(id in panes));
    if (!lost.length) return;
    for (const id of lost) {
      this.applied.delete(id);
      this.worker.post({ type: 'remove', id });
    }
    this.opts.onStudiesLost?.(lost);
  }

  /** setState dropped the engine's studies: re-add them from the instance list. */
  private onStudiesCleared(ids: string[]): void {
    if (this.destroyed) return;
    for (const id of ids) {
      if (!this.applied.delete(id)) continue;
      this.worker.post({ type: 'remove', id });
    }
    this.sync(this.list);
  }

  // ------------------------------------------------------------------ bars

  private onSeriesChange(c: SeriesChange): void {
    if (this.destroyed) return;
    // A prepend shifts every index: the worker needs the whole series again.
    if (c.kind === 'reset' || c.kind === 'prepend') {
      this.onReset(c.revision);
      return;
    }
    // Bars of a series the worker never received would land on wrong indices.
    if (c.revision !== this.sentRevision) return;
    const bar = this.chart.store.bar(c.index);
    if (!bar) return;
    this.pending.set(c.index, bar);
    if (this.flushQueued) return;
    this.flushQueued = true;
    this.schedule(() => this.flush());
  }

  private flush(): void {
    this.flushQueued = false;
    if (this.destroyed) return;
    const pending = this.pending;
    this.pending = new Map();
    const indices = [...pending.keys()].sort((a, b) => a - b);
    // External bars first: the worker waits when the chart is ahead of them.
    if (indices.length) this.external.onBars(indices[0]!);
    for (const index of indices)
      this.worker.post({
        type: 'bar',
        revision: this.sentRevision,
        index,
        bar: pending.get(index)!,
      });
  }

  private onReset(revision: number): void {
    const symbol = this.chart.getSymbol();
    const interval = this.chart.getInterval();
    if (this.symbol !== null && symbol !== this.symbol) {
      this.worker.post({ type: 'clear' });
      this.dropTimeframes();
    }
    const epoch = this.opts.dataEpoch?.() ?? 0;
    if (epoch !== this.dataEpoch) {
      // Replay started, seeked or stopped: timeframe series hold stale (or future) data.
      this.dataEpoch = epoch;
      this.dropTimeframes();
    }
    this.symbol = symbol;
    if (interval !== this.interval) {
      this.interval = interval;
      this.dropTimeframes();
      this.deferContext = true;
      try {
        this.sendTimeframeMap(true);
      } finally {
        this.deferContext = false;
      }
      // Per-interval visibility.
      this.sync(this.list);
    }
    // With the bars (not before them), so period-anchored indicators compute once,
    // with the right timezone, instead of first on the old bars.
    this.sendBars(revision, this.takeContext());
    this.external.reset(revision);
    this.applyProblems();
    for (const tf of this.required) this.ensureTimeframe(tf);
  }

  private sendBars(revision: number, context: RuntimeContext | null = null): void {
    this.pending.clear();
    if (revision !== this.sentRevision) this.resyncs = 0;
    this.sentRevision = revision;
    this.barsSent++;
    this.symbol ??= this.chart.getSymbol();
    const bars = copyColumns(this.chart.store, this.chart.store.length);
    this.worker.post(
      { type: 'bars', revision, bars, ...(context ? { context } : {}) },
      buffers(bars),
    );
  }

  // ------------------------------------------------------------ timeframes

  private sendTimeframeMap(force: boolean): void {
    const map = timeframeMap(this.list, this.chart.getInterval());
    const key = JSON.stringify(map);
    if (!force && key === this.tfMapKey) return;
    this.tfMapKey = key;
    this.tfMap = map;
    this.worker.post({ type: 'timeframeMap', map });
    this.sendContext();
  }

  /** Exchange timezone/session (calendar periods, e.g. VWAP anchors) and intervals, when changed. */
  private sendContext(): void {
    if (this.deferContext) return;
    const context = this.takeContext();
    if (context) this.worker.post({ type: 'context', context });
  }

  /** The context if it changed since last sent (and mark it sent), else null. */
  private takeContext(): RuntimeContext | null {
    const info = this.chart.symbolInfo;
    const timeframeSeconds: Record<string, number> = {};
    for (const tf of Object.values(this.tfMap)) if (tf) timeframeSeconds[tf] = secondsOf(tf);
    const context: RuntimeContext = {
      timezone: info?.timezone ?? 'UTC',
      session: info?.session ?? null,
      intervalSeconds: secondsOf(this.chart.getInterval()),
      timeframeSeconds,
    };
    const key = JSON.stringify(context);
    if (key === this.contextKey) return null;
    this.contextKey = key;
    return context;
  }

  private dropTimeframes(): void {
    for (const s of this.tfSeries.values()) s.unsub?.();
    this.tfSeries.clear();
  }

  private onTimeframes(tfs: string[]): void {
    this.required = tfs;
    for (const [tf, s] of this.tfSeries) {
      if (tfs.includes(tf)) continue;
      s.unsub?.();
      this.tfSeries.delete(tf);
    }
    for (const tf of tfs) this.ensureTimeframe(tf);
  }

  /** Fetch (or extend) a timeframe series covering the chart's span plus warm-up. */
  private ensureTimeframe(tf: string): void {
    const store = this.chart.store;
    const n = store.length;
    if (!n) return;
    const chartFirst = store.time[0]!;
    const cur = this.tfSeries.get(tf);
    if (cur && (!cur.loaded || cur.complete || cur.first <= chartFirst)) return;
    cur?.unsub?.();
    let interval;
    try {
      interval = parseInterval(tf);
    } catch (err) {
      this.onError(errText(err));
      return;
    }
    const entry: TfSeries = { loaded: false, first: Infinity, complete: false, unsub: null };
    this.tfSeries.set(tf, entry);
    const end = Math.max(store.time[n - 1]!, Date.now() / 1000);
    const limit = Math.min(
      TF_MAX_BARS,
      Math.ceil((end - chartFirst) / intervalSeconds(interval)) + TF_WARMUP,
    );
    const symbol = this.chart.getSymbol();
    const prepost = this.opts.prepost?.() ?? false;
    const current = () => !this.destroyed && this.tfSeries.get(tf) === entry;
    this.feed
      .getBars({ symbol, interval, limit, prepost })
      .then((res) => {
        if (!current()) return;
        const len = res.bars.time.length;
        if (!len) {
          // Nothing yet (e.g. a new listing): the instance keeps waiting; retry on the next reset.
          this.tfSeries.delete(tf);
          return;
        }
        entry.loaded = true;
        entry.first = res.bars.time[0]!;
        entry.complete = !res.hasMore || len < limit || limit >= TF_MAX_BARS;
        // Copies: the feed may cache the arrays it returned.
        const bars = copyColumns(res.bars, len);
        this.worker.post({ type: 'tfBars', tf, bars }, buffers(bars));
        const last = {
          time: bars.time[len - 1]!,
          open: bars.open[len - 1]!,
          high: bars.high[len - 1]!,
          low: bars.low[len - 1]!,
          close: bars.close[len - 1]!,
          volume: bars.volume[len - 1]!,
        };
        const info = this.chart.symbolInfo;
        entry.unsub = this.feed.subscribe(
          {
            symbol,
            interval,
            prepost,
            timezone: info?.timezone ?? null,
            session: info?.session ?? null,
          },
          last,
          (bar) => {
            if (current()) this.worker.post({ type: 'tfBar', tf, bar });
          },
        );
      })
      .catch((err: unknown) => {
        if (!current()) return;
        // Retry on the next reset.
        this.tfSeries.delete(tf);
        this.onError(`Could not load ${tf} bars: ${errText(err)}`);
      });
  }

  // ------------------------------------------------------ external symbols

  private onSymbolProblem(symbol: string, message: string | null): void {
    if (message === null) this.symbolProblems.delete(symbol);
    else {
      this.symbolProblems.set(symbol, message);
      this.onError(`Could not load ${symbol}: ${message}`);
    }
    this.applyProblems();
  }

  /** Error status of an instance that reads a symbol which cannot be shown, else null. */
  private externalError(inst: IndicatorState): InstanceStatus | null {
    const def = getIndicator(inst.type);
    if (!def) return null;
    for (const symbol of externalSymbols(def, inst.inputs)) {
      const message =
        this.external.unavailableReason === BRICK_MESSAGE
          ? BRICK_MESSAGE
          : (this.symbolProblems.get(symbol) ?? this.external.unavailableReason);
      if (message) return { state: 'error', message: `${symbol}: ${message}` };
    }
    return null;
  }

  /** Show load failures / unavailability on the instances that read those symbols. */
  private applyProblems(): void {
    if (this.destroyed) return;
    const status: Record<string, InstanceStatus> = {};
    for (const inst of this.list) {
      const err = this.externalError(inst);
      if (err) status[inst.id] = err;
    }
    if (Object.keys(status).length)
      useIndicatorRuntime.setState((s) => ({ status: { ...s.status, ...status } }));
  }

  // --------------------------------------------------------------- results

  private onMessage(msg: FromWorker): void {
    if (this.destroyed) return;
    switch (msg.type) {
      case 'symbols':
        this.external.setRequired(msg.symbols);
        return;
      case 'results':
        this.onResults(msg);
        return;
      case 'timeframes':
        this.onTimeframes(msg.timeframes);
        return;
      case 'resync':
        this.onResync(msg);
        return;
      case 'error': {
        if (msg.id === undefined) {
          this.fail(msg.message);
          return;
        }
        const inst = this.lookup(msg.id);
        const name = inst ? (getIndicator(inst.type)?.shortName ?? inst.type) : msg.id;
        this.setStatus(msg.id, { state: 'error', message: msg.message });
        this.onError(`${name}: ${msg.message}`);
        return;
      }
    }
  }

  /** A live bar did not fit the worker's series: resend everything, once per burst. */
  private onResync(msg: Extract<FromWorker, { type: 'resync' }>): void {
    if (this.failed) return;
    // A newer full series is already on its way, or the chart moved on (its reset resends).
    if (msg.bars < this.barsSent || msg.revision !== this.sentRevision) return;
    if (msg.revision !== this.chart.seriesRevision || !this.chart.store.length) return;
    if (++this.resyncs > MAX_RESYNCS) {
      this.fail('Indicator data keeps falling out of sync with the chart');
      return;
    }
    this.sendBars(msg.revision);
  }

  /** Report a fatal worker failure once; stop resending to it. */
  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.onError(message);
  }

  private onResults(msg: Extract<FromWorker, { type: 'results' }>): void {
    // A live bar applied cleanly: the worker is in step again. Only the
    // indicator worker's own (non-script) results count: sandboxes have their
    // own resync budget in the router, and must not reset this one.
    const builtin = msg.changes.filter((c) => {
      const inst = this.lookup(c.id);
      return inst !== undefined && !isUserScriptType(inst.type);
    });
    if (
      msg.revision === this.sentRevision &&
      builtin.length > 0 &&
      builtin.every((c) => c.from > 0)
    )
      this.resyncs = 0;
    if (msg.revision !== this.chart.seriesRevision) return;
    const status: Record<string, InstanceStatus> = {};
    for (const ch of msg.changes) {
      if (!this.applied.has(ch.id)) continue;
      const inst = this.lookup(ch.id);
      status[ch.id] = (inst && this.externalError(inst)) || ch.status;
      const { revision, length } = msg;
      this.engine(() => {
        if (ch.from === 0)
          this.chart.setStudyData(ch.id, {
            revision,
            length,
            values: ch.values,
            colors: ch.colors,
          });
        else
          this.chart.updateStudyData(ch.id, {
            revision,
            from: ch.from,
            length,
            values: ch.values,
            colors: ch.colors,
          });
      });
    }
    useIndicatorRuntime.setState((s) => ({
      status: { ...s.status, ...status },
      tick: s.tick + 1,
    }));
  }
}
