import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_THEME, type MagnetMode } from '../options';
import { PriceScale } from '../scale/price-scale';
import { TimeScale } from '../scale/time-scale';
import type { DrawingPane } from './geometry';
import { HANDLE_RADIUS } from './draw-utils';
import {
  DrawingInteraction,
  ERASER_TOOL,
  MEASURE_TOOL,
  PICK_TOOL,
  ZOOM_TOOL,
  type DrawingPointerMods,
} from './interaction';
import { DrawingLayer, type DrawingHost } from './layer';
import type { AnchorTimeline } from './mapping';
import { defineDrawingTool, registerDrawingTool } from './registry';
import { polylineDistance } from './shape-utils';
import type { Drawing, DrawingAxisLabel, DrawingEvents } from './types';
import { trendLine } from './tools';

const D = 86_400;
const START = 1_700_000_000;
const N = 100;
const NO: DrawingPointerMods = { shift: false, alt: false, mod: false };

type Ev = { [K in keyof DrawingEvents]: [K, DrawingEvents[K]] }[keyof DrawingEvents];

let ts: TimeScale;
let pane: DrawingPane;
let events: Ev[];
let zooms: unknown[][];
let layer: DrawingLayer;
let input: DrawingInteraction;
/** Mutable host state (symbol/interval/magnet) read through getters. */
let env: {
  symbol: string;
  interval: string;
  magnet: MagnetMode;
  values: (index: number) => number[];
};

/** x of bar i, y of price p (pane at the root top, no scale margins). */
const X = (i: number) => ts.indexToX(i);
const Y = (p: number) => pane.priceScale.priceToY(p);
const names = () => events.map((e) => e[0]);
const of = <K extends keyof DrawingEvents>(k: K) =>
  events.filter((e) => e[0] === k).map((e) => e[1] as DrawingEvents[K]);

function target(x: number, y: number) {
  const h = layer.hitTest(pane, x, y);
  return { pane, drawing: h.strong ?? h.weak };
}
const down = (x: number, y: number) => input.pointerDown(target(x, y), x, y, NO);
const move = (x: number, y: number) => input.pointerMove(x, y, NO);
const hover = (x: number, y: number) => input.hover(target(x, y), x, y, NO);
const up = (x: number, y: number) => input.pointerUp(x, y, NO);
const click = (x: number, y: number) => {
  down(x, y);
  up(x, y);
};

beforeEach(() => {
  ts = new TimeScale();
  ts.width = 800;
  ts.barSpacing = 10;
  ts.baseIndex = N - 1;
  ts.rightOffset = 0;
  const ps = new PriceScale();
  ps.height = 400;
  ps.marginTop = 0;
  ps.marginBottom = 0;
  ps.min = 0;
  ps.max = 100;
  pane = { id: 'main', priceScale: ps, height: 400, top: 0 };
  const tl: AnchorTimeline = {
    time: Float64Array.from({ length: N }, (_, i) => START + i * D),
    length: N,
    interval: { unit: 'day', count: 1 },
    bricks: false,
    endTime: START + (N - 1) * D,
  };
  events = [];
  zooms = [];
  env = { symbol: 'TEST', interval: '1D', magnet: 'off', values: () => [] };
  const host: DrawingHost = {
    timeScale: ts,
    theme: DARK_THEME,
    paneWidth: 800,
    get symbol() {
      return env.symbol;
    },
    get interval() {
      return env.interval;
    },
    get magnet() {
      return env.magnet;
    },
    magnetValues: (_paneId, index) => env.values(index),
    timeline: () => tl,
    pane: (id) => (id === pane.id ? pane : null),
    format: () => ({ price: (v) => v.toFixed(2), percent: (v) => `${v}%`, time: String }),
    invalidate: () => undefined,
    zoomTo: (...a) => zooms.push(a),
    emit: (k, p) => events.push([k, p] as Ev),
  };
  layer = new DrawingLayer(host);
  input = new DrawingInteraction(layer);
});

describe('creation state machine', () => {
  it('creates a trend line with click-click (anchor 2 follows the pointer)', () => {
    input.setActiveTool('trend-line');
    click(X(50), Y(40));
    expect(layer.draft?.points).toHaveLength(2);
    hover(X(60), Y(60));
    expect(layer.draft?.points[1]).toEqual({ time: START + 60 * D, price: 60 });
    expect(layer.items.size).toBe(0);
    click(X(60), Y(60));
    expect(names()).toEqual(['drawingCreated', 'selectionChanged', 'toolFinished']);
    const d = of('drawingCreated')[0]!.drawing;
    expect(d.points).toEqual([
      { time: START + 50 * D, price: 40 },
      { time: START + 60 * D, price: 60 },
    ]);
    expect(d.style.extendRight).toBe(false);
    expect(of('toolFinished')[0]).toEqual({ type: 'trend-line', drawingId: d.id, active: false });
    expect(input.activeTool).toBeNull();
    expect(layer.draft).toBeNull();
  });

  it('creates a trend line with press-drag-release', () => {
    input.setActiveTool('trend-line');
    down(X(10), Y(20));
    move(X(15), Y(30));
    move(X(20), Y(50));
    up(X(20), Y(50));
    const d = of('drawingCreated')[0]!.drawing;
    expect(d.points.map((p) => p.price)).toEqual([20, 50]);
    expect(d.points[1]!.time).toBe(START + 20 * D);
  });

  it('snaps anchors to bar slots', () => {
    input.setActiveTool('trend-line');
    click(X(10) + 3, Y(20));
    click(X(12) - 4, Y(20));
    const d = of('drawingCreated')[0]!.drawing;
    expect(d.points.map((p) => p.time)).toEqual([START + 10 * D, START + 12 * D]);
  });

  it('creates a horizontal line with a single click and keeps the tool in stay mode', () => {
    layer.options.stayInDrawingMode = true;
    input.setActiveTool('horizontal-line');
    click(X(30), Y(75));
    expect(of('drawingCreated')[0]!.drawing.points[0]!.price).toBe(75);
    expect(of('toolFinished')[0]!.active).toBe(true);
    expect(input.activeTool).toBe('horizontal-line');
    click(X(40), Y(25));
    expect(layer.items.size).toBe(2);
  });

  it('places anchors past the last bar', () => {
    input.setActiveTool('trend-line');
    click(X(N - 1), Y(50));
    click(X(N + 4), Y(50));
    expect(of('drawingCreated')[0]!.drawing.points[1]!.time).toBe(START + (N + 4) * D);
  });

  it('Esc cancels a creation and leaves the tool', () => {
    input.setActiveTool('trend-line');
    click(X(10), Y(20));
    expect(input.key('Escape')).toBe(true);
    expect(layer.draft).toBeNull();
    expect(layer.items.size).toBe(0);
    expect(names()).toEqual(['toolFinished']);
    expect(of('toolFinished')[0]).toEqual({ type: 'trend-line', drawingId: null, active: false });
    expect(input.activeTool).toBeNull();
  });

  it('setActiveTool rejects unknown tools and cancels drafts silently', () => {
    expect(() => input.setActiveTool('nope')).toThrow();
    input.setActiveTool('trend-line');
    click(X(10), Y(20));
    input.setActiveTool(null);
    expect(layer.draft).toBeNull();
    expect(events).toEqual([]);
  });
});

describe('editing gestures', () => {
  function addLine(locked = false) {
    return layer.insert(
      layer.build({
        type: 'trend-line',
        points: [
          { time: START + 20 * D, price: 20 },
          { time: START + 40 * D, price: 60 },
        ],
        locked,
      }),
    );
  }

  it('API mutations emit no mutation events', () => {
    const d = addLine();
    layer.update(d.id, { style: { lineColor: '#fff' } });
    expect(layer.items.get(d.id)!.style.lineWidth).toBe(2); // merged, not replaced
    layer.remove([d.id]);
    expect(events).toEqual([]);
  });

  it('selects on click and emits exactly one drawingChanged per body drag', () => {
    const d = addLine();
    const mx = X(30);
    const my = Y(40);
    down(mx, my);
    expect(layer.selection.has(d.id)).toBe(true);
    for (let k = 1; k <= 10; k++) move(mx + k * 5, my - k * 4); // live preview
    expect(layer.items.get(d.id)!.points[0]!.time).toBe(START + 25 * D);
    expect(of('drawingChanged')).toHaveLength(0);
    up(mx + 50, my - 40);
    const changed = of('drawingChanged');
    expect(changed).toHaveLength(1);
    const [c] = changed[0]!.changes;
    expect(c!.before.points[0]).toEqual({ time: START + 20 * D, price: 20 });
    expect(c!.after.points[0]!.time).toBe(START + 25 * D);
    expect(c!.after.points[0]!.price).toBeCloseTo(30, 9);
    expect(c!.after.points[1]!.price).toBeCloseTo(70, 9);
    expect(names()).toEqual(['selectionChanged', 'drawingDrag', 'drawingDrag', 'drawingChanged']);
  });

  it('a click without movement changes nothing', () => {
    addLine();
    click(X(30), Y(40));
    expect(names()).toEqual(['selectionChanged']);
  });

  it('drags one anchor via its handle', () => {
    const d = addLine();
    down(X(40), Y(60));
    move(X(45), Y(80));
    up(X(45), Y(80));
    const [c] = of('drawingChanged')[0]!.changes;
    expect(c!.after.points[0]).toEqual(d.points[0]);
    expect(c!.after.points[1]).toEqual({ time: START + 45 * D, price: 80 });
  });

  it('horizontal line drags keep the anchor time', () => {
    const d = layer.insert(
      layer.build({ type: 'horizontal-line', points: [{ time: START + 10 * D, price: 50 }] }),
    );
    down(X(70), Y(50));
    move(X(90), Y(30));
    up(X(90), Y(30));
    expect(layer.items.get(d.id)!.points[0]).toEqual({ time: START + 10 * D, price: 30 });
  });

  it('locked drawings select but do not move; Esc restores a drag', () => {
    const locked = addLine(true);
    down(X(30), Y(40));
    move(X(60), Y(10));
    up(X(60), Y(10));
    expect(layer.items.get(locked.id)!.points[0]!.price).toBe(20);
    expect(of('drawingChanged')).toHaveLength(0);
    layer.update(locked.id, { locked: false });
    down(X(30), Y(40));
    move(X(60), Y(10));
    input.key('Escape');
    up(X(60), Y(10));
    expect(layer.items.get(locked.id)!.points[0]!.price).toBe(20);
    expect(of('drawingChanged')).toHaveLength(0);
  });

  it('Delete removes selected unlocked drawings; Esc clears the selection', () => {
    const a = addLine();
    const b = addLine(true);
    layer.setSelection([a.id, b.id]);
    expect(input.key('Delete')).toBe(true);
    expect(of('drawingsRemoved')[0]!.drawings.map((d) => d.id)).toEqual([a.id]);
    expect([...layer.selection]).toEqual([b.id]);
    expect(input.key('Escape')).toBe(true);
    expect(layer.selection.size).toBe(0);
    expect(input.key('Escape')).toBe(false);
  });

  it('right-click selects and emits drawingContextMenu; double-click emits drawingDoubleClick', () => {
    const d = addLine();
    expect(input.contextMenu(target(X(30), Y(40)), 1, 2)).toBe(true);
    expect(of('drawingContextMenu')[0]).toMatchObject({ id: d.id, paneId: 'main' });
    expect(input.doubleClick(target(X(30), Y(40)), 1, 2)).toBe(true);
    expect(input.contextMenu(target(X(80), Y(90)), 1, 2)).toBe(false);
  });
});

describe('hit testing', () => {
  it('finds strokes, handles first, and respects extend/hidden/hideAll', () => {
    const d = layer.insert(
      layer.build({
        type: 'trend-line',
        points: [
          { time: START + 20 * D, price: 20 },
          { time: START + 40 * D, price: 60 },
        ],
      }),
    );
    expect(layer.hitTest(pane, X(30), Y(40)).strong?.part).toEqual({ kind: 'body' });
    expect(layer.hitTest(pane, X(30), Y(40) + 20).strong).toBeNull();
    expect(layer.hitTest(pane, X(20), Y(20)).strong?.part).toEqual({ kind: 'handle', index: 0 });
    expect(layer.hitTest(pane, X(50), Y(80)).strong).toBeNull();
    layer.update(d.id, { style: { extendRight: true } });
    expect(layer.hitTest(pane, X(50), Y(80)).strong?.id).toBe(d.id);
    layer.update(d.id, { locked: true });
    expect(layer.hitTest(pane, X(20), Y(20)).strong?.part).toEqual({ kind: 'body' });
    layer.options.hideAll = true;
    expect(layer.hitTest(pane, X(30), Y(40)).strong).toBeNull();
    layer.options.hideAll = false;
    layer.update(d.id, { hidden: true });
    expect(layer.hitTest(pane, X(30), Y(40)).strong).toBeNull();
  });

  it('hits the topmost drawing by zIndex', () => {
    const mk = (zIndex: number) =>
      layer.insert(
        layer.build({ type: 'horizontal-line', points: [{ time: START, price: 50 }], zIndex }),
      );
    mk(5);
    const top = mk(9);
    mk(1);
    expect(layer.hitTest(pane, X(70), Y(50)).strong?.id).toBe(top.id);
  });

  it('renders without throwing and collects axis labels', () => {
    const d = layer.insert(
      layer.build({ type: 'horizontal-line', points: [{ time: START, price: 50 }], text: 'hi' }),
    );
    layer.insert(
      layer.build({
        type: 'trend-line',
        points: [
          { time: START + 20 * D, price: 20 },
          { time: START + 40 * D, price: 60 },
        ],
        text: 'x',
        style: {
          showPriceRange: true,
          showBarsRange: true,
          showAngle: true,
          showMiddlePoint: true,
        },
      }),
    );
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) =>
          k === 'measureText' ? () => ({ width: 10 }) : (..._a: unknown[]) => calls.push(String(k)),
        set: () => true,
      },
    ) as CanvasRenderingContext2D;
    layer.setSelection([...layer.items.keys()]);
    layer.render(pane, ctx, 2);
    expect(calls).toContain('stroke');
    expect(calls).toContain('fillText');
    const labels: DrawingAxisLabel[] = [];
    layer.axisLabels('price', pane, labels);
    expect(labels.map((l) => l.value)).toEqual([50, 20, 60]);
    const times: DrawingAxisLabel[] = [];
    layer.axisLabels('time', null, times);
    expect(times.map((l) => l.value)).toEqual([START + 20 * D, START + 40 * D]);
    expect(d.text).toBe('hi');
  });
});

// ------------------------------------------------------------ editing (B)

const SHIFT: DrawingPointerMods = { shift: true, alt: false, mod: false };
const ALT: DrawingPointerMods = { shift: false, alt: true, mod: false };
const MOD: DrawingPointerMods = { shift: false, alt: false, mod: true };
const downM = (x: number, y: number, m: DrawingPointerMods) =>
  input.pointerDown(target(x, y), x, y, m);
const clickM = (x: number, y: number, m: DrawingPointerMods) => {
  downM(x, y, m);
  input.pointerUp(x, y, m);
};

function line(a = 20, b = 40, pa = 20, pb = 60, extra: Partial<Drawing> = {}) {
  return layer.insert(
    layer.build({
      type: 'trend-line',
      points: [
        { time: START + a * D, price: pa },
        { time: START + b * D, price: pb },
      ],
      ...extra,
    }),
  );
}
const hline = (price: number, extra: Partial<Drawing> = {}) =>
  layer.insert(
    layer.build({ type: 'horizontal-line', points: [{ time: START, price }], ...extra }),
  );

describe('multi-select and multi-drag', () => {
  it('Shift-click toggles drawings in the selection', () => {
    const a = line();
    const b = hline(80);
    click(X(30), Y(40));
    clickM(X(70), Y(80), SHIFT);
    expect([...layer.selection]).toEqual([a.id, b.id]);
    clickM(X(30), Y(40), SHIFT);
    expect([...layer.selection]).toEqual([b.id]);
    // A plain click on a selected drawing keeps the multi-selection.
    clickM(X(30), Y(40), SHIFT);
    click(X(30), Y(40));
    expect(layer.selection.size).toBe(2);
  });

  it('Shift+drag on a selected drawing moves the selection instead of deselecting it', () => {
    const a = line();
    const b = hline(80);
    layer.setSelection([a.id, b.id]);
    events = [];
    downM(X(30), Y(40), SHIFT);
    input.pointerMove(X(30) + 2, Y(40) - 40, SHIFT); // past the slop, mostly vertical
    input.pointerUp(X(30) + 2, Y(40) - 40, SHIFT);
    expect(layer.selection.size).toBe(2);
    const [ch] = of('drawingChanged');
    expect(ch!.changes.map((c) => c.after.id)).toEqual([a.id, b.id]);
    // Shift locks to the dominant (vertical) axis: times unchanged.
    expect(layer.items.get(a.id)!.points[0]).toEqual({ time: START + 20 * D, price: 30 });
    expect(layer.items.get(b.id)!.points[0]!.price).toBeCloseTo(90, 9);
  });

  it('drags a multi-selection with one drawingChanged per gesture, skipping locked ones', () => {
    const a = line();
    const b = line(60, 70, 10, 10);
    const c = line(60, 70, 90, 90, { locked: true });
    layer.setSelection([a.id, b.id, c.id]);
    events = [];
    down(X(30), Y(40));
    for (let k = 1; k <= 5; k++) move(X(30) + k * 10, Y(40));
    up(X(80), Y(40));
    expect(names()).toEqual(['drawingDrag', 'drawingDrag', 'drawingChanged']);
    expect(of('drawingDrag')[0]!.ids).toEqual([a.id, b.id]);
    const changes = of('drawingChanged')[0]!.changes;
    expect(changes.map((x) => x.before.id)).toEqual([a.id, b.id]);
    expect(changes[1]!.after.points[0]!.time).toBe(START + 65 * D);
    expect(layer.items.get(c.id)!.points[0]!.time).toBe(START + 60 * D);
  });
});

describe('clone (Alt+drag)', () => {
  it('clones the pressed selection: originals unchanged, one drawingCreated per clone', () => {
    const a = line();
    const b = line(60, 70, 10, 10);
    layer.setSelection([a.id, b.id]);
    events = [];
    downM(X(30), Y(40), ALT);
    input.pointerMove(X(35), Y(40), NO); // Alt may be released after the press
    input.pointerMove(X(40), Y(40), NO);
    expect(of('drawingCreated')).toHaveLength(0);
    input.pointerUp(X(40), Y(40), NO);
    expect(layer.items.size).toBe(4);
    expect(layer.items.get(a.id)!.points[0]!.time).toBe(START + 20 * D);
    const created = of('drawingCreated').map((e) => e.drawing);
    expect(created).toHaveLength(2);
    expect(created[0]!.points[0]!.time).toBe(START + 30 * D);
    expect(created[1]!.points[0]!.time).toBe(START + 70 * D);
    expect(created.every((d) => d.id !== a.id && d.id !== b.id)).toBe(true);
    expect(created[0]!.zIndex).toBeGreaterThan(b.zIndex);
    expect([...layer.selection]).toEqual(created.map((d) => d.id));
    expect(of('drawingChanged')).toHaveLength(0);
    expect(names()).toEqual([
      'selectionChanged',
      'drawingDrag',
      'drawingDrag',
      'drawingCreated',
      'drawingCreated',
    ]);
  });

  it('Esc during a clone drag removes the clones without mutation events', () => {
    const a = line();
    click(X(30), Y(40));
    events = [];
    downM(X(30), Y(40), ALT);
    move(X(50), Y(40));
    expect(layer.items.size).toBe(2);
    input.key('Escape');
    up(X(50), Y(40));
    expect([...layer.items.keys()]).toEqual([a.id]);
    expect([...layer.selection]).toEqual([a.id]);
    expect(names()).not.toContain('drawingCreated');
  });

  it('does not clone locked drawings', () => {
    line(20, 40, 20, 60, { locked: true });
    downM(X(30), Y(40), ALT);
    move(X(50), Y(40));
    up(X(50), Y(40));
    expect(layer.items.size).toBe(1);
  });
});

describe('z-order', () => {
  it('front/back/forward/backward return the zIndex changes', () => {
    const a = hline(10);
    const b = hline(20);
    const c = hline(30);
    const order = () => layer.list().map((d) => d.id);
    expect(order()).toEqual([a.id, b.id, c.id]);
    const ch = layer.reorder([a.id], 'front');
    expect(ch).toHaveLength(1);
    expect(ch[0]!.before.zIndex).toBe(1);
    expect(order()).toEqual([b.id, c.id, a.id]);
    expect(layer.reorder([a.id], 'front')).toEqual([]);
    layer.reorder([a.id], 'back');
    expect(order()).toEqual([a.id, b.id, c.id]);
    const fw = layer.reorder([a.id], 'forward');
    expect(order()).toEqual([b.id, a.id, c.id]);
    expect(fw.map((x) => x.after.id).sort()).toEqual([a.id, b.id].sort());
    layer.reorder([c.id], 'backward');
    expect(order()).toEqual([b.id, c.id, a.id]);
    expect(layer.reorder([b.id], 'backward')).toEqual([]);
    expect(layer.reorder(['nope'], 'front')).toEqual([]);
    expect(events.filter((e) => e[0] !== 'selectionChanged')).toEqual([]);
  });

  it('reorders within the pane only and renumbers ties', () => {
    const a = hline(10, { zIndex: 1 });
    const b = hline(20, { zIndex: 1 });
    const other = hline(30, { zIndex: 5, paneId: 'study' });
    layer.reorder([a.id], 'forward');
    expect(
      layer
        .list()
        .filter((d) => d.paneId === 'main')
        .map((d) => d.id),
    ).toEqual([b.id, a.id]);
    expect(layer.items.get(other.id)!.zIndex).toBe(5);
    layer.reorder([b.id], 'front');
    expect(layer.items.get(b.id)!.zIndex).toBe(3); // above a (2), not the other pane
  });
});

describe('magnet and Shift constraints', () => {
  // Bar OHLC: O 40, H 45, L 30, C 42.
  beforeEach(() => {
    env.values = () => [40, 45, 30, 42];
  });

  const createLine = (y1: number, x2: number, y2: number, m: DrawingPointerMods = NO) => {
    input.setActiveTool('trend-line');
    input.pointerDown(target(X(10), y1), X(10), y1, NO);
    input.pointerUp(X(10), y1, NO);
    input.hover(target(x2, y2), x2, y2, m);
    input.pointerDown(target(x2, y2), x2, y2, m);
    input.pointerUp(x2, y2, m);
    return of('drawingCreated').at(-1)!.drawing.points;
  };

  it('weak snaps within 20 px, strong always, off never', () => {
    env.magnet = 'weak';
    let pts = createLine(Y(44), X(20), Y(60));
    expect(pts[0]!.price).toBe(45); // 4 px away
    expect(pts[1]!.price).toBeCloseTo(60, 9); // 60 px from 45: unchanged
    env.magnet = 'strong';
    pts = createLine(Y(70), X(20), Y(5));
    expect(pts.map((p) => p.price)).toEqual([45, 30]);
    env.magnet = 'off';
    pts = createLine(Y(44), X(20), Y(31));
    expect(pts[0]!.price).toBeCloseTo(44, 9);
  });

  it('Ctrl/Cmd toggles off <-> weak', () => {
    env.magnet = 'off';
    let pts = createLine(Y(44), X(20), Y(31), MOD);
    expect(pts[1]!.price).toBe(30);
    env.magnet = 'weak';
    pts = createLine(Y(44), X(20), Y(31), MOD);
    expect(pts[1]!.price).toBeCloseTo(31, 9);
  });

  it('applies to handle drags but not body drags', () => {
    env.magnet = 'strong';
    const a = line(20, 40, 20, 60);
    down(X(40), Y(60));
    move(X(45), Y(44));
    up(X(45), Y(44));
    expect(layer.items.get(a.id)!.points[1]!.price).toBe(45);
    down(X(30), Y(30)); // body: 12 px up = +3, no snapping to 45/30
    move(X(30), Y(30) - 12);
    up(X(30), Y(30) - 12);
    expect(layer.items.get(a.id)!.points[0]!.price).toBeCloseTo(23, 9);
  });

  it('Shift constrains a 2-point anchor to 45° steps', () => {
    // Horizontal.
    let pts = createLine(Y(20), X(20), Y(22), SHIFT);
    expect(pts[1]).toEqual({ time: START + 20 * D, price: 20 });
    // Vertical: x jumps to the first anchor's bar.
    pts = createLine(Y(20), X(11), Y(60), SHIFT);
    expect(pts[1]!.time).toBe(START + 10 * D);
    expect(pts[1]!.price).toBeCloseTo(60, 9);
    // Diagonal: 10 bars = 100 px right -> 100 px up = 25 price units.
    pts = createLine(Y(20), X(20), Y(44), SHIFT);
    expect(pts[1]!.time).toBe(START + 20 * D);
    expect(pts[1]!.price).toBeCloseTo(45, 9);
    // Handle drag of anchor 0 against anchor 1.
    const a = line(20, 40, 20, 60);
    downM(X(20), Y(20), SHIFT);
    input.pointerMove(X(25), Y(61), SHIFT);
    input.pointerUp(X(25), Y(61), SHIFT);
    expect(layer.items.get(a.id)!.points[0]!.price).toBeCloseTo(60, 9);
  });

  it('honours shiftConstraint: none and single-anchor tools', () => {
    trendLine.shiftConstraint = 'none';
    try {
      const pts = createLine(Y(20), X(20), Y(22), SHIFT);
      expect(pts[1]!.price).toBeCloseTo(22, 9);
    } finally {
      delete trendLine.shiftConstraint;
    }
    // Horizontal line (single anchor, axes 'price'): Shift does nothing to the price.
    input.setActiveTool('horizontal-line');
    clickM(X(30), Y(33), SHIFT);
    expect(of('drawingCreated').at(-1)!.drawing.points[0]!.price).toBeCloseTo(33, 9);
  });
});

describe('shown filter (scope, symbol, interval visibility)', () => {
  const vis = (days: boolean) => ({
    seconds: { enabled: true, min: 1, max: 59 },
    minutes: { enabled: true, min: 1, max: 59 },
    hours: { enabled: true, min: 1, max: 2 },
    days: { enabled: days, min: 1, max: 366 },
    weeks: { enabled: true, min: 1, max: 52 },
    months: { enabled: true, min: 1, max: 12 },
  });

  it('filters by symbol unless scope is all', () => {
    const own = hline(10);
    const other = hline(20, { symbol: 'MSFT' });
    const synced = hline(30, { symbol: 'MSFT', scope: 'all' });
    expect([own, other, synced].map((d) => layer.isShown(d))).toEqual([true, false, true]);
    expect(layer.hitTest(pane, X(50), Y(20)).strong).toBeNull();
    env.symbol = 'MSFT';
    expect([own, other, synced].map((d) => layer.isShown(d))).toEqual([false, true, true]);
  });

  it('filters by interval visibility (60m counts as 1h)', () => {
    const d = hline(10, { visibility: vis(false) });
    expect(layer.isShown(d)).toBe(false);
    env.interval = '60m';
    expect(layer.isShown(d)).toBe(true);
    env.interval = '4h';
    expect(layer.isShown(d)).toBe(false);
    env.interval = 'garbage';
    expect(layer.isShown(d)).toBe(true);
  });

  it('pruneSelection drops drawings that are no longer shown', () => {
    const d = hline(10);
    layer.setSelection([d.id]);
    env.symbol = 'OTHER';
    layer.pruneSelection();
    expect(layer.selection.size).toBe(0);
  });
});

describe('eraser', () => {
  it('click and drag remove unlocked drawings with one event per gesture', () => {
    const a = hline(10);
    const b = hline(20);
    const locked = hline(30, { locked: true });
    const c = hline(40);
    input.setActiveTool(ERASER_TOOL);
    expect(input.activeTool).toBe('eraser');
    click(X(50), Y(10));
    expect(of('drawingsRemoved')[0]!.drawings.map((d) => d.id)).toEqual([a.id]);
    down(X(50), Y(20));
    move(X(50), Y(30));
    move(X(50), Y(40));
    expect(of('drawingsRemoved')).toHaveLength(1);
    up(X(50), Y(40));
    expect(of('drawingsRemoved')[1]!.drawings.map((d) => d.id)).toEqual([b.id, c.id]);
    expect([...layer.items.keys()]).toEqual([locked.id]);
    expect(input.activeTool).toBe('eraser'); // stays active
    expect(input.key('Escape')).toBe(true);
    expect(of('toolFinished').at(-1)).toEqual({ type: 'eraser', drawingId: null, active: false });
  });
});

describe('zoom-in mode', () => {
  it('drags a box, zooms to its bars and prices, then returns to the cursor', () => {
    input.setActiveTool(ZOOM_TOOL);
    expect(input.activeTool).toBe('zoom-in');
    down(X(20), Y(80));
    move(X(40), Y(30));
    expect(layer.marquee).not.toBeNull();
    up(X(40), Y(30));
    expect(layer.marquee).toBeNull();
    expect(zooms).toHaveLength(1);
    const [id, from, to, lo, hi] = zooms[0] as [string, number, number, number, number];
    expect(id).toBe('main');
    expect(from).toBeCloseTo(20, 6);
    expect(to).toBeCloseTo(40, 6);
    expect(lo).toBeCloseTo(30, 6);
    expect(hi).toBeCloseTo(80, 6);
    expect(of('toolFinished')[0]).toEqual({ type: 'zoom-in', drawingId: null, active: false });
    expect(input.activeTool).toBeNull();
    expect(of('drawingCreated')).toHaveLength(0);
  });

  it('Esc cancels the drag, a second Esc leaves the mode; a click does nothing', () => {
    input.setActiveTool(ZOOM_TOOL);
    down(X(20), Y(80));
    move(X(40), Y(30));
    expect(input.key('Escape')).toBe(true);
    expect(layer.marquee).toBeNull();
    expect(input.activeTool).toBe('zoom-in');
    click(X(20), Y(80));
    expect(zooms).toHaveLength(0);
    expect(input.activeTool).toBe('zoom-in');
    expect(input.key('Escape')).toBe(true);
    expect(input.activeTool).toBeNull();
  });
});

describe('pick-point mode', () => {
  it('reports the clicked bar time and price once, then returns to the cursor', () => {
    input.setActiveTool(PICK_TOOL);
    click(X(30) + 2, Y(40));
    expect(of('pointPicked')).toEqual([{ time: START + 30 * D, price: 40, paneId: 'main' }]);
    expect(of('toolFinished')[0]).toEqual({ type: 'pick-point', drawingId: null, active: false });
    expect(input.activeTool).toBeNull();
    expect(layer.items.size).toBe(0);
  });
});

describe('measure mode', () => {
  it('shows a transient date and price range without drawing events, cleared by the next click', () => {
    input.setActiveTool(MEASURE_TOOL);
    down(X(10), Y(20));
    move(X(30), Y(60));
    up(X(30), Y(60));
    expect(layer.measure?.type).toBe('date-price-range');
    expect(layer.measure?.points.map((p) => p.price)).toEqual([20, 60]);
    expect(layer.items.size).toBe(0);
    expect(layer.draft).toBeNull();
    expect(names()).toEqual(['toolFinished']);
    expect(input.activeTool).toBeNull();
    // The next click clears it and is an ordinary click.
    expect(input.pointerDown(target(X(5), Y(5)), X(5), Y(5), NO)).toBe(false);
    expect(layer.measure).toBeNull();
  });

  it('click-click measures, Esc clears the result', () => {
    input.setActiveTool(MEASURE_TOOL);
    click(X(10), Y(20));
    hover(X(20), Y(50));
    click(X(20), Y(50));
    expect(layer.measure?.points).toHaveLength(2);
    expect(input.key('Escape')).toBe(true);
    expect(layer.measure).toBeNull();
    expect(of('drawingCreated')).toHaveLength(0);
  });

  it('Shift+click on empty space quick-measures from the cursor tool', () => {
    const SH: DrawingPointerMods = { shift: true, alt: false, mod: false };
    input.pointerDown(target(X(10), Y(20)), X(10), Y(20), SH);
    input.pointerUp(X(10), Y(20), SH);
    expect(layer.draft?.type).toBe('date-price-range');
    hover(X(25), Y(70));
    click(X(25), Y(70));
    expect(layer.measure?.points.map((p) => p.price)).toEqual([20, 70]);
    expect(layer.items.size).toBe(0);
    expect(of('drawingCreated')).toHaveLength(0);
  });
});

describe('box select (Shift+drag on empty space)', () => {
  const SH: DrawingPointerMods = { shift: true, alt: false, mod: false };
  const box = (x0: number, y0: number, x1: number, y1: number) => {
    expect(input.pointerDown(target(x0, y0), x0, y0, SH)).toBe(true);
    input.pointerMove(x1, y1, SH);
    expect(layer.marquee).not.toBeNull();
    input.pointerUp(x1, y1, SH);
    expect(layer.marquee).toBeNull();
  };

  it('selects drawings whose extent meets the box, adding to the selection', () => {
    const a = line(20, 40, 20, 60);
    const b = line(60, 70, 20, 30);
    const h = hline(90);
    // Plain drag on empty space is not a drawing gesture (pans).
    expect(input.pointerDown(target(X(5), Y(5)), X(5), Y(5), NO)).toBe(false);
    box(X(15), Y(70), X(45), Y(10));
    expect([...layer.selection]).toEqual([a.id]);
    // Horizontal lines span the pane width: any box crossing their price meets them.
    box(X(80), Y(95), X(85), Y(85));
    expect([...layer.selection].sort()).toEqual([a.id, h.id].sort());
    expect(layer.selection.has(b.id)).toBe(false);
    // A Shift-click (no drag) with a selection is multi-select: no quick measure.
    input.pointerDown(target(X(5), Y(5)), X(5), Y(5), SH);
    input.pointerUp(X(5), Y(5), SH);
    expect(layer.selection.size).toBe(2);
    expect(layer.draft).toBeNull();
    expect(input.busy).toBe(false);
    // Esc cancels a box without changes.
    input.pointerDown(target(X(5), Y(5)), X(5), Y(5), SH);
    input.pointerMove(X(75), Y(5), SH);
    expect(input.key('Escape')).toBe(true);
    expect(layer.marquee).toBeNull();
    expect(input.busy).toBe(false);
  });
});

describe('quick measure (Shift+click on empty space)', () => {
  const SH: DrawingPointerMods = { shift: true, alt: false, mod: false };
  const shiftClick = (x: number, y: number) => {
    input.pointerDown(target(x, y), x, y, SH);
    input.pointerUp(x, y, SH);
  };

  it('starts only with an empty selection; Esc cancels without toolFinished', () => {
    shiftClick(X(5), Y(5));
    expect(layer.draft?.type).toBe('date-price-range');
    expect(input.key('Escape')).toBe(true);
    expect(input.busy).toBe(false);
    expect(input.activeTool).toBeNull();
    expect(of('toolFinished')).toEqual([]);
  });

  it('finishing it leaves the tool alone and emits no toolFinished', () => {
    shiftClick(X(5), Y(5));
    input.pointerDown(target(X(20), Y(20)), X(20), Y(20), NO);
    input.pointerUp(X(20), Y(20), NO);
    expect(layer.measure).not.toBeNull();
    expect(input.activeTool).toBeNull();
    expect(of('toolFinished')).toEqual([]);
  });

  it('the Measure tool reports MEASURE_TOOL on cancel and on finish', () => {
    input.setActiveTool(MEASURE_TOOL);
    input.pointerDown(target(X(5), Y(5)), X(5), Y(5), NO);
    input.pointerUp(X(5), Y(5), NO);
    input.key('Escape');
    expect(of('toolFinished')).toEqual([{ type: MEASURE_TOOL, drawingId: null, active: false }]);
    events = [];
    input.setActiveTool(MEASURE_TOOL);
    input.pointerDown(target(X(5), Y(5)), X(5), Y(5), NO);
    input.pointerUp(X(5), Y(5), NO);
    input.pointerDown(target(X(20), Y(20)), X(20), Y(20), NO);
    input.pointerUp(X(20), Y(20), NO);
    expect(of('toolFinished')).toEqual([{ type: MEASURE_TOOL, drawingId: null, active: false }]);
  });
});

describe('touch tolerance', () => {
  it('widens stroke and handle hit radius for touch pointers', () => {
    const d = line(20, 40, 20, 60);
    // 8 px below the line's middle: outside the mouse tolerance, inside the touch one.
    const y = Y(40) + 8;
    expect(layer.hitTest(pane, X(30), y).strong).toBeNull();
    input.setPointerType('touch');
    expect(layer.hitTest(pane, X(30), y).strong?.id).toBe(d.id);
    // Handles reach further too.
    const far = HANDLE_RADIUS + 6;
    expect(layer.hitTest(pane, X(20) + far, Y(20)).strong?.part).toEqual({
      kind: 'handle',
      index: 0,
    });
    input.setPointerType('mouse');
    expect(layer.hitTest(pane, X(30), y).strong).toBeNull();
  });
});

describe('replace and bounds', () => {
  it('replace drops style keys missing from the new drawing and emits nothing', () => {
    const d = line();
    const held = layer.items.get(d.id)!;
    const { lineWidth: _w, ...style } = d.style;
    expect(layer.replace({ ...structuredClone(d), style, text: 'x' })).toBe(true);
    expect(layer.items.get(d.id)).toBe(held); // same internal object
    expect('lineWidth' in held.style).toBe(false);
    expect(held.text).toBe('x');
    expect(layer.replace({ ...d, id: 'unknown' })).toBe(false);
    expect(events).toEqual([]);
  });

  it('bounds cover anchors and handles in root px, null for unshown drawings', () => {
    const r = HANDLE_RADIUS;
    const d = line(20, 40, 20, 60);
    expect(layer.bounds([d.id])).toEqual({
      left: X(20) - r,
      right: X(40) + r,
      top: Y(60) - r,
      bottom: Y(20) + r,
    });
    // Past the last bar: extrapolated like rendering.
    const f = line(N + 5, N + 10, 30, 40);
    expect(layer.bounds([f.id])!.right).toBeCloseTo(X(N + 10) + r, 6);
    expect(layer.bounds(['nope'])).toBeNull();
    layer.update(d.id, { hidden: true });
    expect(layer.bounds([d.id])).toBeNull();
  });

  it('bounds follow brick mapping (several bricks per time)', () => {
    const tl = layer.host.timeline() as {
      -readonly [K in keyof AnchorTimeline]: AnchorTimeline[K];
    };
    tl.time = Float64Array.from({ length: N }, (_, i) => START + Math.floor(i / 2) * D);
    tl.bricks = true;
    tl.endTime = START + (N / 2 - 1) * D;
    const d = layer.insert(
      layer.build({
        type: 'horizontal-ray',
        points: [{ time: START + 10 * D, price: 50, brick: 1 }],
      }),
    );
    const b = layer.bounds([d.id])!;
    expect(b.left).toBeCloseTo(X(21) - HANDLE_RADIUS, 6);
    expect(b.top).toBeCloseTo(Y(50) - HANDLE_RADIUS, 6);
  });
});

describe('keyboard nudge', () => {
  it('arrows move the selection: one drawingChanged per key', () => {
    const a = line();
    const locked = hline(50, { locked: true });
    layer.setSelection([a.id, locked.id]);
    events = [];
    expect(input.key('ArrowRight')).toBe(true);
    expect(input.key('ArrowUp', SHIFT)).toBe(true);
    const ch = of('drawingChanged');
    expect(ch).toHaveLength(2);
    expect(ch[0]!.changes).toHaveLength(1);
    expect(ch[0]!.changes[0]!.after.points[0]!.time).toBe(START + 21 * D);
    expect(ch[1]!.changes[0]!.after.points[0]!.price).toBeCloseTo(22.5, 9); // 10 px = 2.5
    layer.setSelection([locked.id]);
    expect(input.key('ArrowLeft')).toBe(false); // falls through to chart panning
  });
});

describe('performance', () => {
  it('500 drawings at 100k bars: only visible drawings render or hit-test', () => {
    const n = 100_000;
    const tl: AnchorTimeline = {
      time: Float64Array.from({ length: n }, (_, i) => START + i * D),
      length: n,
      interval: { unit: 'day', count: 1 },
      bricks: false,
      endTime: START + (n - 1) * D,
    };
    const big = new DrawingLayer({ ...layer.host, timeline: () => tl, symbol: 'TEST' });
    ts.baseIndex = n - 1;
    for (let k = 0; k < 500; k++) {
      const i = n - 1 - k * 199;
      big.insert(
        big.build({
          type: 'trend-line',
          points: [
            { time: START + (i - 3) * D, price: 20 },
            { time: START + i * D, price: 60 },
          ],
        }),
      );
    }
    const render = vi.spyOn(trendLine, 'render');
    const hit = vi.spyOn(trendLine, 'hitTest');
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    try {
      const t0 = performance.now();
      for (let f = 0; f < 20; f++) {
        big.render(pane, ctx as CanvasRenderingContext2D, 1);
        big.hitTest(pane, 10, 10);
      }
      const perFrame = (performance.now() - t0) / 20;
      expect(render).toHaveBeenCalledTimes(20); // one visible drawing per frame
      expect(hit).toHaveBeenCalledTimes(20);
      expect(perFrame).toBeLessThan(16);
    } finally {
      render.mockRestore();
      hit.mockRestore();
    }
  });
});

// ------------------------------------------------- framework extensions (Phase 11)

/** Fixture tools (test-only types, not built-ins). */
const fixture = {
  defaults: { lineColor: '#ff0000' },
  properties: [],
  render: () => undefined,
  hitTest: (
    g: { points: readonly { x: number; y: number }[] },
    _s: unknown,
    x: number,
    y: number,
  ) => (polylineDistance(g.points, x, y) <= 4 ? ({ kind: 'body' } as const) : null),
};
registerDrawingTool(
  defineDrawingTool({
    ...fixture,
    type: 'test-multi',
    name: 'Multi',
    group: 'shapes',
    creation: { kind: 'multi', min: 3, max: 5 },
  }),
);
registerDrawingTool(
  defineDrawingTool({
    ...fixture,
    type: 'test-closable',
    name: 'Closable',
    group: 'shapes',
    creation: { kind: 'multi', min: 2, closable: true },
  }),
);
registerDrawingTool(
  defineDrawingTool({
    ...fixture,
    type: 'test-pane',
    name: 'Pane',
    group: 'annotation',
    creation: { kind: 'points', count: 2 },
    coords: 'pane',
  }),
);
registerDrawingTool(
  defineDrawingTool({
    ...fixture,
    type: 'test-main',
    name: 'Main only',
    group: 'forecasting',
    creation: { kind: 'click' },
    panes: 'main',
    // Asks for a redraw like an image tool waiting for its decode.
    render: (rc) => rc.invalidate(),
  }),
);

describe('multi-point creation', () => {
  const pts = () => of('drawingCreated')[0]!.drawing.points;
  const at = (i: number, p: number) => ({ time: START + i * D, price: p });
  const dbl = (x: number, y: number) => {
    click(x, y);
    click(x, y);
    return input.doubleClick(target(x, y), x, y);
  };

  it('each click adds an anchor; a double-click finishes (second click dropped)', () => {
    input.setActiveTool('test-multi');
    click(X(10), Y(10));
    expect(layer.draft?.points).toHaveLength(2); // anchor 2 floats
    click(X(20), Y(30));
    hover(X(25), Y(40));
    expect(layer.draft?.points).toEqual([at(10, 10), at(20, 30), at(25, 40)]);
    expect(dbl(X(30), Y(20))).toBe(true);
    expect(pts()).toEqual([at(10, 10), at(20, 30), at(30, 20)]);
    expect(of('toolFinished')[0]).toMatchObject({ type: 'test-multi', active: false });
    expect(layer.draft).toBeNull();
  });

  it('a double-click with fewer than min anchors keeps creating', () => {
    input.setActiveTool('test-multi');
    click(X(10), Y(10));
    dbl(X(20), Y(20));
    expect(of('drawingCreated')).toHaveLength(0);
    // Two fixed anchors and a floating one; the next clicks continue.
    expect(layer.draft?.points).toHaveLength(3);
    click(X(30), Y(30));
    input.key('Enter');
    expect(pts()).toEqual([at(10, 10), at(20, 20), at(30, 30)]);
  });

  it('Enter finishes with >= min anchors and is ignored below', () => {
    input.setActiveTool('test-multi');
    click(X(10), Y(10));
    click(X(20), Y(20));
    expect(input.key('Enter')).toBe(true);
    expect(layer.draft?.points).toHaveLength(3);
    click(X(30), Y(30));
    hover(X(40), Y(40));
    input.key('Enter');
    expect(pts()).toEqual([at(10, 10), at(20, 20), at(30, 30)]);
  });

  it('Esc and right-click finish with >= min anchors, else cancel', () => {
    input.setActiveTool('test-multi');
    click(X(10), Y(10));
    click(X(20), Y(20));
    input.key('Escape');
    expect(of('toolFinished')).toEqual([{ type: 'test-multi', drawingId: null, active: false }]);
    expect(layer.items.size).toBe(0);
    expect(input.activeTool).toBeNull();

    events = [];
    input.setActiveTool('test-multi');
    for (const i of [10, 20, 30]) click(X(i), Y(i));
    input.contextMenu(target(X(40), Y(40)), 0, 0);
    expect(pts()).toEqual([at(10, 10), at(20, 20), at(30, 30)]);
    expect(of('toolFinished')[0]!.drawingId).toBe(of('drawingCreated')[0]!.drawing.id);

    events = [];
    input.setActiveTool('test-multi');
    for (const i of [10, 20, 30, 40]) click(X(i), Y(i));
    input.key('Escape');
    expect(pts()).toHaveLength(4);
  });

  it('finishes when max anchors are placed', () => {
    input.setActiveTool('test-multi');
    for (const i of [10, 20, 30, 40]) click(X(i), Y(50));
    expect(layer.items.size).toBe(0);
    click(X(50), Y(50));
    expect(pts().map((p) => p.time)).toEqual([10, 20, 30, 40, 50].map((i) => START + i * D));
  });

  it('a double-click drops a trailing anchor within the drag slop, not only an exact one', () => {
    input.setActiveTool('test-multi');
    click(X(10), Y(10));
    click(X(20), Y(30));
    click(X(30), Y(20));
    click(X(30) + 2, Y(20) + 1); // second click of a jittery double-click
    input.doubleClick(target(X(30), Y(20)), X(30), Y(20));
    expect(pts()).toEqual([at(10, 10), at(20, 30), at(30, 20)]);
  });

  it('a click on the first anchor appends unless the tool is closable', () => {
    input.setActiveTool('test-multi');
    click(X(10), Y(10));
    click(X(20), Y(40));
    click(X(30), Y(10));
    click(X(10) + 3, Y(10) - 2);
    expect(of('drawingCreated')).toHaveLength(0);
    expect(layer.draft?.points).toHaveLength(5);
  });

  it('a click on the first anchor closes: the last anchor copies anchor 0', () => {
    input.setActiveTool('test-closable');
    click(X(10), Y(10));
    click(X(20), Y(40));
    click(X(30), Y(10));
    // Within handle reach, off the bar slot: still an exact copy.
    click(X(10) + 3, Y(10) - 2);
    expect(pts()).toEqual([at(10, 10), at(20, 40), at(30, 10), at(10, 10)]);
  });

  it('closing needs at least three placed anchors (no degenerate shape)', () => {
    input.setActiveTool('test-closable');
    click(X(10), Y(10));
    click(X(10), Y(10)); // fixes anchor 2 on anchor 1, does not close
    expect(of('drawingCreated')).toHaveLength(0);
    expect(layer.draft?.points).toHaveLength(3);
    click(X(10), Y(10)); // only two anchors were placed: still appends
    expect(of('drawingCreated')).toHaveLength(0);
    expect(layer.draft?.points).toHaveLength(4);
  });

  it('press-drag-release places anchor 2, then clicks continue', () => {
    input.setActiveTool('test-multi');
    down(X(10), Y(10));
    move(X(15), Y(20));
    up(X(20), Y(20));
    expect(layer.draft?.points).toEqual([at(10, 10), at(20, 20), at(20, 20)]);
    click(X(30), Y(30));
    input.key('Enter');
    expect(pts()).toEqual([at(10, 10), at(20, 20), at(30, 30)]);
  });
});

describe('pane coordinates', () => {
  // X(i) = 10 i - 195, Y(p) = 400 - 4 p on the 800 x 400 pane.
  const create = () => {
    input.setActiveTool('test-pane');
    click(X(50), Y(40)); // (305, 240)
    click(X(60) + 3, Y(60) + 1); // (408, 161): no bar snapping
    return of('drawingCreated')[0]!.drawing;
  };

  it('stores x/y fractions of the pane, unsnapped and without magnet', () => {
    env.magnet = 'strong';
    env.values = () => [50];
    const d = create();
    expect(d.points).toEqual([
      { time: 305 / 800, price: 240 / 400 },
      { time: 408 / 800, price: 161 / 400 },
    ]);
  });

  it('stays put on screen across pan and zoom, and is never culled', () => {
    const d = create();
    const g = () => {
      layer.refreshView();
      return layer.geometry(layer.items.get(d.id)!, pane)!.points.map((p) => ({ ...p }));
    };
    const before = g();
    expect(before[0]!.x).toBeCloseTo(305);
    expect(before[0]!.y).toBeCloseTo(240);
    ts.rightOffset = -300; // the anchors' bars are far off screen now
    ts.barSpacing = 3;
    expect(g()).toEqual(before);
    expect(layer.hitTest(pane, 305, 240).strong?.id).toBe(d.id);
  });

  it('body drags and nudges move by px, kept inside the pane', () => {
    const d = create();
    layer.setSelection([]);
    // Press on the body (midpoint), drag 17 px right, 9 px down.
    const mx = (305 + 408) / 2;
    const my = (240 + 161) / 2;
    down(mx, my);
    move(mx + 17, my + 9);
    up(mx + 17, my + 9);
    const p = layer.items.get(d.id)!.points;
    expect(p[0]!.time * 800).toBeCloseTo(322);
    expect(p[0]!.price * 400).toBeCloseTo(249);
    expect(p[1]!.time * 800).toBeCloseTo(425);
    events = [];
    input.key('ArrowLeft'); // 1 px, not 1 bar
    expect(layer.items.get(d.id)!.points[0]!.time * 800).toBeCloseTo(321);
    input.key('ArrowUp', { ...NO, shift: true }); // 10 px
    expect(layer.items.get(d.id)!.points[0]!.price * 400).toBeCloseTo(239);
    expect(of('drawingChanged')).toHaveLength(2);
    // Dragging far right stops when the right-most anchor reaches the edge.
    layer.refreshView();
    const q = layer.geometry(layer.items.get(d.id)!, pane)!.points;
    const [hx, hy] = [(q[0]!.x + q[1]!.x) / 2, (q[0]!.y + q[1]!.y) / 2];
    down(hx, hy);
    move(hx + 2000, hy);
    up(hx + 2000, hy);
    const r = layer.items.get(d.id)!.points;
    expect(r[1]!.time).toBeCloseTo(1);
    expect((r[1]!.time - r[0]!.time) * 800).toBeCloseTo(103);
  });

  it('handle drags follow the raw pointer; no default axis labels', () => {
    const d = create();
    down(305, 240); // handle 0
    move(311, 231);
    up(311, 231);
    expect(layer.items.get(d.id)!.points[0]).toEqual({ time: 311 / 800, price: 231 / 400 });
    const out: DrawingAxisLabel[] = [];
    layer.axisLabels('price', pane, out);
    layer.axisLabels('time', null, out);
    expect(out).toEqual([]);
  });
});

describe('tool options and pane restrictions', () => {
  it('a preset style reaches the created drawing and leaves with the tool', () => {
    input.setActiveTool('trend-line', { style: { lineColor: '#00ff00', glyph: 'x' } });
    click(X(10), Y(10));
    click(X(20), Y(20));
    expect(of('drawingCreated')[0]!.drawing.style).toMatchObject({
      lineColor: '#00ff00',
      glyph: 'x',
      lineWidth: 2,
    });
    input.setActiveTool('trend-line');
    click(X(10), Y(10));
    click(X(20), Y(20));
    expect(of('drawingCreated')[1]!.drawing.style.lineColor).toBe('#2962ff');
  });

  it('stay mode keeps the preset style for the next drawing', () => {
    layer.options.stayInDrawingMode = true;
    input.setActiveTool('horizontal-line', { style: { lineColor: '#123456' } });
    click(X(10), Y(10));
    click(X(20), Y(20));
    expect(of('drawingCreated').map((e) => e.drawing.style.lineColor)).toEqual([
      '#123456',
      '#123456',
    ]);
  });

  it("panes: 'main' tools are not created on study panes", () => {
    const ps = new PriceScale();
    ps.height = 100;
    const study: DrawingPane = { id: 'pane-rsi', priceScale: ps, height: 100, top: 400 };
    input.setActiveTool('test-main');
    expect(input.pointerDown({ pane: study, drawing: null }, 100, 450, NO)).toBe(true);
    input.pointerUp(100, 450, NO);
    expect(layer.draft).toBeNull();
    expect(of('drawingCreated')).toHaveLength(0);
    expect(input.activeTool).toBe('test-main');
    click(X(10), Y(10));
    expect(of('drawingCreated')[0]!.drawing.paneId).toBe('main');
  });

  it('rc.invalidate requests an overlay redraw', () => {
    const inv = vi.spyOn(layer.host, 'invalidate');
    layer.insert(layer.build({ type: 'test-main', points: [{ time: START + 50 * D, price: 1 }] }));
    inv.mockClear();
    const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
    layer.render(pane, ctx as CanvasRenderingContext2D, 1);
    expect(inv).toHaveBeenCalledTimes(1);
  });
});
