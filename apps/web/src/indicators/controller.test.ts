import {
  SeriesStore,
  type Bar,
  type BarColumns,
  type ChartEvents,
  type ChartType,
  type DataFeed,
  type GetBarsRequest,
  type StudyData,
  type StudyDataPatch,
  type StudyInfo,
  type StudySpec,
  type StudyTarget,
  type SymbolInfo,
} from '@investopen/engine';
import {
  IndicatorRuntime,
  defaultRegistry,
  defineIndicator,
  getIndicator,
  registerIndicator,
  type InputValueMap,
} from '@investopen/indicators';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistory } from '../commands/history';
import { addIndicator, removeIndicators } from './actions';
import { IndicatorController, type ChartHost, type WorkerPort } from './controller';
import { createInstance, type IndicatorState } from './model';
import type { FromWorker, ToWorker } from './protocol';
import { useIndicatorRuntime, useIndicatorStore } from './store';
import { WorkerCore } from './workerCore';
import { MAX_SCRIPT_INSTANCES_PER_CHART, SCRIPT_INSTANCE_CAP_MESSAGE } from './sandbox/limits';
import { useScriptsStore } from '../scripts/store';

// A whole-indicator timeframe test definition (Pivot Points style).
if (!getIndicator('test_tf_close'))
  registerIndicator(
    defineIndicator({
      id: 'test_tf_close',
      name: 'Timeframe close',
      shortName: 'TFC',
      category: 'other',
      overlay: true,
      inputs: { timeframe: { kind: 'timeframe', label: 'Timeframe', default: 'auto' } },
      outputs: [{ type: 'plot', id: 'v', title: 'Close', kind: 'line', color: '#fff' }],
      setup: () => (c) => c.set('v', c.close[c.i]!),
    }),
  );

const DAY = 86_400;
const START = 1_700_006_400; // a Monday 00:00 UTC

function makeBars(n: number, step = DAY, start = START, seed = 1): BarColumns {
  const cols: BarColumns = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const c = p + Math.sin(i * 0.7 + seed) * 2;
    cols.time[i] = start + i * step;
    cols.open[i] = p;
    cols.close[i] = c;
    cols.high[i] = Math.max(p, c) + 1;
    cols.low[i] = Math.min(p, c) - 1;
    cols.volume[i] = 1000 + i;
    p = c;
  }
  return cols;
}

interface FakeStudy {
  spec: StudySpec;
  paneId: string;
  visible: boolean;
  revision: number;
  length: number;
  values: Record<string, number[]>;
  sets: number;
  patches: StudyDataPatch[];
}

class FakeChart implements ChartHost {
  readonly store = new SeriesStore();
  symbolInfo: SymbolInfo | null = null;
  seriesRevision = 0;
  symbol = 'AAPL';
  interval = '1D';
  studies = new Map<string, FakeStudy>();
  private listeners = new Map<string, Set<(p: unknown) => void>>();

  getSymbol() {
    return this.symbol;
  }
  getInterval() {
    return this.interval;
  }
  on<K extends keyof ChartEvents>(event: K, fn: (p: ChartEvents[K]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(fn as (p: unknown) => void);
    return () => set.delete(fn as (p: unknown) => void);
  }
  emit<K extends keyof ChartEvents>(event: K, p: ChartEvents[K]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(p);
  }

  load(cols: BarColumns): void {
    this.store.setAll(cols);
    this.seriesRevision++;
    this.emit('seriesChange', {
      kind: 'reset',
      revision: this.seriesRevision,
      length: this.store.length,
    });
  }
  tick(bar: Bar): void {
    const r = this.store.upsert(bar);
    if (r === 'ignored') return;
    this.emit('seriesChange', {
      kind: r,
      revision: this.seriesRevision,
      index: this.store.length - 1,
    });
  }

  /** Pane ids in order; same rules as the engine (newPane reuses an existing id). */
  panes = ['main'];
  private paneOf(target: StudyTarget): string {
    if ('paneId' in target) {
      if (!this.panes.includes(target.paneId)) throw new Error(`Unknown pane: ${target.paneId}`);
      return target.paneId;
    }
    const id = target.newPane.id ?? `new-${this.panes.length}`;
    if (!this.panes.includes(id)) this.panes.push(id);
    return id;
  }
  /** Remove a non-main pane left without studies (engine detachStudy). */
  private dropIfEmpty(paneId: string): void {
    if (paneId === 'main' || [...this.studies.values()].some((s) => s.paneId === paneId)) return;
    this.panes = this.panes.filter((p) => p !== paneId);
    this.emit('paneRemoved', { paneId, studyIds: [] });
  }
  /** Pane menu "Remove pane" (engine removePane). */
  removePane(paneId: string): void {
    const studyIds = [...this.studies.values()].filter((s) => s.paneId === paneId);
    this.panes = this.panes.filter((p) => p !== paneId);
    for (const s of studyIds) this.studies.delete(s.spec.id);
    if (studyIds.length)
      this.emit('paneRemoved', { paneId, studyIds: studyIds.map((s) => s.spec.id) });
  }
  /** Engine setState: all studies dropped, panes kept. */
  clearStudies(): void {
    const ids = [...this.studies.keys()];
    this.studies.clear();
    this.emit('studiesCleared', { ids });
  }
  addStudy(spec: StudySpec): string {
    if (this.studies.has(spec.id)) throw new Error('exists');
    const paneId = this.paneOf(spec.target);
    this.studies.set(spec.id, {
      spec,
      paneId,
      visible: spec.visible,
      revision: -1,
      length: 0,
      values: {},
      sets: 0,
      patches: [],
    });
    return paneId;
  }
  removeStudy(id: string): void {
    const s = this.studies.get(id);
    if (!s) return;
    this.studies.delete(id);
    this.dropIfEmpty(s.paneId);
  }
  moveStudy(id: string, target: StudyTarget): string {
    const s = this.studies.get(id)!;
    const from = s.paneId;
    s.paneId = this.paneOf(target);
    if (s.paneId !== from) this.dropIfEmpty(from);
    return s.paneId;
  }
  getStudies(): StudyInfo[] {
    return [...this.studies.values()].map((s) => ({
      id: s.spec.id,
      paneId: s.paneId,
      title: s.spec.title,
      visible: s.visible,
    }));
  }
  setStudyData(id: string, data: StudyData): void {
    const s = this.studies.get(id)!;
    s.sets++;
    s.revision = data.revision;
    s.length = data.length;
    s.values = Object.fromEntries(
      Object.entries(data.values).map(([k, v]) => [k, Array.from(v.subarray(0, data.length))]),
    );
  }
  updateStudyData(id: string, patch: StudyDataPatch): void {
    const s = this.studies.get(id)!;
    if (patch.revision !== s.revision || patch.from > s.length) return;
    s.patches.push(patch);
    s.length = patch.length;
    for (const [k, v] of Object.entries(patch.values)) {
      const arr = (s.values[k] ??= []);
      arr.length = patch.from;
      arr.push(...v);
    }
  }
  setStudyVisible(id: string, visible: boolean): void {
    this.studies.get(id)!.visible = visible;
  }
  updateStudySpec(id: string, patch: Partial<Omit<StudySpec, 'id' | 'target'>>): void {
    const s = this.studies.get(id)!;
    s.spec = { ...s.spec, ...patch };
  }
  setStudyStyle(): void {}
  getStudyValues() {
    return [];
  }
  getLegendSlot() {
    return null;
  }
}

/** Worker running in-process; messages are delivered asynchronously like postMessage. */
function inProcessWorker(log: ToWorker[]): WorkerPort {
  let listener: ((m: FromWorker) => void) | null = null;
  const core = new WorkerCore((msg) => queueMicrotask(() => listener?.(msg)));
  return {
    post: (msg) => {
      log.push(msg);
      queueMicrotask(() => core.handle(msg));
    },
    listen: (fn) => {
      listener = fn;
    },
    terminate: () => {
      listener = null;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function stubFeed(
  bars: (req: GetBarsRequest) => BarColumns,
): DataFeed & { requests: GetBarsRequest[] } {
  const requests: GetBarsRequest[] = [];
  return {
    requests,
    resolveSymbol: () => Promise.reject(new Error('unused')),
    searchSymbols: () => Promise.resolve([]),
    getBars: async (req) => {
      requests.push(req);
      return { bars: bars(req), hasMore: false };
    },
    subscribe: () => () => {},
  };
}

function inst(type: string, inputs: InputValueMap = {}, patch: Partial<IndicatorState> = {}) {
  return { ...createInstance(getIndicator(type)!, undefined, inputs), ...patch };
}

/** Reference values straight from the runtime. */
function reference(type: string, inputs: InputValueMap, bars: BarColumns, outputId: string) {
  const rt = new IndicatorRuntime();
  rt.add({ id: 'x', type, inputs });
  rt.setBars(bars);
  const r = rt.result('x')!;
  return Array.from(r.values[outputId]!.subarray(0, r.length));
}

/** Port whose replies the test sends by hand. */
function manualWorker(log: ToWorker[]): WorkerPort & { reply: (m: FromWorker) => void } {
  let listener: ((m: FromWorker) => void) | null = null;
  return {
    post: (msg) => log.push(msg),
    listen: (fn) => {
      listener = fn;
    },
    terminate: () => {
      listener = null;
    },
    reply: (m) => listener?.(m),
  };
}

function setup(
  opts: {
    feed?: DataFeed;
    worker?: (log: ToWorker[]) => WorkerPort;
    lost?: boolean;
    chartType?: () => ChartType;
  } = {},
) {
  const chart = new FakeChart();
  const log: ToWorker[] = [];
  const frames: (() => void)[] = [];
  const onError = vi.fn();
  const ctl = new IndicatorController({
    chart,
    feed: opts.feed ?? stubFeed(() => makeBars(0)),
    worker: (opts.worker ?? inProcessWorker)(log),
    schedule: (fn) => frames.push(fn),
    onError,
    // As the app: lost studies are removed from the store (an undoable removal).
    ...(opts.lost ? { onStudiesLost: removeIndicators } : {}),
    ...(opts.chartType ? { chartType: opts.chartType } : {}),
  });
  const frame = () => frames.splice(0).forEach((f) => f());
  return { chart, log, ctl, frame, onError };
}

beforeEach(() => {
  useIndicatorRuntime.setState({ status: {}, panes: {}, tick: 0 });
  useIndicatorStore.setState({ instances: [] });
  useHistory.getState().clear();
});

describe('IndicatorController', () => {
  it('computes on load and coalesces live ticks per frame', async () => {
    const { chart, log, ctl, frame } = setup();
    const sma = inst('sma', { length: 5 });
    ctl.sync([sma]);
    const bars = makeBars(60);
    chart.load(bars);
    await settle();
    const s = chart.studies.get(sma.id)!;
    expect(s.paneId).toBe('main');
    expect(s.spec.title).toBe('SMA 5 close');
    expect(s.revision).toBe(1);
    expect(s.values.ma).toEqual(reference('sma', { length: 5 }, bars, 'ma'));
    expect(useIndicatorRuntime.getState().status[sma.id]).toEqual({ state: 'ok' });

    // Two ticks on the last bar and one append in the same frame: two bar messages.
    const last = chart.store.bar(59)!;
    chart.tick({ ...last, close: last.close + 1 });
    chart.tick({ ...last, close: last.close + 2 });
    chart.tick({ ...last, time: last.time + DAY, open: 1, high: 2, low: 0.5, close: 1.5 });
    const before = log.length;
    frame();
    const sent = log.slice(before);
    expect(sent.map((m) => (m.type === 'bar' ? m.index : -1))).toEqual([59, 60]);
    await settle();
    expect(s.sets).toBe(1);
    expect(s.length).toBe(61);
    const st = chart.store;
    const all = {
      time: st.time.slice(0, 61),
      open: st.open.slice(0, 61),
      high: st.high.slice(0, 61),
      low: st.low.slice(0, 61),
      close: st.close.slice(0, 61),
      volume: st.volume.slice(0, 61),
    };
    expect(s.values.ma).toEqual(reference('sma', { length: 5 }, all, 'ma'));
  });

  it('drops results of a superseded series revision', async () => {
    const { chart, ctl } = setup();
    const sma = inst('sma', { length: 3 });
    ctl.sync([sma]);
    chart.load(makeBars(30));
    const second = makeBars(40, DAY, START, 7);
    chart.load(second);
    await settle();
    const s = chart.studies.get(sma.id)!;
    expect(s.sets).toBe(1);
    expect(s.revision).toBe(2);
    expect(s.values.ma).toEqual(reference('sma', { length: 3 }, second, 'ma'));
  });

  it('mirrors input, visibility, placement changes and removal', async () => {
    const { chart, log, ctl } = setup();
    const a = inst('sma', { length: 5 });
    ctl.sync([a]);
    chart.load(makeBars(30));
    await settle();
    ctl.sync([{ ...a, inputs: { ...a.inputs, length: 8 } }]);
    expect(log.at(-1)).toMatchObject({ type: 'setInputs', id: a.id });
    expect(chart.studies.get(a.id)!.spec.title).toBe('SMA 8 close');

    // Days only: hidden after switching to an hourly chart.
    const vis = { ...a, inputs: { ...a.inputs, length: 8 }, visibility: daysOnly() };
    ctl.sync([vis]);
    expect(chart.studies.get(a.id)!.visible).toBe(true);
    chart.interval = '1h';
    chart.load(makeBars(30, 3600));
    expect(chart.studies.get(a.id)!.visible).toBe(false);

    ctl.sync([{ ...vis, placement: 'own' }]);
    expect(chart.studies.get(a.id)!.paneId).toBe(`pane-${a.id}`);
    expect(useIndicatorRuntime.getState().panes[a.id]).toBe(`pane-${a.id}`);

    ctl.setHidden(true);
    ctl.sync([]);
    expect(chart.studies.has(a.id)).toBe(false);
    expect(log.at(-1)).toEqual({ type: 'remove', id: a.id });
  });

  it('draws volume in the price pane on its own scale, on the pane scale elsewhere', async () => {
    const { chart, ctl } = setup();
    const vol = inst('volume', {}, { placement: 'main' });
    const ma = inst('sma', { length: 3, source: { instanceId: vol.id, outputId: 'volume' } });
    ctl.sync([vol, ma]);
    chart.load(makeBars(30));
    await settle();
    expect(chart.studies.get(vol.id)!.paneId).toBe('main');
    expect(chart.studies.get(vol.id)!.spec.priceScale).toBe('none');
    // An indicator on Volume in the price pane must not squash the price scale either.
    expect(chart.studies.get(ma.id)!.spec.priceScale).toBe('none');
    ctl.sync([{ ...vol, placement: 'own' }, ma]);
    expect(chart.studies.get(vol.id)!.paneId).toBe(`pane-${vol.id}`);
    expect(chart.studies.get(vol.id)!.spec.priceScale).toBe('pane');
    // The dependent stays where it is (in the price pane), so keeps its own scale.
    expect(chart.studies.get(ma.id)!.paneId).toBe('main');
    expect(chart.studies.get(ma.id)!.spec.priceScale).toBe('none');
    ctl.sync([vol, ma]);
    expect(chart.studies.get(vol.id)!.paneId).toBe('main');
    expect(chart.studies.get(vol.id)!.spec.priceScale).toBe('none');
    // Price-scaled studies stay on the pane scale.
    const sma = inst('sma', { length: 5 });
    ctl.sync([vol, ma, sma]);
    expect(chart.studies.get(sma.id)!.spec.priceScale).toBe('pane');
  });

  it('runs indicator-on-indicator on the source pane', async () => {
    const { chart, ctl } = setup();
    const rsiLike = inst('ema', { length: 4 }, { placement: 'own' });
    const sma = inst('sma', { length: 3, source: { instanceId: rsiLike.id, outputId: 'ema' } });
    ctl.sync([rsiLike, sma]);
    const bars = makeBars(50);
    chart.load(bars);
    await settle();
    expect(chart.studies.get(sma.id)!.paneId).toBe(`pane-${rsiLike.id}`);
    expect(chart.studies.get(sma.id)!.spec.title).toBe('SMA 3 EMA: EMA');
    const ema = reference('ema', { length: 4 }, bars, 'ema');
    const n = ema.length;
    const src = { ...bars, close: Float64Array.from(ema) };
    expect(chart.studies.get(sma.id)!.values.ma).toEqual(
      reference('sma', { length: 3 }, { ...src, time: bars.time.slice(0, n) }, 'ma'),
    );
  });

  it('fetches higher-timeframe bars for timeframe inputs and aligns them', async () => {
    const weekly = makeBars(20, 7 * DAY, START - 7 * DAY * 4, 3);
    const feed = stubFeed(() => weekly);
    const { chart, log, ctl } = setup({ feed });
    const tf = inst('test_tf_close');
    ctl.sync([tf]);
    expect(log.filter((m) => m.type !== 'context')[0]).toEqual({
      type: 'timeframeMap',
      map: { auto: '1W' },
    });
    expect(log.filter((m) => m.type === 'context').at(-1)).toEqual({
      type: 'context',
      context: {
        timezone: 'UTC',
        session: null,
        intervalSeconds: DAY,
        timeframeSeconds: { '1W': 7 * DAY },
      },
    });
    const daily = makeBars(40);
    chart.load(daily);
    await settle();
    await settle();
    expect(feed.requests[0]!.interval).toEqual({ unit: 'week', count: 1 });
    const s = chart.studies.get(tf.id)!;
    expect(useIndicatorRuntime.getState().status[tf.id]).toEqual({ state: 'ok' });
    for (const j of [0, 6, 7, 39]) {
      let k = 0;
      while (k + 1 < weekly.time.length && weekly.time[k + 1]! <= daily.time[j]!) k++;
      expect(s.values.v![j]).toBe(weekly.close[k]);
    }
  });

  it('sends the exchange timezone with the bars of a new symbol, once per change', async () => {
    const { chart, log, ctl } = setup();
    ctl.sync([inst('vwap')]);
    chart.symbolInfo = {
      symbol: 'AAPL',
      name: 'Apple',
      exchange: 'NMS',
      exchangeName: 'NasdaqGS',
      type: 'EQUITY',
      currency: 'USD',
      timezone: 'America/New_York',
      session: '0930-1600',
      priceHint: 2,
      minTick: 0.01,
    };
    const before = log.length;
    chart.load(makeBars(10));
    await settle();
    // No standalone context in the reset (it would recompute on the old bars first).
    const reset = log.slice(before);
    expect(reset.filter((m) => m.type === 'context')).toEqual([]);
    const bars = reset.find((m) => m.type === 'bars')!;
    expect(bars).toMatchObject({
      context: { timezone: 'America/New_York', session: '0930-1600' },
    });
    const withContext = () =>
      log.filter((m) => m.type === 'context' || (m.type === 'bars' && m.context));
    const n = withContext().length;
    chart.load(makeBars(12));
    await settle();
    expect(withContext()).toHaveLength(n);
  });

  it('WorkerCore applies a context sent with bars in one computation', () => {
    const out: FromWorker[] = [];
    const core = new WorkerCore((m) => out.push(m));
    core.handle({ type: 'add', spec: { id: 'v', type: 'vwap' } });
    core.handle({ type: 'bars', revision: 1, bars: makeBars(30, 3600) });
    out.length = 0;
    core.handle({
      type: 'bars',
      revision: 2,
      bars: makeBars(30, 3600),
      context: { timezone: 'America/New_York', intervalSeconds: 3600 },
    });
    const results = out.filter((m) => m.type === 'results');
    expect(results).toHaveLength(1);
    // Same as computing with the context known from the start.
    const ref: FromWorker[] = [];
    const fresh = new WorkerCore((m) => ref.push(m));
    fresh.handle({
      type: 'context',
      context: { timezone: 'America/New_York', intervalSeconds: 3600 },
    });
    fresh.handle({ type: 'add', spec: { id: 'v', type: 'vwap' } });
    fresh.handle({ type: 'bars', revision: 1, bars: makeBars(30, 3600) });
    expect(results[0]).toEqual({ ...ref.filter((m) => m.type === 'results').at(-1)!, revision: 2 });
  });

  it('reports worker errors for an instance and resyncs bars after a bad tick', async () => {
    const { chart, log, ctl, frame, onError } = setup();
    const bad = { ...inst('sma'), inputs: { length: 'x' } as InputValueMap };
    ctl.sync([bad]);
    chart.load(makeBars(10));
    await settle();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('SMA'));
    expect(useIndicatorRuntime.getState().status[bad.id]?.state).toBe('error');

    // An index the worker cannot apply makes the controller resend all bars.
    const port = log.length;
    chart.emit('seriesChange', { kind: 'update', revision: chart.seriesRevision, index: 3 });
    frame();
    await settle();
    expect(log.slice(port).map((m) => m.type)).toEqual(['bar', 'bars']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('coalesces resyncs: several bad bars in flight cause one resend', async () => {
    const { chart, log, ctl, frame, onError } = setup();
    ctl.sync([inst('sma', { length: 3 })]);
    chart.load(makeBars(10));
    await settle();
    const port = log.length;
    const revision = chart.seriesRevision;
    chart.emit('seriesChange', { kind: 'update', revision, index: 3 });
    chart.emit('seriesChange', { kind: 'update', revision, index: 5 });
    frame();
    await settle();
    expect(log.slice(port).map((m) => m.type)).toEqual(['bar', 'bar', 'bars']);
    expect(onError).not.toHaveBeenCalled();
  });

  it('gives up after repeated resyncs and reports fatal worker errors once', async () => {
    let port!: ReturnType<typeof manualWorker>;
    const { chart, log, ctl, onError } = setup({
      worker: (l) => (port = manualWorker(l)),
    });
    ctl.sync([inst('sma', { length: 3 })]);
    chart.load(makeBars(10));
    const revision = chart.seriesRevision;
    const resends = () => log.filter((m) => m.type === 'bars').length;
    expect(resends()).toBe(1);
    for (let k = 1; k <= 5; k++) port.reply({ type: 'resync', revision, bars: resends() });
    expect(resends()).toBe(4); // MAX_RESYNCS = 3
    expect(onError).toHaveBeenCalledTimes(1);
    // Fatal (id-less) errors: one toast, no resend loop.
    port.reply({ type: 'error', message: 'Indicator worker failed: boom' });
    port.reply({ type: 'error', message: 'Indicator worker failed: boom' });
    expect(resends()).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a fatal error once when the worker crashes', async () => {
    let port!: ReturnType<typeof manualWorker>;
    const { chart, log, ctl, onError } = setup({ worker: (l) => (port = manualWorker(l)) });
    ctl.sync([inst('sma', { length: 3 })]);
    chart.load(makeBars(10));
    port.reply({ type: 'error', message: 'Indicator worker failed: load' });
    port.reply({ type: 'error', message: 'Indicator worker failed: load' });
    port.reply({ type: 'resync', revision: chart.seriesRevision, bars: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('Indicator worker failed: load');
    expect(log.filter((m) => m.type === 'bars')).toHaveLength(1);
  });

  it('WorkerCore never throws: handler failures become one fatal error', () => {
    const out: FromWorker[] = [];
    const core = new WorkerCore((m) => out.push(m));
    expect(() => core.handle({ type: 'bars', revision: 1, bars: null as never })).not.toThrow();
    expect(out).toEqual([{ type: 'error', message: expect.stringContaining('Indicator worker') }]);
    out.length = 0;
    core.handle({ type: 'bars', revision: 2, bars: makeBars(5) });
    core.handle({ type: 'bar', revision: 2, index: 9, bar: makeBar(9) });
    expect(out).toEqual([{ type: 'resync', revision: 2, bars: 2 }]);
  });

  it('resends all bars on a history prepend', async () => {
    const { chart, log, ctl } = setup();
    ctl.sync([inst('sma', { length: 3 })]);
    chart.load(makeBars(10));
    await settle();
    const port = log.length;
    chart.seriesRevision++;
    chart.emit('seriesChange', { kind: 'prepend', revision: 2, length: 10, added: 3 });
    expect(log.slice(port)).toMatchObject([{ type: 'bars', revision: 2 }]);
  });

  it('removes instances whose pane the user removed', async () => {
    const { chart, log, ctl } = setup({ lost: true });
    const rsi = addIndicator('rsi')!;
    const ma = addIndicator('sma', { sourceOf: { instanceId: rsi, outputId: 'rsi' } })!;
    const main = addIndicator('ema')!;
    const sync = () => ctl.sync(useIndicatorStore.getState().instances);
    sync();
    const off = useIndicatorStore.subscribe(sync);
    chart.load(makeBars(30));
    await settle();
    expect(chart.studies.get(ma)!.paneId).toBe(`pane-${rsi}`);
    chart.removePane(`pane-${rsi}`);
    expect(useIndicatorStore.getState().instances.map((i) => i.id)).toEqual([main]);
    expect(log.filter((m) => m.type === 'remove').map((m) => 'id' in m && m.id)).toEqual([rsi, ma]);
    expect(useIndicatorRuntime.getState().panes).toEqual({ [main]: 'main' });
    expect(chart.studies.has(ma)).toBe(false); // never re-added on the way
    expect(log.filter((m) => m.type === 'add')).toHaveLength(3);
    // One undo step brings both back, in the pane.
    useHistory.getState().undo();
    expect(chart.studies.get(ma)!.paneId).toBe(`pane-${rsi}`);
    off();
  });

  it('keeps own-pane studies in place across placement changes and undo', async () => {
    const { chart, ctl, onError } = setup();
    const rsi = inst('rsi');
    const ma = inst('sma', { length: 3, source: { instanceId: rsi.id, outputId: 'rsi' } });
    ctl.sync([rsi, ma]);
    chart.load(makeBars(40));
    await settle();
    const pane = `pane-${rsi.id}`;
    expect(chart.studies.get(ma.id)!.paneId).toBe(pane);
    // auto -> own for a pane indicator already in its own pane.
    ctl.sync([{ ...rsi, placement: 'own' }, ma]);
    expect(chart.studies.get(rsi.id)!.paneId).toBe(pane);
    ctl.sync([rsi, ma]);
    // Remove RSI (its SMA keeps the pane alive), then undo.
    ctl.sync([ma]);
    expect(chart.panes).toContain(pane);
    ctl.sync([rsi, ma]);
    await settle();
    expect(onError).not.toHaveBeenCalled();
    expect(chart.studies.get(rsi.id)!.paneId).toBe(pane);
    expect(chart.studies.get(rsi.id)!.revision).toBe(chart.seriesRevision);
  });

  it('re-adds studies after the chart cleared them (setState)', async () => {
    const { chart, log, ctl, onError } = setup();
    const rsi = inst('rsi');
    const ema = inst('ema');
    ctl.sync([rsi, ema]);
    chart.load(makeBars(40));
    await settle();
    const port = log.length;
    chart.clearStudies();
    expect(chart.studies.get(rsi.id)!.paneId).toBe(`pane-${rsi.id}`);
    expect(chart.studies.get(ema.id)!.paneId).toBe('main');
    expect(log.slice(port).map((m) => m.type)).toEqual(['remove', 'remove', 'add', 'add']);
    await settle();
    expect(chart.studies.get(rsi.id)!.revision).toBe(chart.seriesRevision);
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries a timeframe series that came back empty', async () => {
    const weekly = makeBars(20, 7 * DAY, START - 7 * DAY * 4, 3);
    let calls = 0;
    const feed = stubFeed(() => (calls++ === 0 ? makeBars(0) : weekly));
    const { chart, ctl } = setup({ feed });
    const tf = inst('test_tf_close');
    ctl.sync([tf]);
    chart.load(makeBars(40));
    await settle();
    await settle();
    expect(feed.requests).toHaveLength(1);
    expect(useIndicatorRuntime.getState().status[tf.id]?.state).toBe('waiting');
    chart.load(makeBars(40));
    await settle();
    await settle();
    expect(feed.requests).toHaveLength(2);
    expect(useIndicatorRuntime.getState().status[tf.id]).toEqual({ state: 'ok' });
  });
});

function makeBar(i: number): Bar {
  return { time: START + i * DAY, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 };
}

function daysOnly() {
  const r = (enabled: boolean, min: number, max: number) => ({ enabled, min, max });
  return {
    seconds: r(false, 1, 59),
    minutes: r(false, 1, 59),
    hours: r(false, 1, 24),
    days: r(true, 1, 366),
    weeks: r(false, 1, 52),
    months: r(false, 1, 12),
  };
}

/** Feed serving `series[symbol]` and recording live subscriptions. */
function symbolFeed(series: Record<string, BarColumns>) {
  const live = new Map<string, (bar: Bar) => void>();
  const requests: GetBarsRequest[] = [];
  const feed: DataFeed = {
    resolveSymbol: (symbol) =>
      symbol in series
        ? Promise.resolve({ symbol, timezone: null, session: null } as SymbolInfo)
        : Promise.reject(new Error(`Unknown symbol ${symbol}`)),
    searchSymbols: () => Promise.resolve([]),
    getBars: (req) => {
      requests.push(req);
      return Promise.resolve({ bars: series[req.symbol]!, hasMore: false });
    },
    subscribe: (req, _last, onBar) => {
      live.set(req.symbol, onBar);
      return () => live.delete(req.symbol);
    },
  };
  return { feed, live, requests };
}

describe('external symbols', () => {
  const corr = (symbol = 'GOOG') => inst('correlation', { symbol, length: 5 });
  /** Values of the correlation as the runtime computes them on aligned bars. */
  const expected = (chart: BarColumns, ext: BarColumns) => {
    const rt = new IndicatorRuntime();
    rt.add({ id: 'x', type: 'correlation', inputs: { symbol: 'GOOG', length: 5 } });
    rt.setBars(chart);
    rt.setExternal('GOOG', ext);
    const r = rt.result('x')!;
    return Array.from(r.values['cc']!.subarray(0, r.length));
  };

  it('fetches the required symbol, aligns it and computes the indicator', async () => {
    const main = makeBars(60);
    const other = makeBars(60, DAY, START, 5);
    const { feed, requests } = symbolFeed({ GOOG: other });
    const { chart, log, ctl, onError } = setup({ feed });
    const cc = corr();
    ctl.sync([cc]);
    chart.load(main);
    await settle();
    await settle();
    await settle();
    expect(requests.map((r) => r.symbol)).toEqual(['GOOG']);
    expect(log.some((m) => m.type === 'extBars' && m.symbol === 'GOOG')).toBe(true);
    expect(useIndicatorRuntime.getState().status[cc.id]).toEqual({ state: 'ok' });
    expect(chart.studies.get(cc.id)!.values['cc']).toEqual(expected(main, other));
    expect(onError).not.toHaveBeenCalled();
  });

  it('shows waiting with the symbol until its bars arrive', async () => {
    const other = makeBars(60, DAY, START, 5);
    const gate = symbolFeed({ GOOG: other });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const feed: DataFeed = {
      ...gate.feed,
      getBars: async (req) => {
        await held;
        return gate.feed.getBars(req);
      },
    };
    const { chart, ctl } = setup({ feed });
    const cc = corr();
    ctl.sync([cc]);
    chart.load(makeBars(60));
    await settle();
    expect(useIndicatorRuntime.getState().status[cc.id]).toEqual({
      state: 'waiting',
      timeframe: '',
      symbol: 'GOOG',
    });
    release();
    for (let i = 0; i < 4; i++) await settle();
    expect(useIndicatorRuntime.getState().status[cc.id]).toEqual({ state: 'ok' });
  });

  it('keeps dependents in step with live bars of either series', async () => {
    const main = makeBars(60);
    const other = makeBars(60, DAY, START, 5);
    const { feed, live } = symbolFeed({ GOOG: other });
    const { chart, ctl, frame } = setup({ feed });
    const cc = corr();
    ctl.sync([cc]);
    chart.load(main);
    for (let i = 0; i < 4; i++) await settle();
    // Overlay tick on its last bar, then an append on the chart without a new overlay bar.
    const o = live.get('GOOG')!;
    const lastOther = {
      time: other.time[59]!,
      open: other.open[59]!,
      high: other.high[59]! + 3,
      low: other.low[59]!,
      close: other.close[59]! + 2,
      volume: 5,
    };
    o(lastOther);
    frame();
    const next = { time: START + 60 * DAY, open: 100, high: 103, low: 99, close: 101, volume: 9 };
    chart.tick(next);
    frame();
    for (let i = 0; i < 3; i++) await settle();
    expect(useIndicatorRuntime.getState().status[cc.id]).toEqual({ state: 'ok' });
    const study = chart.studies.get(cc.id)!;
    expect(study.length).toBe(61);
    // Reference: a fresh runtime on the final aligned data (the overlay carries forward).
    const rt = new IndicatorRuntime();
    rt.add({ id: 'x', type: 'correlation', inputs: { symbol: 'GOOG', length: 5 } });
    const st = chart.store;
    const cols = (k: keyof BarColumns) => st[k].slice(0, 61);
    rt.setBars({
      time: cols('time'),
      open: cols('open'),
      high: cols('high'),
      low: cols('low'),
      close: cols('close'),
      volume: cols('volume'),
    });
    const ext = (k: keyof BarColumns) => {
      const a = new Float64Array(61);
      a.set(other[k]);
      a[59] = k === 'close' ? lastOther.close : k === 'high' ? lastOther.high : a[59]!;
      a[60] = a[59]!;
      return a;
    };
    rt.setExternal('GOOG', {
      time: cols('time'),
      open: ext('open'),
      high: ext('high'),
      low: ext('low'),
      close: ext('close'),
      volume: ext('volume'),
    });
    expect(study.values['cc']).toEqual(Array.from(rt.result('x')!.values['cc']!.subarray(0, 61)));
  });

  it('errors on brick charts and for symbols that fail to load', async () => {
    const other = makeBars(60, DAY, START, 5);
    const { feed } = symbolFeed({ GOOG: other });
    const brick = setup({ feed, chartType: () => 'renko' });
    const cc = corr();
    brick.ctl.sync([cc]);
    brick.chart.load(makeBars(60));
    await settle();
    await settle();
    expect(useIndicatorRuntime.getState().status[cc.id]).toEqual({
      state: 'error',
      message: 'GOOG: External symbols are not available on this chart type',
    });

    useIndicatorRuntime.setState({ status: {}, panes: {}, tick: 0 });
    const bad = setup({ feed });
    const nope = corr('NOPE');
    bad.ctl.sync([nope]);
    bad.chart.load(makeBars(60));
    for (let i = 0; i < 4; i++) await settle();
    expect(useIndicatorRuntime.getState().status[nope.id]).toEqual({
      state: 'error',
      message: 'NOPE: Unknown symbol NOPE',
    });
    expect(bad.onError).toHaveBeenCalledWith('Could not load NOPE: Unknown symbol NOPE');
  });

  it('computes an SMA sourced from an overlay symbol', async () => {
    const other = makeBars(60, DAY, START, 5);
    const { feed } = symbolFeed({ GOOG: other });
    const { chart, ctl } = setup({ feed });
    const ma = inst('sma', {
      length: 3,
      source: { instanceId: 'sym:GOOG', outputId: 'close' },
    });
    ctl.sync([ma]);
    chart.load(makeBars(60));
    for (let i = 0; i < 4; i++) await settle();
    expect(useIndicatorRuntime.getState().status[ma.id]).toEqual({ state: 'ok' });
    expect(chart.studies.get(ma.id)!.spec.title).toBe('SMA 3 GOOG: Close');
    expect(chart.studies.get(ma.id)!.values['ma']).toEqual(
      reference('sma', { length: 3 }, other, 'ma'),
    );
  });
});

describe('user script instances', () => {
  const UT = 'user:ctl-test';
  const stub = () =>
    defineIndicator({
      id: UT,
      name: 'Ctl',
      shortName: 'CTL',
      category: 'other',
      overlay: true,
      inputs: {},
      outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
      setup: () => (c) => c.set('v', c.close[c.i]!),
    });
  const status = (id: string) => useIndicatorRuntime.getState().status[id];

  it('uses the script problem message for a missing definition', () => {
    defaultRegistry.unregister(UT);
    const { ctl } = setup();
    const a = { ...inst('sma'), id: 'u_gone', type: UT };
    useScriptsStore.setState({ scripts: [], loaded: true });
    ctl.sync([a]);
    expect(status(a.id)).toEqual({ state: 'error', message: 'Script deleted' });
    useScriptsStore.setState({ scripts: [], loaded: false });
    ctl.sync([a]);
    expect(status(a.id)).toEqual({ state: 'error', message: `Unknown indicator "${UT}"` });
    const b = { ...a, id: 'u_gone2', type: 'nope' };
    ctl.sync([b]);
    expect(status(b.id)).toEqual({ state: 'error', message: 'Unknown indicator "nope"' });
  });

  it('refuses the instance over the per-chart cap', () => {
    defaultRegistry.unregister(UT);
    defaultRegistry.register(stub());
    const { chart, ctl } = setup();
    const list = Array.from({ length: MAX_SCRIPT_INSTANCES_PER_CHART + 1 }, () =>
      createInstance(getIndicator(UT)!, undefined),
    );
    ctl.sync(list);
    for (const i of list.slice(0, MAX_SCRIPT_INSTANCES_PER_CHART))
      expect(chart.studies.has(i.id)).toBe(true);
    const over = list[MAX_SCRIPT_INSTANCES_PER_CHART]!;
    expect(chart.studies.has(over.id)).toBe(false);
    expect(status(over.id)).toEqual({ state: 'error', message: SCRIPT_INSTANCE_CAP_MESSAGE });
    // Room again after a removal.
    ctl.sync(list.slice(1));
    expect(chart.studies.has(over.id)).toBe(true);
    defaultRegistry.unregister(UT);
  });
});
