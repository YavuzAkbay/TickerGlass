// Chart-level markers, price lines and price-axis "+" (DOM harness copied from chart-drawings.test.ts).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chart } from './chart';
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
    return { measureText: () => ({ width: 40 }) };
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
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('Element', class {});
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

/** Runs the (private) layout so panes and the time scale have real geometry. */
async function loadLaid(n = 50) {
  const r = await load(n);
  (r.chart as unknown as { layout(): void }).layout();
  return r;
}

describe('Chart price-axis "+" button', () => {
  it('shows the "+" hit area only inside the pane, level with the axis hover', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    const w = chart.paneWidth;
    // No label yet: nothing to hit.
    expect(chart.hitTest(w - 5, pane.top + 100)).not.toHaveProperty('plus');
    chart.setAxisHover(pane, 100);
    expect(chart.hitTest(w - 5, pane.top + 100)).toMatchObject({ kind: 'priceAxis', plus: true });
    expect(chart.hitTest(w - 5, pane.top + 91)).toMatchObject({ plus: true });
    expect(chart.hitTest(w - 5, pane.top + 80)).not.toHaveProperty('plus');
    // Left of the "+" box is the plain pane.
    expect(chart.hitTest(w - 30, pane.top + 100)).toMatchObject({ kind: 'pane' });
    // The axis itself never carries the "+", so dragging it to rescale cannot grab it.
    for (const dx of [0.5, 5, 30]) {
      expect(chart.hitTest(w + dx, pane.top + 100)).toMatchObject({ kind: 'priceAxis' });
      expect(chart.hitTest(w + dx, pane.top + 100)).not.toHaveProperty('plus');
    }
    chart.setAxisHover(null, 0);
    expect(chart.hitTest(w - 5, pane.top + 100)).not.toHaveProperty('plus');
  });

  it('also appears beside the crosshair label while over the pane', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    chart.setCrosshair(pane, 100, 120);
    expect(chart.hitTest(chart.paneWidth - 5, pane.top + 120)).toMatchObject({ plus: true });
  });

  it('is off with priceAxisPlusButton: false', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    chart.applyOptions({ priceAxisPlusButton: false });
    chart.setAxisHover(pane, 100);
    expect(chart.hitTest(chart.paneWidth - 5, pane.top + 100)).not.toHaveProperty('plus');
  });

  it('emits priceAxisPlus with the pane and price under the label', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    const seen: { paneId: string; price: number }[] = [];
    chart.on('priceAxisPlus', (e) => seen.push(e));
    chart.firePriceAxisPlus(pane); // no label -> nothing
    expect(seen).toEqual([]);
    chart.setAxisHover(pane, 100);
    chart.firePriceAxisPlus(pane);
    expect(seen).toEqual([{ paneId: 'main', price: pane.priceScale.yToPrice(100) }]);
  });

  it('fires from a pointer click on the "+" and not from a drag', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    const root = chart.root as unknown as FakeEl;
    const seen: unknown[] = [];
    chart.on('priceAxisPlus', (e) => seen.push(e));
    const ev = (x: number, y: number) => ({
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX: x,
      clientY: y,
      timeStamp: 0,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: null,
    });
    const x = chart.paneWidth - 5;
    root.fire('pointermove', ev(x, pane.top + 100));
    root.fire('pointerdown', ev(x, pane.top + 100));
    root.fire('pointerup', ev(x, pane.top + 100));
    expect(seen).toHaveLength(1);
    root.fire('pointermove', ev(x, pane.top + 100));
    root.fire('pointerdown', ev(x, pane.top + 100));
    root.fire('pointerup', ev(x + 40, pane.top + 100));
    expect(seen).toHaveLength(1);
  });
});

describe('Chart crosshair into the future', () => {
  it('keeps counting dates past the last bar instead of pinning to it', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    const ts = chart.timeScale;
    const last = chart.store.length - 1;
    chart.setCrosshair(pane, ts.indexToX(last + 3), 100);
    const c = (chart as unknown as { crosshair: { index: number; logical: number } }).crosshair;
    expect(c.index).toBe(last);
    expect(c.logical).toBe(last + 3);
    const time = (chart as unknown as { crosshairTime(l: number): number | undefined })
      .crosshairTime;
    const t = (l: number) => time.call(chart, l)!;
    expect(t(last)).toBe(chart.store.time[last]);
    expect(t(last + 3)).toBeGreaterThan(t(last + 2));
    expect(t(last + 2)).toBeGreaterThan(t(last));
  });
});

describe('Chart markers and price lines', () => {
  const marker = (id: string, time: number, extra = {}) => ({
    id,
    time,
    position: 'price' as const,
    price: 0.5,
    color: '#f90',
    shape: 'bell' as const,
    ...extra,
  });

  it('replaces and clears a group and keeps them out of getState', async () => {
    const { chart } = await loadLaid();
    const before = JSON.stringify(chart.getState());
    chart.setMarkers('alerts', [marker('a', START + 10 * DAY)]);
    chart.setPriceLines('alerts', [
      { id: 'l', paneId: 'main', price: 0.5, color: '#f00', lineStyle: 'dashed', axisLabel: true },
    ]);
    expect(JSON.stringify(chart.getState())).toBe(before);
    chart.setMarkers('alerts', []);
    chart.setPriceLines('alerts', []);
    const pane = chart.panes[0]!;
    const x = chart.timeScale.indexToX(10);
    expect(chart.hitTest(x, pane.priceScale.priceToY(0.5))).toMatchObject({ kind: 'pane' });
    expect(chart.hitTest(x, pane.priceScale.priceToY(0.5))).not.toHaveProperty('marker');
    expect(chart.hitTest(x, pane.priceScale.priceToY(0.5))).not.toHaveProperty('priceLine');
  });

  it('hit-tests markers by mapped time and emits markerClick', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    const seen: unknown[] = [];
    chart.on('markerClick', (e) => seen.push(e));
    // Mid-bar time of bar 10 still lands on bar 10.
    chart.setMarkers('alerts', [marker('a', START + 10 * DAY + 3600)]);
    const x = chart.timeScale.indexToX(10);
    const y = pane.top + pane.priceScale.priceToY(0.5);
    const hit = chart.hitTest(x, y);
    expect(hit).toMatchObject({ kind: 'pane', marker: { group: 'alerts', id: 'a' } });
    expect(chart.emitOverlayClick(hit)).toBe(true);
    expect(seen).toEqual([{ group: 'alerts', id: 'a' }]);
    // Next bar: no marker.
    expect(chart.hitTest(chart.timeScale.indexToX(12), y)).not.toHaveProperty('marker');
  });

  it('hit-tests price lines in the pane and on the axis and emits priceLineClick', async () => {
    const { chart } = await loadLaid();
    const pane = chart.panes[0]!;
    const seen: unknown[] = [];
    chart.on('priceLineClick', (e) => seen.push(e));
    chart.setPriceLines('alerts', [
      { id: 'l', paneId: 'main', price: 0.5, color: '#f00', lineStyle: 'dashed', axisLabel: true },
      { id: 'o', paneId: 'nope', price: 0.5, color: '#f00', lineStyle: 'solid', axisLabel: true },
    ]);
    const ly = pane.top + pane.priceScale.priceToY(0.5);
    const inPane = chart.hitTest(100, ly + 2);
    expect(inPane).toMatchObject({ kind: 'pane', priceLine: { group: 'alerts', id: 'l' } });
    const onAxis = chart.hitTest(chart.paneWidth + 30, ly);
    expect(onAxis).toMatchObject({ kind: 'priceAxis', priceLine: { group: 'alerts', id: 'l' } });
    expect(chart.hitTest(100, ly + 30)).not.toHaveProperty('priceLine');
    expect(chart.emitOverlayClick(inPane)).toBe(true);
    expect(chart.emitOverlayClick(onAxis)).toBe(true);
    expect(chart.emitOverlayClick(chart.hitTest(100, ly + 30))).toBe(false);
    expect(seen).toEqual([
      { group: 'alerts', id: 'l' },
      { group: 'alerts', id: 'l' },
    ]);
  });
});
