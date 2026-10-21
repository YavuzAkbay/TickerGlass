import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chart } from '../chart';
import { InteractionController, KEY_BINDINGS } from './controller';

type KeyListener = (e: unknown) => void;

function setup() {
  const listeners = new Map<string, KeyListener>();
  const root = {
    addEventListener: (type: string, fn: KeyListener) => listeners.set(type, fn),
  };
  const timeScale = { barSpacing: 6, pan: vi.fn(), zoom: vi.fn() };
  const chart = {
    root,
    timeScale,
    paneWidth: 500,
    drawingInput: { key: () => false },
    scrollToRealtime: vi.fn(),
    resetView: vi.fn(),
    viewChanged: vi.fn(),
    viewSettled: vi.fn(),
  };
  const ctl = new InteractionController(chart as unknown as Chart);
  const press = (key: string, mods: { altKey?: boolean; shiftKey?: boolean } = {}) => {
    const e = { key, altKey: false, shiftKey: false, ...mods, preventDefault: vi.fn() };
    listeners.get('keydown')!(e);
    return e;
  };
  return { ctl, chart, timeScale, press };
}

describe('InteractionController keyboard', () => {
  it('pans and zooms with plain arrow keys', () => {
    const { timeScale, press } = setup();
    expect(press('ArrowRight').preventDefault).toHaveBeenCalled();
    expect(timeScale.pan).toHaveBeenCalledWith(-6);
    expect(press('ArrowUp').preventDefault).toHaveBeenCalled();
    expect(timeScale.zoom).toHaveBeenCalledTimes(1);
  });

  it('passes Alt+arrow keys through to the app', () => {
    const { timeScale, chart, press } = setup();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      for (const shiftKey of [false, true]) {
        const e = press(key, { altKey: true, shiftKey });
        expect(e.preventDefault).not.toHaveBeenCalled();
      }
    }
    expect(timeScale.pan).not.toHaveBeenCalled();
    expect(timeScale.zoom).not.toHaveBeenCalled();
    expect(chart.viewChanged).not.toHaveBeenCalled();
  });

  it('Alt+R resets the view but Shift+Alt+R is left to the app', () => {
    const { chart, press } = setup();
    expect(press('r', { altKey: true }).preventDefault).toHaveBeenCalled();
    expect(chart.resetView).toHaveBeenCalledTimes(1);
    expect(press('R', { altKey: true, shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(press('r', { altKey: true, shiftKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(press('r').preventDefault).not.toHaveBeenCalled();
    expect(chart.resetView).toHaveBeenCalledTimes(1);
  });
});

describe('InteractionController view change causes', () => {
  afterEach(() => vi.unstubAllGlobals());

  function gestureSetup(hit: unknown) {
    vi.stubGlobal('Element', class {}); // inLegendSlot() checks event targets
    const listeners = new Map<string, (e: unknown) => void>();
    const root = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      focus: vi.fn(),
      setPointerCapture: vi.fn(),
      style: {} as Record<string, string>,
    };
    const priceScale = { scaleBy: vi.fn(), autoScale: true };
    const chart = {
      root,
      timeScale: { pan: vi.fn(), zoom: vi.fn() },
      paneWidth: 500,
      options: { crosshair: 'cross' },
      drawingInput: {
        setPointerType: vi.fn(),
        pointerDown: () => false,
        cursor: () => null,
      },
      drawingTarget: () => null,
      hitTest: () => ({ ...(hit as object), pane: { priceScale } }),
      isStudy: () => false,
      viewChanged: vi.fn(),
      viewSettled: vi.fn(),
      setCrosshair: vi.fn(),
    };
    new InteractionController(chart as unknown as Chart);
    const fire = (type: string, e: object) =>
      listeners.get(type)!({ button: 0, pointerType: 'mouse', pointerId: 1, ...e });
    return { chart, priceScale, fire };
  }

  it('a price-axis drag emits "price", not "user"', () => {
    const { chart, priceScale, fire } = gestureSetup({ kind: 'priceAxis', plus: false });
    fire('pointerdown', { clientX: 490, clientY: 100 });
    fire('pointermove', { clientX: 490, clientY: 120 });
    expect(priceScale.scaleBy).toHaveBeenCalled();
    expect(chart.timeScale.pan).not.toHaveBeenCalled();
    expect(chart.viewChanged.mock.calls).toEqual([['price']]);
  });

  it('a price-axis wheel emits "price"; a time-axis drag emits "user"', () => {
    const a = gestureSetup({ kind: 'priceAxis' });
    a.fire('wheel', {
      clientX: 490,
      clientY: 100,
      deltaX: 0,
      deltaY: 10,
      deltaMode: 0,
      preventDefault: vi.fn(),
    });
    expect(a.chart.viewChanged.mock.calls).toEqual([['price']]);
    const b = gestureSetup({ kind: 'timeAxis' });
    b.fire('pointerdown', { clientX: 100, clientY: 490 });
    b.fire('pointermove', { clientX: 120, clientY: 490 });
    expect(b.chart.viewChanged.mock.calls).toEqual([['user']]);
  });
});

describe('KEY_BINDINGS', () => {
  it('describes the chart navigation keys', () => {
    expect(KEY_BINDINGS.map((b) => b.key)).toEqual([
      'Left',
      'Right',
      'Up or +',
      'Down or -',
      'End',
      'Alt+R',
    ]);
    for (const b of KEY_BINDINGS) {
      expect(b.description).not.toBe('');
      expect(b.group).toBe('Chart navigation');
    }
  });
});
