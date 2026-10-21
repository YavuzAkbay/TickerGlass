import {
  ExpressionFeed,
  SeriesStore,
  type Bar,
  type BarColumns,
  type BarListener,
  type ChartEvents,
  type ChartState,
  type ChartType,
  type DataFeed,
  type GetBarsRequest,
  type GetBarsResult,
  type StudyData,
  type StudyDataPatch,
  type StudyInfo,
  type StudySpec,
  type StudyTarget,
  type SubscribeRequest,
  type SymbolInfo,
} from '@investopen/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistory } from '../commands/history';
import { removeCompares } from './actions';
import { CompareController, type CompareHost } from './controller';
import type { CompareState } from './model';
import { useCompareRuntime, useCompareStore } from './store';

const DAY = 86_400;
const HOUR = 3_600;

function cols(time: number[], close: number[]): BarColumns {
  const f = (a: number[]) => Float64Array.from(a);
  return {
    time: f(time),
    open: f(close),
    high: f(close),
    low: f(close),
    close: f(close),
    volume: f(time.map(() => 0)),
  };
}

const bar = (time: number, close: number): Bar => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

// Daily goldens (design §8 U1): AAPL Jan 2,3,4,5,8 2024 at New York midnight;
// BTC-USD Jan 1..8 at UTC midnight.
const AAPL_T = [1704171600, 1704258000, 1704344400, 1704430800, 1704690000];
const AAPL_C = [185, 184, 182, 181, 185];
const BTC_T = Array.from({ length: 8 }, (_, k) => 1704067200 + k * DAY);
const BTC_C = BTC_T.map((_, k) => 100 + k);

function info(symbol: string, timezone: string | null, priceHint = 2): SymbolInfo {
  return {
    symbol,
    name: symbol,
    exchange: null,
    exchangeName: null,
    type: null,
    currency: 'USD',
    timezone,
    session: null,
    priceHint,
    minTick: 10 ** -priceHint,
  };
}

interface FakeStudy {
  spec: StudySpec;
  paneId: string;
  visible: boolean;
  revision: number;
  length: number;
  values: number[];
  sets: number;
  patches: StudyDataPatch[];
}

class FakeChart implements CompareHost {
  readonly store = new SeriesStore();
  symbolInfo: SymbolInfo | null = info('AAPL', 'America/New_York');
  seriesRevision = 0;
  symbol = 'AAPL';
  interval = '1D';
  mode: ChartState['panes'][number]['priceScale']['mode'] = 'linear';
  studies = new Map<string, FakeStudy>();
  panes = ['main'];
  private listeners = new Map<string, Set<(p: unknown) => void>>();

  getSymbol() {
    return this.symbol;
  }
  getInterval() {
    return this.interval;
  }
  getState(): ChartState {
    return {
      panes: this.panes.map((id) => ({
        id,
        ratio: 1,
        collapsed: false,
        priceScale: { mode: id === 'main' ? this.mode : 'linear', autoScale: true, invert: false },
      })),
    } as ChartState;
  }
  setPriceScaleMode(_paneId: string, mode: typeof this.mode): void {
    this.mode = mode;
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

  load(c: BarColumns): void {
    this.store.setAll(c);
    this.seriesRevision++;
    this.emit('seriesChange', {
      kind: 'reset',
      revision: this.seriesRevision,
      length: this.store.length,
    });
  }
  prependBars(c: BarColumns): void {
    const added = this.store.prepend(c);
    this.seriesRevision++;
    this.emit('seriesChange', {
      kind: 'prepend',
      revision: this.seriesRevision,
      length: this.store.length,
      added,
    });
  }
  tick(b: Bar): void {
    const r = this.store.upsert(b);
    if (r === 'ignored') return;
    this.emit('seriesChange', {
      kind: r,
      revision: this.seriesRevision,
      index: this.store.length - 1,
    });
  }

  private paneOf(target: StudyTarget): string {
    if ('paneId' in target) {
      if (!this.panes.includes(target.paneId)) throw new Error(`Unknown pane: ${target.paneId}`);
      return target.paneId;
    }
    const id = target.newPane.id ?? `new-${this.panes.length}`;
    if (!this.panes.includes(id)) this.panes.push(id);
    return id;
  }
  private dropIfEmpty(paneId: string): void {
    if (paneId === 'main' || [...this.studies.values()].some((s) => s.paneId === paneId)) return;
    this.panes = this.panes.filter((p) => p !== paneId);
    this.emit('paneRemoved', { paneId, studyIds: [] });
  }
  removePane(paneId: string): void {
    const ids = [...this.studies.values()].filter((s) => s.paneId === paneId).map((s) => s.spec.id);
    this.panes = this.panes.filter((p) => p !== paneId);
    for (const id of ids) this.studies.delete(id);
    if (ids.length) this.emit('paneRemoved', { paneId, studyIds: ids });
  }
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
      values: [],
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
    s.values = Array.from(data.values.close!.subarray(0, data.length));
  }
  updateStudyData(id: string, patch: StudyDataPatch): void {
    const s = this.studies.get(id)!;
    if (patch.revision !== s.revision || patch.from > s.length) return;
    s.patches.push(patch);
    s.length = patch.length;
    s.values.length = patch.from;
    s.values.push(...patch.values.close!);
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

interface Sub {
  req: SubscribeRequest;
  last: Bar | null;
  onBar: BarListener;
  closed: boolean;
}

/** Feed serving fixed series per symbol|interval; `to`/`limit` honoured. */
function fakeFeed(series: Record<string, BarColumns>, infos: Record<string, SymbolInfo> = {}) {
  const requests: GetBarsRequest[] = [];
  const subs: Sub[] = [];
  const feed: DataFeed = {
    resolveSymbol: async (symbol) => {
      const i = infos[symbol] ?? (series[`${symbol}|1D`] ? info(symbol, 'UTC') : null);
      if (!i) throw new Error(`Unknown symbol: ${symbol}`);
      return i;
    },
    searchSymbols: async () => [],
    getBars: async (req): Promise<GetBarsResult> => {
      requests.push(req);
      const key = `${req.symbol}|${req.interval.count}${req.interval.unit}`;
      const s = series[key] ?? series[`${req.symbol}|1D`];
      if (!s) throw new Error(`Unknown symbol: ${req.symbol}`);
      let end = s.time.length;
      if (req.to !== undefined) while (end > 0 && s.time[end - 1]! >= req.to) end--;
      const start = Math.max(0, end - req.limit);
      const sub = (a: Float64Array) => a.slice(start, end);
      return {
        bars: {
          time: sub(s.time),
          open: sub(s.open),
          high: sub(s.high),
          low: sub(s.low),
          close: sub(s.close),
          volume: sub(s.volume),
        },
        hasMore: start > 0,
      };
    },
    subscribe: (req, last, onBar) => {
      const sub: Sub = { req, last, onBar, closed: false };
      subs.push(sub);
      return () => {
        sub.closed = true;
      };
    },
  };
  return { feed, requests, subs };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const cmp = (id: string, symbol: string, patch: Partial<CompareState> = {}): CompareState => ({
  id,
  symbol,
  placement: 'same',
  visible: true,
  color: '#E0A93B',
  lineWidth: 2,
  ...patch,
});

function setup(
  f = fakeFeed({ 'BTC-USD|1D': cols(BTC_T, BTC_C) }),
  opts: { chartType?: ChartType; lost?: boolean; dataEpoch?: () => number } = {},
) {
  const chart = new FakeChart();
  const frames: (() => void)[] = [];
  const onError = vi.fn();
  let chartType: ChartType = opts.chartType ?? 'candles';
  const ctl = new CompareController({
    chart,
    runtime: useCompareRuntime,
    feed: f.feed,
    schedule: (fn) => frames.push(fn),
    onError,
    ...(opts.lost ? { onLost: removeCompares } : {}),
    prepost: () => false,
    chartType: () => chartType,
    ...(opts.dataEpoch ? { dataEpoch: opts.dataEpoch } : {}),
  });
  const frame = () => frames.splice(0).forEach((fn) => fn());
  return { chart, ctl, frame, onError, ...f, setType: (t: ChartType) => (chartType = t) };
}

beforeEach(() => {
  useCompareRuntime.setState({ status: {}, info: {}, tick: 0 });
  useCompareStore.setState({ items: [], scaleRestore: null });
  useHistory.getState().clear();
});

describe('CompareController', () => {
  it('pushes the overlay aligned to the main calendar with the chart revision', async () => {
    const { chart, ctl, requests } = setup();
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    expect(useCompareRuntime.getState().status['cmp-a']).toEqual({ state: 'loading' });
    chart.load(cols(AAPL_T, AAPL_C));
    await settle();
    const s = chart.studies.get('cmp-a')!;
    expect(s.revision).toBe(chart.seriesRevision);
    expect(s.values).toEqual([101, 102, 103, 104, 107]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ symbol: 'BTC-USD', prepost: false });
    expect(requests[0]!.to).toBeUndefined();
    expect(useCompareRuntime.getState().status['cmp-a']).toEqual({ state: 'ready' });
    expect(useCompareRuntime.getState().info['cmp-a']!.symbol).toBe('BTC-USD');
  });

  it('overlays symbol expressions through ExpressionFeed', async () => {
    const f = fakeFeed(
      {
        'BTC-USD|1D': cols(BTC_T, BTC_C),
        'ETH-USD|1D': cols(
          BTC_T,
          BTC_C.map((c) => c / 2),
        ),
      },
      { 'BTC-USD': info('BTC-USD', 'UTC'), 'ETH-USD': info('ETH-USD', 'UTC') },
    );
    const { chart, ctl } = setup({ ...f, feed: new ExpressionFeed(f.feed) });
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-e', 'BTC-USD/ETH-USD', { placement: 'pane' })]);
    for (let i = 0; i < 5; i++) await settle();
    expect(chart.studies.get('cmp-e')!.values).toEqual([2, 2, 2, 2, 2]);
    expect(useCompareRuntime.getState().info['cmp-e']).toMatchObject({
      exchangeName: 'Expression',
      priceHint: 4,
    });
    expect(chart.studies.get('cmp-e')!.spec.precision).toBe(4);
  });

  it('describes the study per placement, with the overlay precision', async () => {
    const f = fakeFeed(
      { 'BTC-USD|1D': cols(BTC_T, BTC_C) },
      { 'BTC-USD': info('BTC-USD', 'UTC', 5) },
    );
    const { chart, ctl } = setup(f);
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([
      cmp('cmp-s', 'BTC-USD', { color: '#123456', lineWidth: 3 }),
      cmp('cmp-o', 'BTC-USD', { placement: 'own' }),
      cmp('cmp-p', 'BTC-USD', { placement: 'pane', visible: false }),
    ]);
    await settle();
    const spec = (id: string) => chart.studies.get(id)!.spec;
    expect(spec('cmp-s')).toMatchObject({
      title: 'BTC-USD',
      target: { paneId: 'main' },
      format: 'price',
      precision: 5,
      priceScale: 'pane',
      compare: true,
      outputs: [
        { id: 'close', kind: 'line', colors: ['#123456'], lineWidth: 3, showLastValue: true },
      ],
    });
    expect(spec('cmp-o')).toMatchObject({ priceScale: 'own', compare: false });
    expect(spec('cmp-p')).toMatchObject({
      target: { newPane: { id: 'pane-cmp-p' } },
      priceScale: 'pane',
      compare: false,
    });
    expect(chart.studies.get('cmp-p')!.paneId).toBe('pane-cmp-p');
    expect(chart.studies.get('cmp-p')!.visible).toBe(false);
    for (const id of ['cmp-s', 'cmp-o', 'cmp-p'])
      expect(chart.studies.get(id)!.values).toEqual([101, 102, 103, 104, 107]);

    // Placement, style and visibility changes.
    ctl.sync([
      cmp('cmp-s', 'BTC-USD', { placement: 'pane', color: '#654321' }),
      cmp('cmp-o', 'BTC-USD', { placement: 'own', visible: false }),
      cmp('cmp-p', 'BTC-USD', { placement: 'same' }),
    ]);
    expect(chart.studies.get('cmp-s')).toMatchObject({
      paneId: 'pane-cmp-s',
      spec: { compare: false, priceScale: 'pane', outputs: [{ colors: ['#654321'] }] },
    });
    expect(chart.studies.get('cmp-o')!.visible).toBe(false);
    expect(chart.studies.get('cmp-p')).toMatchObject({
      paneId: 'main',
      visible: true,
      spec: { compare: true },
    });
    expect(chart.panes).toEqual(['main', 'pane-cmp-s']);
  });

  it('patches the tail on live main bars, from n - 1', async () => {
    const { chart, ctl, frame } = setup();
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    await settle();
    const s = chart.studies.get('cmp-a')!;
    chart.tick(bar(AAPL_T[4]!, 186));
    frame();
    expect(s.patches.at(-1)).toMatchObject({ revision: chart.seriesRevision, from: 4, length: 5 });
    // Jan 9 (New York) appended: BTC's last bar is Jan 8, within staleness.
    chart.tick(bar(AAPL_T[4]! + DAY, 187));
    frame();
    expect(s.patches.at(-1)).toMatchObject({ from: 5, length: 6 });
    expect(s.values).toEqual([101, 102, 103, 104, 107, 107]);
    // Coalesced: two ticks, one patch.
    const count = s.patches.length;
    chart.tick(bar(AAPL_T[4]! + DAY, 188));
    chart.tick(bar(AAPL_T[4]! + DAY, 189));
    frame();
    expect(s.patches.length).toBe(count + 1);
  });

  it('patches from the first affected main row on live overlay bars', async () => {
    const { chart, ctl, frame, subs } = setup();
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    await settle();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.req).toMatchObject({ symbol: 'BTC-USD', timezone: 'UTC' });
    expect(subs[0]!.last).toMatchObject({ time: BTC_T[7], close: 107 });
    const s = chart.studies.get('cmp-a')!;
    // Update of BTC Jan 8: affects main Jan 8 only.
    subs[0]!.onBar(bar(BTC_T[7]!, 110));
    frame();
    expect(s.patches.at(-1)).toMatchObject({ from: 4, length: 5 });
    expect(s.values).toEqual([101, 102, 103, 104, 110]);
    // A newer BTC bar (Jan 9) lands after the last main row: nothing to patch.
    subs[0]!.onBar(bar(BTC_T[7]! + DAY, 111));
    frame();
    expect(s.patches).toHaveLength(1);
    // The main row of Jan 9 then picks it up.
    chart.tick(bar(AAPL_T[4]! + DAY, 187));
    frame();
    expect(s.values).toEqual([101, 102, 103, 104, 110, 111]);
  });

  it('pages overlay history when the main series reaches further back', async () => {
    // 60 daily bars of each; the main chart shows the last 10, then prepends.
    const T = Array.from({ length: 60 }, (_, i) => 1704067200 + i * DAY);
    const main = cols(
      T,
      T.map((_, i) => 1000 + i),
    );
    const over = cols(
      T,
      T.map((_, i) => i),
    );
    const f = fakeFeed({ 'OVR|1D': over }, { OVR: info('OVR', 'UTC') });
    // The feed returns at most 30 bars per request.
    const getBars = f.feed.getBars.bind(f.feed);
    f.feed.getBars = (req) => getBars({ ...req, limit: Math.min(req.limit, 30) });
    const { chart, ctl, requests } = setup(f);
    chart.symbolInfo = info('AAPL', 'UTC');
    const slice = (c: BarColumns, a: number, b: number) =>
      cols(Array.from(c.time.subarray(a, b)), Array.from(c.close.subarray(a, b)));
    chart.load(slice(main, 50, 60));
    ctl.sync([cmp('cmp-a', 'OVR')]);
    await settle();
    // 30 bars cover the 10 main bars plus staleness: no paging yet.
    expect(requests).toHaveLength(1);
    const s = chart.studies.get('cmp-a')!;
    expect(s.values).toEqual(Array.from({ length: 10 }, (_, i) => 50 + i));
    const before = requests.length;
    chart.prependBars(slice(main, 0, 50));
    await settle();
    await settle();
    expect(requests.length).toBe(before + 1);
    expect(requests.at(-1)!.to).toBe(T[30]);
    expect(s.revision).toBe(chart.seriesRevision);
    expect(s.values).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it('extends an overlay that starts after the main series, at most 10 pages', async () => {
    const T = Array.from({ length: 400 }, (_, i) => 1704067200 + i * DAY);
    const over = cols(
      T,
      T.map((_, i) => i),
    );
    const f = fakeFeed({ 'OVR|1D': over }, { OVR: info('OVR', 'UTC') });
    // Every page short: the feed returns 30 bars per request.
    const getBars = f.feed.getBars.bind(f.feed);
    f.feed.getBars = (req) => getBars({ ...req, limit: Math.min(req.limit, 30) });
    const { chart, ctl, requests } = setup(f);
    chart.symbolInfo = info('AAPL', 'UTC');
    chart.load(
      cols(
        T,
        T.map(() => 1),
      ),
    );
    ctl.sync([cmp('cmp-a', 'OVR')]);
    for (let i = 0; i < 30; i++) await settle();
    expect(requests).toHaveLength(11);
    expect(requests.slice(1).every((r) => r.to !== undefined)).toBe(true);
    const s = chart.studies.get('cmp-a')!;
    expect(s.values.filter(Number.isFinite)).toHaveLength(330);
    expect(s.values.at(-1)).toBe(399);
  });

  it('keeps the overlay cache across main symbol changes; refetches on a new interval', async () => {
    const MSFT_C = [370, 371, 372, 373, 374];
    const hourly = Array.from({ length: 48 }, (_, i) => 1704171600 + i * HOUR);
    const f = fakeFeed({
      'BTC-USD|1D': cols(BTC_T, BTC_C),
      'BTC-USD|1hour': cols(
        hourly,
        hourly.map((_, i) => 40000 + i),
      ),
    });
    const { chart, ctl, requests, subs } = setup(f);
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    await settle();
    expect(requests).toHaveLength(1);
    const s = chart.studies.get('cmp-a')!;

    chart.symbol = 'MSFT';
    chart.load(cols([], []));
    chart.load(cols(AAPL_T, MSFT_C));
    await settle();
    expect(requests).toHaveLength(1);
    expect(s.revision).toBe(chart.seriesRevision);
    expect(s.values).toEqual([101, 102, 103, 104, 107]);

    chart.interval = '1h';
    chart.load(
      cols(
        hourly.slice(1, 10),
        hourly.slice(1, 10).map(() => 1),
      ),
    );
    await settle();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.interval).toEqual({ count: 1, unit: 'hour' });
    expect(subs[0]!.closed).toBe(true);
    expect(subs[1]!.closed).toBe(false);
    // Instant keys: each hour gets its own hourly close.
    expect(s.values).toEqual(Array.from({ length: 9 }, (_, i) => 40001 + i));
  });

  it('is unavailable on brick chart types (no data pushed)', async () => {
    const { chart, ctl, requests, setType } = setup(undefined, { chartType: 'renko' });
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    await settle();
    expect(requests).toHaveLength(0);
    expect(chart.studies.get('cmp-a')!.sets).toBe(0);
    expect(useCompareRuntime.getState().status['cmp-a']).toMatchObject({ state: 'unavailable' });
    setType('candles');
    chart.load(cols(AAPL_T, AAPL_C));
    await settle();
    expect(chart.studies.get('cmp-a')!.values).toEqual([101, 102, 103, 104, 107]);
    expect(useCompareRuntime.getState().status['cmp-a']).toEqual({ state: 'ready' });
  });

  it('reports fetch errors', async () => {
    const { chart, ctl, onError } = setup();
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-x', 'NOPE')]);
    await settle();
    expect(useCompareRuntime.getState().status['cmp-x']).toEqual({
      state: 'error',
      message: 'Unknown symbol: NOPE',
    });
    expect(onError).toHaveBeenCalledWith('Compare NOPE: Unknown symbol: NOPE');
  });

  it('keeps a failed overlay cached: no refetch or repeat toast on resets, retry on re-add', async () => {
    const { chart, ctl, onError, requests } = setup();
    chart.load(cols(AAPL_T, AAPL_C));
    const bad = cmp('cmp-x', 'NOPE');
    ctl.sync([bad]);
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    const n = requests.length;
    chart.load(cols(AAPL_T, AAPL_C));
    chart.prependBars(cols([AAPL_T[0]! - DAY], [1]));
    ctl.sync([{ ...bad, color: '#112233' }]);
    await settle();
    expect(requests.length).toBe(n);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(useCompareRuntime.getState().status['cmp-x']).toMatchObject({ state: 'error' });
    ctl.sync([]);
    ctl.sync([cmp('cmp-y', 'NOPE')]);
    await settle();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a removed pane drops its overlay through onLost, in the same dispatch', async () => {
    const { chart, ctl } = setup(undefined, { lost: true });
    chart.load(cols(AAPL_T, AAPL_C));
    const item = cmp('cmp-p', 'BTC-USD', { placement: 'pane' });
    useCompareStore.setState({ items: [item] });
    useCompareStore.subscribe((st) => ctl.sync(st.items));
    ctl.sync([item]);
    await settle();
    let inDispatch: number | null = null;
    chart.on('paneRemoved', () => (inDispatch = useCompareStore.getState().items.length));
    chart.removePane('pane-cmp-p');
    expect(inDispatch).toBe(0);
    expect(useHistory.getState().past.map((e) => e.label)).toEqual(['Remove compare BTC-USD']);
    // Undo re-adds it to its own pane.
    useHistory.getState().undo();
    expect(chart.studies.get('cmp-p')!.paneId).toBe('pane-cmp-p');
    await settle();
    expect(chart.studies.get('cmp-p')!.values).toEqual([101, 102, 103, 104, 107]);
  });

  it('re-adds overlays (with data) when setState clears the studies', async () => {
    const { chart, ctl } = setup();
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-a', 'BTC-USD'), cmp('cmp-p', 'BTC-USD', { placement: 'pane' })]);
    await settle();
    chart.clearStudies();
    expect(chart.studies.get('cmp-a')!.values).toEqual([101, 102, 103, 104, 107]);
    expect(chart.studies.get('cmp-p')!.paneId).toBe('pane-cmp-p');
  });

  it('removes studies of removed overlays and unsubscribes unused series', async () => {
    const { chart, ctl, subs } = setup();
    chart.load(cols(AAPL_T, AAPL_C));
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    await settle();
    ctl.sync([]);
    expect(chart.studies.size).toBe(0);
    expect(subs[0]!.closed).toBe(true);
    expect(useCompareRuntime.getState().status).toEqual({});
    ctl.destroy();
  });

  it('refetches overlays when the data epoch changes (replay start/seek/stop)', async () => {
    let epoch = 0;
    const { chart, ctl, requests, subs } = setup(undefined, { dataEpoch: () => epoch });
    ctl.sync([cmp('cmp-a', 'BTC-USD')]);
    chart.load(cols(AAPL_T, AAPL_C));
    await settle();
    expect(requests).toHaveLength(1);
    // A plain reload keeps the cached overlay.
    chart.load(cols(AAPL_T, AAPL_C));
    await settle();
    expect(requests).toHaveLength(1);
    epoch = 1;
    chart.load(cols(AAPL_T, AAPL_C));
    await settle();
    expect(requests).toHaveLength(2);
    expect(subs[0]!.closed).toBe(true);
    expect(subs[1]!.closed).toBe(false);
    expect(chart.studies.get('cmp-a')!.values).toEqual([101, 102, 103, 104, 107]);
  });
});
