import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Chart } from './chart';
import type { Bar, BarListener, DataFeed, GetBarsResult, SymbolInfo } from './types';

// ---------------------------------------------------------------------------
// Just enough DOM to render frames into no-op 2D contexts.

/** A 2D context whose methods do nothing (measureText reports a fixed width). */
function fakeContext(): object {
  const props: Record<string | symbol, unknown> = {};
  return new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 10 });
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

class FakeEl {
  className = '';
  id = '';
  innerHTML = '';
  textContent = '';
  tabIndex = 0;
  width = 0;
  height = 0;
  style: Record<string, unknown> = { setProperty: () => undefined };
  dataset: Record<string, string> = {};
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
  setAttribute(): void {}
  getContext(): object {
    return fakeContext();
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}

let frames: (() => void)[] = [];
const runFrames = () => {
  const run = frames;
  frames = [];
  for (const fn of run) fn();
};

beforeAll(() => {
  vi.stubGlobal('document', {
    createElement: () => new FakeEl(),
    getElementById: () => null,
    head: new FakeEl(),
  });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    frames.push(fn);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

const DAY = 86_400;
const START = 1_700_006_400;

function columns(n: number) {
  const time = new Float64Array(n);
  const close = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    time[i] = START + i * DAY;
    close[i] = 100 + Math.sin(i);
  }
  return {
    time,
    open: close.slice(),
    high: close.map((c) => c + 1),
    low: close.map((c) => c - 1),
    close,
    volume: new Float64Array(n).fill(1000),
  };
}

const feed: DataFeed = {
  resolveSymbol: async (symbol): Promise<SymbolInfo> => ({
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
  }),
  searchSymbols: async () => [],
  getBars: async (): Promise<GetBarsResult> => ({ bars: columns(300), hasMore: false }),
  subscribe: (_req: unknown, _last: Bar | null, _fn: BarListener) => () => undefined,
};

const charts: Chart[] = [];
afterEach(() => {
  for (const c of charts.splice(0)) c.destroy();
  frames = [];
});

describe('render stats', () => {
  it('reports frame timing, layers and visible bars', async () => {
    const { Chart } = await import('./chart');
    const chart = new Chart(new FakeEl() as unknown as HTMLElement, feed);
    charts.push(chart);
    expect(chart.getRenderStats()).toEqual({
      frames: 0,
      lastFrameMs: 0,
      avgFrameMs: 0,
      layersDrawn: 0,
      barsDrawn: 0,
    });
    await chart.setSymbol('TEST');
    runFrames();
    const full = chart.getRenderStats();
    expect(full.frames).toBeGreaterThanOrEqual(1);
    expect(full.lastFrameMs).toBeGreaterThanOrEqual(0);
    expect(full.avgFrameMs).toBeGreaterThanOrEqual(0);
    // One visible pane: 3 main + 2 overlay layers, plus the time axis (main and overlay).
    expect(full.layersDrawn).toBe(7);
    expect(full.barsDrawn).toBeGreaterThan(0);
    expect(full.barsDrawn).toBeLessThanOrEqual(300);
    // A crosshair-only frame redraws the overlays and no bars.
    chart.invalidate(1);
    runFrames();
    const overlay = chart.getRenderStats();
    expect(overlay.frames).toBe(full.frames + 1);
    expect(overlay.layersDrawn).toBe(3);
    expect(overlay.barsDrawn).toBe(0);
  });

  it('records performance measures only while profiling', async () => {
    const { Chart } = await import('./chart');
    const chart = new Chart(new FakeEl() as unknown as HTMLElement, feed);
    charts.push(chart);
    await chart.setSymbol('TEST');
    performance.clearMeasures('tickerglass:render');
    runFrames();
    expect(performance.getEntriesByName('tickerglass:render')).toHaveLength(0);
    chart.setProfiling(true);
    chart.invalidate(1);
    runFrames();
    expect(performance.getEntriesByName('tickerglass:render')).toHaveLength(1);
    performance.clearMeasures('tickerglass:render');
  });
});

describe('destroy', () => {
  it('does not subscribe to live bars when a load finishes after destroy', async () => {
    const { Chart } = await import('./chart');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let subscribed = 0;
    const slow: DataFeed = {
      ...feed,
      getBars: async () => {
        await gate;
        return { bars: columns(50), hasMore: false };
      },
      subscribe: () => {
        subscribed++;
        return () => undefined;
      },
    };
    const chart = new Chart(new FakeEl() as unknown as HTMLElement, slow);
    const loading = chart.setSymbol('TEST');
    await Promise.resolve();
    chart.destroy();
    release();
    await loading;
    expect(subscribed).toBe(0);
    expect(chart.store.length).toBe(0);
  });
});
