import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chart } from '../chart';
import { InteractionController, KEY_BINDINGS, LONG_PRESS_MS } from './controller';

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

  it('a mouse-wheel notch zooms part now and eases the rest in; the total is unchanged', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const { chart, fire } = gestureSetup({ kind: 'pane', y: 100 });
    const wheel = { clientX: 200, clientY: 100, deltaX: 0, deltaY: -100, deltaMode: 0 };
    fire('wheel', { ...wheel, preventDefault: vi.fn() });
    const zoom = chart.timeScale.zoom;
    expect(zoom).toHaveBeenCalledTimes(1);
    const log = (i: number) => Math.log(zoom.mock.calls[i]![1] as number);
    expect(log(0)).toBeCloseTo(0.15 * 0.45);
    while (frames.length) frames.shift()!(0);
    const total = zoom.mock.calls.reduce((sum, _c, i) => sum + log(i), 0);
    expect(total).toBeCloseTo(0.15);
    expect(zoom.mock.calls.every((c) => c[0] === 200)).toBe(true);
    // Trackpad-sized deltas still zoom in one go.
    zoom.mockClear();
    fire('wheel', { ...wheel, deltaY: -8, preventDefault: vi.fn() });
    expect(zoom).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
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

describe('InteractionController touch gestures', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function touchSetup(hitKind: 'pane' | 'timeAxis' | 'priceAxis' = 'pane', onDrawing = false) {
    vi.useFakeTimers();
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const listeners = new Map<string, (e: unknown) => void>();
    const root = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      focus: vi.fn(),
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
      style: {} as Record<string, string>,
    };
    const pane = { id: 'main', top: 0, priceScale: { autoScale: true, panBy: vi.fn() } };
    const chart = {
      root,
      timeScale: { pan: vi.fn(), zoom: vi.fn() },
      paneWidth: 500,
      options: { crosshair: 'cross' },
      drawingInput: {
        setPointerType: vi.fn(),
        pointerDown: () => onDrawing,
        pointerMove: vi.fn(),
        pointerUp: vi.fn(),
        holdPress: vi.fn(() => true),
        contextMenu: vi.fn(() => onDrawing),
        doubleClick: vi.fn(() => false),
        clickEmpty: vi.fn(),
        cursor: () => null,
      },
      drawingTarget: () => null,
      hitTest: (x: number, y: number) => ({ kind: hitKind, pane, x, y }),
      isStudy: () => false,
      hoverStudy: vi.fn(),
      emitOverlayClick: () => false,
      emitStudyPointer: vi.fn(),
      describePoint: (x: number, y: number) => ({ x, y }),
      events: { emit: vi.fn() },
      setAutoScale: vi.fn(),
      resetView: vi.fn(),
      viewChanged: vi.fn(),
      viewSettled: vi.fn(),
      setCrosshair: vi.fn(),
    };
    new InteractionController(chart as unknown as Chart);
    let t = 0;
    const fire = (type: string, id: number, x: number, y: number, pointerType = 'touch') =>
      listeners.get(type)!({
        button: 0,
        pointerType,
        pointerId: id,
        clientX: x,
        clientY: y,
        timeStamp: (t += 16),
        preventDefault: vi.fn(),
      });
    const native = (type: string) =>
      listeners.get(type)!({ clientX: 100, clientY: 100, preventDefault: vi.fn() });
    return { chart, fire, native };
  }

  it('pinching two fingers apart zooms in around their midpoint', () => {
    const { chart, fire } = touchSetup();
    fire('pointerdown', 1, 100, 100);
    fire('pointerdown', 2, 200, 100);
    fire('pointermove', 2, 300, 100);
    const zoom = chart.timeScale.zoom;
    expect(zoom).toHaveBeenCalledTimes(1);
    const [x, factor] = zoom.mock.calls[0]! as [number, number];
    expect(factor).toBeCloseTo(2);
    expect(x).toBe(200);
    // Pinching back zooms out.
    fire('pointermove', 2, 150, 100);
    expect((zoom.mock.calls[1]! as [number, number])[1]).toBeLessThan(1);
    // Lifting one finger keeps panning with the other, without a crosshair.
    fire('pointerup', 2, 150, 100);
    chart.setCrosshair.mockClear();
    chart.timeScale.pan.mockClear();
    fire('pointermove', 1, 130, 100);
    expect(chart.timeScale.pan).toHaveBeenCalledWith(30);
    expect(chart.setCrosshair).not.toHaveBeenCalled();
  });

  it('a long-press shows the crosshair and follows the finger', () => {
    const { chart, fire } = touchSetup();
    fire('pointerdown', 1, 100, 100);
    expect(chart.setCrosshair).toHaveBeenLastCalledWith(null, 0, 0);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(chart.setCrosshair).toHaveBeenLastCalledWith(expect.anything(), 100, 100);
    chart.timeScale.pan.mockClear();
    fire('pointermove', 1, 160, 120);
    expect(chart.setCrosshair).toHaveBeenLastCalledWith(expect.anything(), 160, 120);
    expect(chart.timeScale.pan).not.toHaveBeenCalled();
    fire('pointerup', 1, 160, 120);
    expect(chart.events.emit).not.toHaveBeenCalled();
  });

  it('a long-press released in place opens the context menu', () => {
    const { chart, fire } = touchSetup();
    fire('pointerdown', 1, 100, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire('pointerup', 1, 102, 101);
    expect(chart.events.emit).toHaveBeenCalledWith('contextMenu', { x: 100, y: 100 });
  });

  it('a long-press on a drawing opens its menu', () => {
    const { chart, fire } = touchSetup('pane', true);
    fire('pointerdown', 1, 100, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(chart.drawingInput.holdPress).toHaveBeenCalled();
    fire('pointerup', 1, 100, 100);
    expect(chart.drawingInput.contextMenu).toHaveBeenCalledWith(null, 100, 100);
    expect(chart.drawingInput.pointerUp).not.toHaveBeenCalled();
  });

  it('moving before the long-press delay pans instead', () => {
    const { chart, fire } = touchSetup();
    fire('pointerdown', 1, 100, 100);
    fire('pointermove', 1, 140, 100);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fire('pointerup', 1, 140, 100);
    expect(chart.timeScale.pan).toHaveBeenCalledWith(40);
    expect(chart.setCrosshair).not.toHaveBeenCalledWith(expect.anything(), 140, 100);
    expect(chart.events.emit).not.toHaveBeenCalled();
  });

  it('a double-tap on the time axis resets the view; touch ignores native dblclick and contextmenu', () => {
    const { chart, fire, native } = touchSetup('timeAxis');
    fire('pointerdown', 1, 100, 490);
    fire('pointerup', 1, 100, 490);
    expect(chart.resetView).not.toHaveBeenCalled();
    fire('pointerdown', 1, 104, 492);
    fire('pointerup', 1, 104, 492);
    expect(chart.resetView).toHaveBeenCalledTimes(1);
    native('dblclick');
    native('contextmenu');
    expect(chart.resetView).toHaveBeenCalledTimes(1);
    expect(chart.events.emit).not.toHaveBeenCalled();
  });

  it('mouse keeps native dblclick and contextmenu and has no long-press', () => {
    const { chart, fire, native } = touchSetup('priceAxis');
    fire('pointerdown', 1, 490, 100, 'mouse');
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    fire('pointerup', 1, 490, 100, 'mouse');
    expect(chart.events.emit).not.toHaveBeenCalled();
    native('dblclick');
    expect(chart.setAutoScale).toHaveBeenCalledWith('main', true);
    native('contextmenu');
    expect(chart.events.emit).toHaveBeenCalledWith('contextMenu', { x: 100, y: 100 });
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
