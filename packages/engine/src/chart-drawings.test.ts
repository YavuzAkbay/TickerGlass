// Chart-level drawing API (DOM harness copied from chart-studies.test.ts).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chart } from './chart';
import type { DrawingHost } from './drawings/layer';
import { logicalToTime, timeToLogical } from './drawings/mapping';
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
  listeners = new Map<string, ((e: unknown) => void)[]>();
  captured = new Set<number>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  /** Dispatch a fake event to the listeners of `type`. */
  fire(type: string, e: object): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  focus(): void {}
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
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
  await chart.setSymbol('TEST');
  return { chart, feed, recent };
}

afterEach(() => {
  for (const c of charts.splice(0)) c.destroy();
});

describe('Chart drawing API', () => {
  it('adds, updates, removes and replaces drawings without mutation events', async () => {
    const { chart } = await load(50);
    const seen: string[] = [];
    for (const ev of ['drawingCreated', 'drawingChanged', 'drawingsRemoved'] as const)
      chart.on(ev, () => seen.push(ev));
    const sel: string[][] = [];
    chart.on('selectionChanged', (e) => sel.push(e.ids));
    const d = chart.addDrawing({ type: 'trend-line', points: [{ time: START, price: 1 }] });
    expect(d).toMatchObject({ symbol: 'TEST', paneId: 'main', scope: 'symbol', zIndex: 1 });
    expect(d.style.lineColor).toBe('#2962ff');
    expect(() => chart.addDrawing({ ...d })).toThrow();
    expect(() => chart.addDrawing({ type: 'nope', points: [] })).toThrow();
    chart.updateDrawing(d.id, { text: 'hi', style: { lineWidth: 3 } });
    expect(chart.getDrawing(d.id)).toMatchObject({ text: 'hi', style: { lineWidth: 3 } });
    // Returned objects are copies.
    chart.getDrawings()[0]!.text = 'changed';
    expect(chart.getDrawing(d.id)!.text).toBe('hi');
    chart.selectDrawings([d.id, 'unknown']);
    expect(chart.getSelection()).toEqual([d.id]);
    // Unknown types survive a bulk replace (persisted data from newer versions).
    chart.setDrawings([{ ...d, id: 'x', type: 'future-tool' }]);
    expect(chart.getDrawings().map((x) => x.id)).toEqual(['x']);
    expect(chart.getSelection()).toEqual([]);
    chart.removeDrawings(['x']);
    expect(chart.getDrawings()).toEqual([]);
    expect(seen).toEqual([]);
    expect(sel).toEqual([[d.id], []]);
  });

  it('sets the active tool and drawing options', async () => {
    const { chart } = await load(10);
    chart.setActiveTool('horizontal-line');
    expect(chart.getActiveTool()).toBe('horizontal-line');
    expect(() => chart.setActiveTool('nope')).toThrow();
    chart.setDrawingOptions({ lockAll: true });
    expect(chart.getDrawingOptions()).toEqual({
      stayInDrawingMode: false,
      lockAll: true,
      hideAll: false,
    });
  });

  it('selects all shown drawings and drops hidden ones from the selection', async () => {
    const { chart } = await load(20);
    const a = chart.addDrawing({ type: 'horizontal-line', points: [{ time: START, price: 1 }] });
    const b = chart.addDrawing({ type: 'horizontal-line', points: [{ time: START, price: 2 }] });
    chart.addDrawing({
      type: 'horizontal-line',
      points: [{ time: START, price: 3 }],
      symbol: 'OTHER',
    });
    chart.addDrawing({
      type: 'horizontal-line',
      points: [{ time: START, price: 4 }],
      hidden: true,
    });
    chart.selectAllDrawings();
    expect(chart.getSelection()).toEqual([a.id, b.id]);
    chart.updateDrawing(a.id, { hidden: true });
    expect(chart.getSelection()).toEqual([b.id]);
    chart.setDrawingOptions({ hideAll: true });
    expect(chart.getSelection()).toEqual([]);
  });

  it('copies and pastes drawings as a user gesture', async () => {
    const { chart } = await load(50);
    const a = chart.addDrawing({
      type: 'trend-line',
      points: [
        { time: START + 10 * DAY, price: 100 },
        { time: START + 20 * DAY, price: 110 },
      ],
      style: { lineWidth: 3 },
      text: 'x',
    });
    const json = chart.copyDrawings([a.id, 'unknown']);
    expect(JSON.parse(json)).toMatchObject({ version: 1, drawings: [{ id: a.id }] });
    const created: string[] = [];
    chart.on('drawingCreated', (e) => created.push(e.drawing.id));
    const [p] = chart.pasteDrawings(json, { offset: 5 });
    expect(p!.id).not.toBe(a.id);
    expect(p!.zIndex).toBeGreaterThan(a.zIndex);
    expect(p!.points.map((q) => q.time)).toEqual([START + 15 * DAY, START + 25 * DAY]);
    expect(p).toMatchObject({ style: { lineWidth: 3 }, text: 'x', symbol: 'TEST' });
    expect(created).toEqual([p!.id]);
    expect(chart.getSelection()).toEqual([p!.id]);
    // `at`: earliest anchor moves to the given time/price.
    const [q] = chart.pasteDrawings(json, { at: { time: START + 30 * DAY, price: 50 } });
    expect(q!.points).toEqual([
      { time: START + 30 * DAY, price: 50 },
      { time: START + 40 * DAY, price: 60 },
    ]);
    // A drawing from a pane this chart lacks lands on the main pane.
    const studyPane = JSON.stringify({ version: 1, drawings: [{ ...a, paneId: 'pane-rsi' }] });
    expect(chart.pasteDrawings(studyPane)[0]!.paneId).toBe('main');
    // Unknown types skipped; garbage throws.
    const foreign = JSON.stringify({ version: 1, drawings: [{ ...a, type: 'future' }] });
    expect(chart.pasteDrawings(foreign)).toEqual([]);
    expect(() => chart.pasteDrawings('nope')).toThrow();
    expect(() => chart.pasteDrawings('{"version":2}')).toThrow();
  });

  it('z-order methods return changes without events', async () => {
    const { chart } = await load(10);
    const mk = (price: number) =>
      chart.addDrawing({ type: 'horizontal-line', points: [{ time: START, price }] });
    const a = mk(1);
    const b = mk(2);
    const seen: string[] = [];
    chart.on('drawingChanged', () => seen.push('changed'));
    const ch = chart.bringToFront([a.id]);
    expect(ch).toHaveLength(1);
    expect(ch[0]!.before.zIndex).toBe(1);
    expect(chart.getDrawings().map((d) => d.id)).toEqual([b.id, a.id]);
    expect(chart.sendBackward([a.id])).toHaveLength(2);
    expect(chart.bringForward([a.id])).toHaveLength(2);
    expect(chart.sendToBack([a.id])).toHaveLength(1);
    expect(chart.getDrawings().map((d) => d.id)).toEqual([a.id, b.id]);
    // Undo through the API restores the order.
    for (const c of ch) chart.updateDrawing(c.before.id, c.before);
    expect(seen).toEqual([]);
  });

  it('replaceDrawing replaces wholesale (removed style keys leave) without events', async () => {
    const { chart } = await load(10);
    const seen: string[] = [];
    chart.on('drawingChanged', () => seen.push('changed'));
    const d = chart.addDrawing({ type: 'trend-line', points: [{ time: START, price: 1 }] });
    const { lineWidth: _w, ...style } = d.style;
    chart.replaceDrawing({ ...d, style, text: 't' });
    const got = chart.getDrawing(d.id)!;
    expect('lineWidth' in got.style).toBe(false);
    expect(got.text).toBe('t');
    // updateDrawing merges, so the full drawing round-trips equal now.
    chart.replaceDrawing({ ...d, id: 'unknown' });
    expect(chart.getDrawings()).toHaveLength(1);
    expect(seen).toEqual([]);
    // Bounds: null for unknown / hidden drawings.
    expect(chart.getDrawingBounds(['unknown'])).toBeNull();
    chart.updateDrawing(d.id, { hidden: true });
    expect(chart.getDrawingBounds([d.id])).toBeNull();
  });

  it('caches the drawing host interval string per interval change', async () => {
    const { chart } = await load(10);
    const host = (chart as unknown as { drawingLayer: { host: { interval: string } } }).drawingLayer
      .host;
    const cache = (chart as unknown as { intervalCache: { iv: unknown; str: string } })
      .intervalCache;
    expect(host.interval).toBe('1D');
    const iv = cache.iv;
    expect(host.interval).toBe('1D');
    expect(cache.iv).toBe(iv); // not re-formatted
    await chart.setInterval('1h');
    expect(host.interval).toBe('1h');
    expect(cache.iv).not.toBe(iv);
  });

  it('magnet values on the main pane are the displayed bar OHLC', async () => {
    const { chart, recent } = await load(20);
    const host = (chart as unknown as { drawingLayer: { host: DrawingHost } }).drawingLayer.host;
    const b = recent[7]!;
    expect(host.magnetValues!('main', 7)).toEqual([b.open, b.high, b.low, b.close]);
    expect(host.magnetValues!('main', -1)).toEqual([]);
    expect(host.magnetValues!('main', 20)).toEqual([]);
    expect(host.magnetValues!('missing', 7)).toEqual([]);
    // Heikin Ashi: the displayed (transformed) bars, not the raw ones.
    chart.setChartType('heikinAshi');
    const s = chart.store;
    expect(host.magnetValues!('main', 7)).toEqual([s.open[7], s.high[7], s.low[7], s.close[7]]);
    expect(host.magnetValues!('main', 7)).not.toEqual([b.open, b.high, b.low, b.close]);
  });

  it('exposes the anchor timeline so bar numbers match bricks (Coordinates tab)', async () => {
    const { chart, recent } = await load(30);
    let tl = chart.getAnchorTimeline();
    expect(tl.bricks).toBe(false);
    expect(timeToLogical(tl, { time: recent[12]!.time })).toBe(12);
    chart.setChartStyle({ renko: { boxSizeMode: 'fixed', boxSize: 1 } });
    chart.setChartType('renko');
    tl = chart.getAnchorTimeline();
    expect(tl.bricks).toBe(true);
    expect(tl.length).toBe(chart.store.length);
    expect(tl.endTime).toBe(recent[29]!.time);
    // Brick i round-trips through its time/brick anchor.
    for (let i = 0; i < tl.length; i++) expect(timeToLogical(tl, logicalToTime(tl, i)!)).toBe(i);
  });

  it('pointercancel aborts a drawing gesture instead of committing it', async () => {
    const { chart } = await load(10);
    vi.stubGlobal('Element', FakeEl);
    const root = chart.root as unknown as FakeEl;
    const input = chart.drawingInput;
    vi.spyOn(input, 'pointerDown').mockReturnValue(true);
    const upSpy = vi.spyOn(input, 'pointerUp');
    const abortSpy = vi.spyOn(input, 'abort');
    const ev = {
      pointerId: 1,
      button: 0,
      pointerType: 'mouse',
      clientX: 10,
      clientY: 10,
      target: null,
    };
    root.fire('pointerdown', ev);
    root.fire('pointercancel', ev);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(upSpy).not.toHaveBeenCalled();
    // A later lostpointercapture (pointer already gone) does nothing.
    root.fire('lostpointercapture', ev);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    // lostpointercapture mid-gesture aborts too.
    root.fire('pointerdown', ev);
    root.fire('lostpointercapture', ev);
    expect(abortSpy).toHaveBeenCalledTimes(2);
    expect(upSpy).not.toHaveBeenCalled();
  });

  it('filters drawings by symbol on symbol change and accepts the eraser tool', async () => {
    const { chart } = await load(10);
    const d = chart.addDrawing({ type: 'horizontal-line', points: [{ time: START, price: 1 }] });
    chart.selectDrawings([d.id]);
    await chart.setSymbol('OTHER');
    expect(chart.getSelection()).toEqual([]);
    expect(chart.getDrawings()).toHaveLength(1); // kept, not shown
    chart.setActiveTool('eraser');
    expect(chart.getActiveTool()).toBe('eraser');
  });
});
