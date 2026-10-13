import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chart } from './chart';
import type { SeriesChange, StudySpec } from './studies/types';
import type {
  Bar,
  BarListener,
  DataFeed,
  GetBarsRequest,
  GetBarsResult,
  SymbolInfo,
  Unsubscribe,
} from './types';

// ---------------------------------------------------------------------------
// Just enough DOM for the Chart constructor; frames never run (no rendering).

class FakeEl {
  className = '';
  id = '';
  innerHTML = '';
  textContent = '';
  tabIndex = 0;
  width = 0;
  height = 0;
  style: Record<string, unknown> = { setProperty: () => undefined };
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  appendChild(c: FakeEl): FakeEl {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove(): void {
    const p = this.parent;
    if (p) p.children.splice(p.children.indexOf(this), 1);
    this.parent = null;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  getContext(): object {
    return {};
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => new FakeEl(),
    getElementById: () => null,
    head: new FakeEl(),
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

const DAY = 86_400;

function makeBars(n: number, start: number, price = 100): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = price + Math.sin(i) * 3;
    return {
      time: start + i * DAY,
      open: c - 0.5,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1000,
    };
  });
}

function columns(bars: Bar[]) {
  const col = (k: keyof Bar) => Float64Array.from(bars, (b) => b[k]);
  return {
    time: col('time'),
    open: col('open'),
    high: col('high'),
    low: col('low'),
    close: col('close'),
    volume: col('volume'),
  };
}

class FakeFeed implements DataFeed {
  listener: BarListener | null = null;
  constructor(
    private readonly recent: Bar[],
    private readonly older: Bar[] = [],
  ) {}
  async resolveSymbol(symbol: string): Promise<SymbolInfo> {
    return {
      symbol,
      name: symbol,
      exchange: null,
      exchangeName: null,
      type: null,
      currency: null,
      timezone: 'UTC',
      session: null,
      priceHint: 2,
      minTick: 0.01,
    };
  }
  async searchSymbols() {
    return [];
  }
  async getBars(req: GetBarsRequest): Promise<GetBarsResult> {
    if (req.to !== undefined) return { bars: columns(this.older), hasMore: false };
    return { bars: columns(this.recent), hasMore: this.older.length > 0 };
  }
  subscribe(_req: unknown, _last: Bar | null, onBar: BarListener): Unsubscribe {
    this.listener = onBar;
    return () => {
      this.listener = null;
    };
  }
  tick(bar: Bar): void {
    this.listener?.(bar);
  }
}

const START = 1_700_006_400; // midnight UTC
const charts: Chart[] = [];

async function load(n = 50, older: Bar[] = []) {
  const { Chart } = await import('./chart');
  const recent = makeBars(n, START);
  const feed = new FakeFeed(recent, older);
  const chart = new Chart(new FakeEl() as unknown as HTMLElement, feed);
  charts.push(chart);
  const changes: SeriesChange[] = [];
  chart.on('seriesChange', (c) => changes.push(c));
  await chart.setSymbol('TEST');
  return { chart, feed, changes, recent };
}

afterEach(() => {
  for (const c of charts.splice(0)) c.destroy();
});

function studySpec(id: string, target: StudySpec['target']): StudySpec {
  return {
    id,
    title: id,
    target,
    outputs: [
      {
        type: 'plot',
        id: 'v',
        title: 'V',
        visible: true,
        kind: 'line',
        colors: ['#fff'],
        lineWidth: 1,
        lineStyle: 'solid',
        base: null,
        offset: 0,
        showLastValue: true,
      },
    ],
    format: 'inherit',
    precision: 2,
    scaleRange: null,
    priceScale: 'pane',
    visible: true,
  };
}

describe('Chart seriesChange', () => {
  it('emits reset on load, then update/append for live bars', async () => {
    const { chart, feed, changes, recent } = await load(50);
    expect(changes).toEqual([{ kind: 'reset', revision: 1, length: 50 }]);
    expect(chart.seriesRevision).toBe(1);
    const last = recent[49]!;
    feed.tick({ ...last, close: last.close + 1 });
    feed.tick({ ...last, time: last.time + DAY });
    expect(changes.slice(1)).toEqual([
      { kind: 'update', revision: 1, index: 49 },
      { kind: 'append', revision: 1, index: 50 },
    ]);
  });

  it('resets for transforms and history prepends, not for plain type switches', async () => {
    const older = makeBars(30, START - 30 * DAY);
    const { chart, feed, changes, recent } = await load(50, older);
    changes.length = 0;
    chart.setChartType('bars');
    expect(changes).toEqual([]);
    chart.setChartType('heikinAshi');
    expect(changes).toEqual([{ kind: 'reset', revision: 2, length: 50 }]);
    const last = recent[49]!;
    feed.tick({ ...last, time: last.time + DAY });
    expect(changes[1]).toEqual({ kind: 'append', revision: 2, index: 50 });
    chart.setChartType('candles');
    expect(changes[2]).toEqual({ kind: 'reset', revision: 3, length: 51 });
    await chart.setVisibleTimeRange(START - 30 * DAY);
    expect(changes[3]).toEqual({ kind: 'prepend', revision: 4, length: 81, added: 30 });
  });

  it('keeps drawing study data shifted across a history prepend', async () => {
    const older = makeBars(30, START - 30 * DAY);
    const { chart, changes } = await load(50, older);
    chart.addStudy(studySpec('ma', { paneId: 'main' }));
    const values = { v: Float64Array.from({ length: 50 }, (_, i) => i) };
    chart.setStudyData('ma', { revision: chart.seriesRevision, length: 50, values, colors: {} });
    changes.length = 0;
    await chart.setVisibleTimeRange(START - 30 * DAY);
    expect(changes).toEqual([{ kind: 'prepend', revision: 2, length: 80, added: 30 }]);
    // Old bar 0 is now bar 30; the new history has no values yet.
    expect(chart.getStudyValues('ma', 30)[0]!.value).toBe(0);
    expect(chart.getStudyValues('ma', 79)[0]!.value).toBe(49);
    expect(chart.getStudyValues('ma', 29)[0]!.value).toBeNaN();
    // Live ticks patch the shifted data; a full compute replaces it.
    chart.updateStudyData('ma', {
      revision: 2,
      from: 79,
      length: 80,
      values: { v: Float64Array.from([7]) },
      colors: {},
    });
    expect(chart.getStudyValues('ma', 79)[0]!.value).toBe(7);
    const full = { v: Float64Array.from({ length: 80 }, () => 1) };
    chart.setStudyData('ma', { revision: 2, length: 80, values: full, colors: {} });
    expect(chart.getStudyValues('ma', 0)[0]!.value).toBe(1);
  });

  it('resets instead of prepending on brick charts', async () => {
    const older = makeBars(30, START - 30 * DAY);
    const { chart, changes } = await load(50, older);
    chart.setChartStyle({ renko: { boxSizeMode: 'fixed', boxSize: 1 } });
    chart.setChartType('renko');
    changes.length = 0;
    await chart.setVisibleTimeRange(START - 30 * DAY);
    expect(changes.map((c) => c.kind)).toEqual(['reset']);
  });

  it('emits tail changes or a reset for brick rebuilds', async () => {
    const { chart, feed, changes, recent } = await load(50);
    chart.setChartStyle({ renko: { boxSizeMode: 'fixed', boxSize: 1 } });
    chart.setChartType('renko');
    const rev = chart.seriesRevision;
    expect(changes.at(-1)).toEqual({ kind: 'reset', revision: rev, length: chart.store.length });
    changes.length = 0;
    const last = recent[49]!;
    let t = last.time;
    let close = last.close;
    let appended = 0;
    for (let k = 0; k < 6; k++) {
      t += DAY;
      close += 2.5;
      const before = chart.store.length;
      feed.tick({ time: t, open: close, high: close, low: close, close, volume: 1 });
      const after = chart.store.length;
      // Each tick either resets or describes exactly the bricks that changed.
      const batch = changes.splice(0);
      if (batch.some((c) => c.kind === 'reset')) {
        expect(batch).toHaveLength(1);
        continue;
      }
      const appends = batch.filter((c) => c.kind === 'append').map((c) => 'index' in c && c.index);
      expect(appends).toEqual(Array.from({ length: after - before }, (_, i) => before + i));
      appended += appends.length;
    }
    expect(appended).toBeGreaterThan(0);
  });
});

describe('brick resets keep unchanged study data', () => {
  it('keeps values of the unchanged leading bricks drawn across a live reset', async () => {
    const { chart, feed, changes, recent } = await load(50);
    chart.setChartStyle({ renko: { boxSizeMode: 'fixed', boxSize: 1 } });
    chart.setChartType('renko');
    chart.addStudy(studySpec('ma', { paneId: 'main' }));
    const last = recent[49]!;
    const t = last.time + DAY;
    // A new raw bar that builds several bricks...
    let close = last.close + 6;
    feed.tick({ time: t, open: close, high: close, low: close, close, volume: 1 });
    const n = chart.store.length;
    const values = { v: Float64Array.from({ length: n }, (_, i) => i) };
    chart.setStudyData('ma', { revision: chart.seriesRevision, length: n, values, colors: {} });
    const before = { time: chart.store.time.slice(0, n), close: chart.store.close.slice(0, n) };
    changes.length = 0;
    // ...then gives them back within the same bar: bricks disappear -> reset.
    close = last.close;
    feed.tick({ time: t, open: close, high: close, low: close, close, volume: 1 });
    expect(changes.map((c) => c.kind)).toEqual(['reset']);
    let keep = 0;
    while (
      keep < Math.min(n, chart.store.length) &&
      chart.store.time[keep] === before.time[keep] &&
      chart.store.close[keep] === before.close[keep]
    )
      keep++;
    expect(keep).toBeGreaterThan(0);
    // Values before the first changed brick still show; the rest waits for a recompute.
    expect(chart.getStudyValues('ma', keep - 1)[0]!.value).toBe(keep - 1);
    expect(chart.getStudyValues('ma', keep)[0]!.value).toBeNaN();
  });
});

describe('Chart studies', () => {
  it('adds studies to new panes and removes empty panes', async () => {
    const { chart } = await load(20);
    const removed: string[] = [];
    chart.on('paneRemoved', (e) => removed.push(e.paneId));
    expect(chart.addStudy(studySpec('ma', { paneId: 'main' }))).toBe('main');
    const paneId = chart.addStudy(studySpec('rsi', { newPane: { id: 'rsi-pane', ratio: 1 } }));
    expect(paneId).toBe('rsi-pane');
    expect(chart.panes.map((p) => p.id)).toEqual(['main', 'rsi-pane']);
    expect(chart.addStudy(studySpec('rsi-ma', { paneId: 'rsi-pane' }))).toBe('rsi-pane');
    expect(() => chart.addStudy(studySpec('ma', { paneId: 'main' }))).toThrow();
    expect(() => chart.addStudy(studySpec('x', { paneId: 'nope' }))).toThrow();
    expect(() => chart.addStudy(studySpec('volume', { paneId: 'main' }))).toThrow();
    expect(chart.getStudies().map((s) => [s.id, s.paneId])).toEqual([
      ['ma', 'main'],
      ['rsi', 'rsi-pane'],
      ['rsi-ma', 'rsi-pane'],
    ]);

    chart.removeStudy('rsi');
    expect(removed).toEqual([]);
    expect(chart.moveStudy('rsi-ma', { paneId: 'main' })).toBe('main');
    expect(removed).toEqual(['rsi-pane']);
    expect(chart.panes.map((p) => p.id)).toEqual(['main']);
    chart.removeStudy('ma');
    chart.removeStudy('unknown');
    expect(chart.panes.map((p) => p.id)).toEqual(['main']);
  });

  it('emits paneRemoved once with the dropped studies when a pane is removed', async () => {
    const { chart } = await load(20);
    const events: { paneId: string; studyIds: string[] }[] = [];
    chart.on('paneRemoved', (e) => events.push(e));
    chart.addStudy(studySpec('rsi', { newPane: { id: 'p2' } }));
    chart.addStudy(studySpec('rsi-ma', { paneId: 'p2' }));
    chart.removePane('p2');
    expect(events).toEqual([{ paneId: 'p2', studyIds: ['rsi', 'rsi-ma'] }]);
    expect(chart.getStudies()).toEqual([]);
    // A pane without studies is removed silently; removing a study's last pane emits once.
    chart.addPane(1, 'empty');
    chart.removePane('empty');
    chart.addStudy(studySpec('a', { newPane: { id: 'p3' } }));
    chart.removeStudy('a');
    expect(events.slice(1)).toEqual([{ paneId: 'p3', studyIds: [] }]);
  });

  it('reuses an existing pane for newPane targets with its id', async () => {
    const { chart } = await load(20);
    const removed: string[] = [];
    chart.on('paneRemoved', (e) => removed.push(e.paneId));
    chart.addStudy(studySpec('rsi', { newPane: { id: 'pane-rsi' } }));
    chart.addStudy(studySpec('rsi-ma', { paneId: 'pane-rsi' }));
    // Own placement for a study already alone in its own pane: no-op.
    expect(chart.moveStudy('rsi', { newPane: { id: 'pane-rsi' } })).toBe('pane-rsi');
    chart.removeStudy('rsi-ma');
    expect(chart.moveStudy('rsi', { newPane: { id: 'pane-rsi' } })).toBe('pane-rsi');
    expect(removed).toEqual([]);
    expect(chart.panes.map((p) => p.id)).toEqual(['main', 'pane-rsi']);
    // Remove the source while a dependent lives in its pane, then undo (re-add).
    chart.addStudy(studySpec('rsi-ma', { paneId: 'pane-rsi' }));
    chart.removeStudy('rsi');
    expect(chart.addStudy(studySpec('rsi', { newPane: { id: 'pane-rsi' } }))).toBe('pane-rsi');
    expect(chart.panes.map((p) => p.id)).toEqual(['main', 'pane-rsi']);
    expect(chart.panes[1]!.series.map((s) => s.id)).toEqual(['rsi-ma', 'rsi']);
  });

  it('prefers lines and bars of every series over study fill interiors', async () => {
    const { chart } = await load(20);
    chart.addStudy(studySpec('bb', { paneId: 'main' }));
    const pane = chart.panes[0]!;
    chart['width'] = 800;
    chart['height'] = 600;
    pane.top = 0;
    pane.height = 500;
    const main = pane.series.find((s) => s.id === 'main')!;
    const study = pane.series.find((s) => s.id === 'bb')!;
    const onCandle = vi.spyOn(main, 'hitTest').mockReturnValue(true);
    const layers: string[] = [];
    vi.spyOn(study as never as { hitTestPx: () => string | null }, 'hitTestPx').mockImplementation(
      ((_x: number, _y: number, layer: string) => {
        layers.push(layer);
        return layer === 'fills' ? 'fill' : null;
      }) as never,
    );
    // The study is drawn above the candles, but a candle beats its fill.
    expect(chart.hitTest(100, 100)).toMatchObject({ seriesId: 'main', outputId: null });
    expect(chart.hitTest(100, 100)).not.toHaveProperty('fill');
    expect(chart.describePoint(100, 100).seriesId).toBe('main');
    onCandle.mockReturnValue(false);
    expect(chart.hitTest(100, 100)).toMatchObject({ seriesId: 'bb', outputId: 'fill', fill: true });
    expect(layers).toContain('marks');
  });

  it('keeps a volume pane that holds studies when volume moves back to overlay', async () => {
    const { chart } = await load(20);
    chart.setVolumeMode('pane');
    chart.addStudy(studySpec('vma', { paneId: 'volume' }));
    chart.setVolumeMode('overlay');
    expect(chart.panes.map((p) => p.id)).toEqual(['main', 'volume']);
    chart.setVolumeMode('pane');
    expect(chart.panes.filter((p) => p.id === 'volume')).toHaveLength(1);
    expect(chart.panes[1]!.series.map((s) => s.id)).toEqual(['volume-pane', 'vma']);
  });

  it('drops stale data and serves legend values for the current revision', async () => {
    const { chart } = await load(5);
    chart.addStudy(studySpec('ma', { paneId: 'main' }));
    const values = { v: Float64Array.from([1, 2, 3, 4, 5]) };
    chart.setStudyData('ma', { revision: 0, length: 5, values, colors: {} });
    expect(chart.getStudyValues('ma', 4)[0]!.value).toBeNaN();
    chart.setStudyData('ma', { revision: chart.seriesRevision, length: 5, values, colors: {} });
    expect(chart.getStudyValues('ma', 4)[0]).toMatchObject({ value: 5, text: '5.00' });
    chart.updateStudyData('ma', {
      revision: chart.seriesRevision,
      from: 4,
      length: 6,
      values: { v: Float64Array.from([50, 60]) },
      colors: {},
    });
    expect(chart.getStudyValues('ma', 5)[0]!.value).toBe(60);
    chart.setChartType('heikinAshi'); // reset -> stored values are stale
    expect(chart.getStudyValues('ma', 4)[0]!.value).toBeNaN();
    expect(chart.getStudyValues('unknown', 0)).toEqual([]);
  });

  it('never overwrites the app legend slot', async () => {
    const { chart } = await load(5);
    chart.addStudy(studySpec('rsi', { newPane: { id: 'p2' } }));
    const slot = chart.getLegendSlot('p2') as unknown as FakeEl;
    expect(slot).not.toBeNull();
    expect(chart.getLegendSlot('missing')).toBeNull();
    slot.innerHTML = '<div>app</div>';
    const mainSlot = chart.getLegendSlot('main') as unknown as FakeEl;
    mainSlot.innerHTML = '<div>main app</div>';
    chart['updateLegends']();
    expect(slot.innerHTML).toBe('<div>app</div>');
    expect(mainSlot.innerHTML).toBe('<div>main app</div>');
    expect((chart.panes[0]!.legendInfo as unknown as FakeEl).innerHTML).toContain('TEST');
    // Study series are not listed in the engine's own pane legend.
    expect((chart.panes[1]!.legendInfo as unknown as FakeEl).innerHTML).toBe('');
  });

  it('clears studies on setState so the app can re-add them', async () => {
    const { chart } = await load(5);
    chart.addStudy(studySpec('rsi', { newPane: { id: 'p2', ratio: 2 } }));
    const state = chart.getState();
    const cleared: { ids: string[]; panes: string[] }[] = [];
    const removed: string[] = [];
    chart.on('paneRemoved', (e) => removed.push(e.paneId));
    chart.on('studiesCleared', (e) =>
      cleared.push({ ids: e.ids, panes: chart.panes.map((p) => p.id) }),
    );
    await chart.setState(state);
    expect(chart.getStudies()).toEqual([]);
    // Emitted once the saved panes exist again, so re-adding can target them.
    expect(cleared).toEqual([{ ids: ['rsi'], panes: ['main', 'p2'] }]);
    expect(removed).toEqual([]);
    expect(chart.panes.map((p) => [p.id, p.ratio])).toEqual([
      ['main', 3],
      ['p2', 2],
    ]);
    expect(chart.addStudy(studySpec('rsi', { paneId: 'p2' }))).toBe('p2');
  });
});
