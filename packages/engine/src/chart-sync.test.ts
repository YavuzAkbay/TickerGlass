// Multi-chart sync primitives on the chart (DOM harness copied from chart-overlays.test.ts).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chart, ViewChangeCause } from './chart';
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
  addEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(): void {}
  /** Dispatch a fake event to the listeners of `type`. */
  fire(type: string, e: object): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
  focus(): void {}
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

const H = 3600;
const DAY = 86_400;

function makeBars(n: number, start: number, price = 100): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const c = price + Math.sin(i) * 3;
    return { time: start + i * DAY, open: c - 0.5, high: c + 1, low: c - 1, close: c, volume: 1 };
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
  subscribe(_req: unknown, _last: Bar | null, _onBar: BarListener): Unsubscribe {
    return () => undefined;
  }
}

const START = 1_700_006_400; // 2023-11-15 00:00 UTC; daily bars every day (24/7 data)
const charts: Chart[] = [];

/** A laid-out chart with 50 daily bars from START (index i = START + i days). */
async function load(older: Bar[] = []) {
  const { Chart } = await import('./chart');
  const chart = new Chart(
    new FakeEl() as unknown as HTMLElement,
    new FakeFeed(makeBars(50, START), older),
  );
  charts.push(chart);
  const causes: ViewChangeCause[] = [];
  chart.on('viewChange', (e) => causes.push(e.cause));
  await chart.setSymbol('TEST');
  (chart as unknown as { layout(): void }).layout();
  return { chart, causes };
}

const syncedIndex = (chart: Chart) => (chart as unknown as { syncedIndex(): number }).syncedIndex();

afterEach(() => {
  for (const c of charts.splice(0)) c.destroy();
});

describe('Chart.setSyncedCrosshair', () => {
  it('never emits crosshairMove', async () => {
    const { chart } = await load();
    const moves = vi.fn();
    chart.on('crosshairMove', moves);
    chart.setSyncedCrosshair({
      time: START + 10 * DAY + 3 * H,
      interval: '1h',
      timezone: null,
      price: 100,
    });
    chart.viewChanged('api');
    chart.setSyncedCrosshair(null);
    expect(moves).not.toHaveBeenCalled();
  });

  it('maps the source time to a bar and follows history loads', async () => {
    // 20 older daily bars arrive on demand: the same time then sits 20 indices later.
    const { chart } = await load(makeBars(20, START - 20 * DAY));
    // A 1h bar at day 10 03:00 lies in the daily bar of day 10 (index 10).
    chart.setSyncedCrosshair({
      time: START + 10 * DAY + 3 * H,
      interval: '1h',
      timezone: null,
      price: null,
    });
    expect(syncedIndex(chart)).toBe(10);
    await chart.showAllHistory();
    expect(syncedIndex(chart)).toBe(30);
    chart.setSyncedCrosshair(null);
    expect(syncedIndex(chart)).toBeNaN();
  });

  it('rejects an invalid interval', async () => {
    const { chart } = await load();
    expect(() =>
      chart.setSyncedCrosshair({ time: START, interval: 'bogus', timezone: null, price: null }),
    ).toThrow(/invalid interval/);
  });
});

describe('Chart viewChange causes', () => {
  it("reports a data load as 'data'", async () => {
    const { causes } = await load();
    expect(causes).toEqual(['data']);
  });

  it("reports wheel panning as 'user' and API scrolling as 'api'", async () => {
    const { chart, causes } = await load();
    causes.length = 0;
    const root = chart.root as unknown as FakeEl;
    root.fire('wheel', {
      clientX: 200,
      clientY: 100,
      deltaX: 50,
      deltaY: 0,
      deltaMode: 0,
      ctrlKey: false,
      target: null,
      preventDefault: () => undefined,
    });
    expect(causes).toEqual(['user']);
    causes.length = 0;
    chart.setVisibleLogicalRange(10, 40);
    expect(causes).toEqual(['api']);
  });
});

describe('Chart.setRightEdgeTime / getVisibleTimeRange', () => {
  it('puts the bar at the right edge, keeps the bar spacing and emits api', async () => {
    const { chart, causes } = await load();
    chart.timeScale.barSpacing = 9;
    causes.length = 0;
    await chart.setRightEdgeTime(START + 30 * DAY);
    expect(causes).toEqual(['api']);
    expect(chart.timeScale.barSpacing).toBe(9);
    // rightOffset = 30 - 49 puts the right edge of slot 30 at the pane edge (logical 30.5):
    // the last visible slot is 30, so the round trip returns the same time.
    expect(chart.getVisibleTimeRange()?.to).toBe(START + 30 * DAY);
  });

  it('reaches future slots past the last bar', async () => {
    const { chart } = await load();
    // 24/7 daily data: future slots are plain days, so day 55 is slot 55 (6 past index 49).
    await chart.setRightEdgeTime(START + 55 * DAY);
    const r = chart.getVisibleTimeRange();
    expect(r?.to).toBe(START + 55 * DAY);
    // Left edge: paneWidth / spacing slots to the left of the right edge (logical 55.5).
    const left = 55.5 - chart.paneWidth / chart.timeScale.barSpacing;
    expect(r?.from).toBe(START + Math.floor(left + 0.5) * DAY);
  });
});
