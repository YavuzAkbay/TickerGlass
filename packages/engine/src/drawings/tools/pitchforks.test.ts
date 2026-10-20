import { describe, expect, it } from 'vitest';
import type { DrawingPoint } from '../types';
import { defaultPitchforkLevels, pitchforkGeometry } from './pitchfork-common';
import {
  geometryOf,
  makeDrawing,
  makeView,
  pt,
  recordingContext,
  SELECTED,
  tool,
} from './test-utils';

const { X, Y } = makeView();
const TOL = 4;

function setup(type: string, points: DrawingPoint[], style = {}) {
  const d = makeDrawing(type, points, style);
  const g = geometryOf(d);
  const def = tool(type);
  return { d, g, def, at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL) };
}

describe('pitchfork geometry', () => {
  // p1 (0,0); p2 (100,-50); p3 (100,50): mid (100,0), half (0,50).
  const p1 = { x: 0, y: 0 };
  const p2 = { x: 100, y: -50 };
  const p3 = { x: 100, y: 50 };

  it('original: median from p1 through the midpoint of p2-p3', () => {
    const f = pitchforkGeometry('original', p1, p2, p3)!;
    expect(f.mid).toEqual({ x: 100, y: 0 });
    expect(f.half).toEqual({ x: 0, y: 50 });
    expect(f.dir).toEqual({ x: 100, y: 0 });
    expect([f.handle0, f.handle1]).toEqual([p1, { x: 100, y: 0 }]);
  });

  it('schiff: origin halfway in price towards p2', () => {
    const f = pitchforkGeometry('schiff', p1, p2, p3)!;
    expect(f.handle0).toEqual({ x: 0, y: -25 });
    expect(f.dir).toEqual({ x: 100, y: 25 });
  });

  it('modified schiff: origin at the midpoint of p1-p2', () => {
    const f = pitchforkGeometry('modified-schiff', p1, p2, p3)!;
    expect(f.handle0).toEqual({ x: 50, y: -25 });
    expect(f.dir).toEqual({ x: 50, y: 25 });
  });

  it('inside: handle from the p1-p2 midpoint to p3, tines parallel to it', () => {
    const f = pitchforkGeometry('inside', p1, p2, p3)!;
    expect(f.handle0).toEqual({ x: 50, y: -25 });
    expect(f.handle1).toEqual(p3);
    expect(f.dir).toEqual({ x: 50, y: 75 });
    expect(f.mid).toEqual({ x: 100, y: 0 });
  });

  it('degenerate median is null', () => {
    expect(pitchforkGeometry('original', p1, { x: -10, y: 5 }, { x: 10, y: -5 })).toBeNull();
  });

  it('default levels: 0.5 and 1 visible', () => {
    const lv = defaultPitchforkLevels();
    expect(lv.map((l) => l.value)).toEqual([0.25, 0.382, 0.5, 0.618, 0.75, 1, 1.5, 1.75, 2]);
    expect(lv.filter((l) => l.visible).map((l) => l.value)).toEqual([0.5, 1]);
    expect(defaultPitchforkLevels()).not.toBe(lv);
  });
});

describe('pitchfork tools', () => {
  // P1 (20, 50), P2 (40, 80), P3 (40, 20): mid (40, 50); half 30 price; original dir 20 bars.
  const pts = [pt(20, 50), pt(40, 80), pt(40, 20)];

  it('original: median, level tines and weak band', () => {
    const { at } = setup('pitchfork', pts);
    expect(at(X(30), Y(50))).toEqual({ kind: 'body' }); // handle
    expect(at(X(50), Y(50))).toEqual({ kind: 'body' }); // median tine
    expect(at(X(50), Y(65))).toEqual({ kind: 'body' }); // 0.5
    expect(at(X(50), Y(35))).toEqual({ kind: 'body' });
    expect(at(X(50), Y(80))).toEqual({ kind: 'body' }); // 1
    expect(at(X(40), Y(72))).toEqual({ kind: 'body' }); // base p2-p3
    expect(at(X(50), Y(72))).toEqual({ kind: 'body', weak: true });
    expect(at(X(70), Y(50))).toBeNull(); // past the tine length
    expect(at(X(30), Y(80))).toBeNull();
    expect(setup('pitchfork', pts, { extendLines: true }).at(X(70), Y(50))).toEqual({
      kind: 'body',
    });
    expect(setup('pitchfork', pts, { fillBackground: false }).at(X(50), Y(72))).toBeNull();
  });

  it('schiff: median from (bar 20, 65) through the mid point', () => {
    // Slope: -15 price over 20 bars; at bar 30: 57.5, at bar 50: 42.5.
    const { at } = setup('schiff-pitchfork', pts);
    expect(at(X(30), Y(57.5))).toEqual({ kind: 'body' });
    expect(at(X(50), Y(42.5))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(50))).not.toEqual({ kind: 'body' });
  });

  it('modified schiff: median from (bar 30, 65) through the mid point', () => {
    // Slope -15 per 10 bars: at bar 35: 57.5, at bar 45: 42.5.
    const { at } = setup('modified-schiff-pitchfork', pts);
    expect(at(X(35), Y(57.5))).toEqual({ kind: 'body' });
    expect(at(X(45), Y(42.5))).toEqual({ kind: 'body' });
    expect(at(X(25), Y(72.5))).toBeNull(); // no line before the origin
  });

  it('inside: handle to P3, median from the mid point parallel to it', () => {
    // Origin (30, 65) -> P3 (40, 20): -45 per 10 bars. Median: (40, 50) -> (50, 5).
    const { at } = setup('inside-pitchfork', pts);
    expect(at(X(35), Y(42.5))).toEqual({ kind: 'body' }); // handle
    expect(at(X(45), Y(27.5))).toEqual({ kind: 'body' }); // median
    expect(at(X(45), Y(57.5))).toEqual({ kind: 'body' }); // level 1 from P2
  });

  it('renders the first leg for two-anchor drafts and full forks with fills', () => {
    const def = tool('pitchfork');
    const two = setup('pitchfork', pts.slice(0, 2));
    const r2 = recordingContext();
    def.render(r2.rc, two.g, two.d.style, SELECTED);
    expect(r2.calls.filter((c) => c === 'stroke')).toHaveLength(1);
    expect(two.at(X(30), Y(65))).toEqual({ kind: 'body' });
    const full = setup('pitchfork', pts);
    const r3 = recordingContext();
    def.render(r3.rc, full.g, full.d.style, SELECTED);
    // 2 levels x 2 sides fills; base + 4 tines + handle + median strokes.
    expect(r3.calls.filter((c) => c === 'fill')).toHaveLength(4);
    expect(r3.calls.filter((c) => c === 'stroke')).toHaveLength(7);
  });

  it('culling: visible in view, also when extended in from the left', () => {
    const def = tool('pitchfork');
    const on = setup('pitchfork', pts);
    expect(def.isVisible!(on.g, on.d.style)).toBe(true);
    const left = [pt(-200, 50), pt(-180, 80), pt(-180, 20)];
    const off = setup('pitchfork', left);
    expect(def.isVisible!(off.g, off.d.style)).toBe(false);
    const ext = setup('pitchfork', left, { extendLines: true });
    expect(def.isVisible!(ext.g, ext.d.style)).toBe(true);
  });
});

describe('pitchfan', () => {
  // P1 (20, 50), P2 (40, 80), P3 (40, 20): rays from P1.
  const pts = [pt(20, 50), pt(40, 80), pt(40, 20)];

  it('hits the median ray, level rays, p2-p3 and the weak wedge', () => {
    const { at, def } = setup('pitchfan', pts);
    expect(def.group).toBe('fib');
    expect(at(X(70), Y(50))).toEqual({ kind: 'body' }); // median ray
    expect(at(X(30), Y(65))).toEqual({ kind: 'body' }); // level 1 through P2: +30 per 20 bars
    expect(at(X(60), Y(80))).toEqual({ kind: 'body' }); // level 0.5: +15 per 20 bars
    expect(at(X(40), Y(30))).toEqual({ kind: 'body' }); // p2-p3
    expect(at(X(60), Y(60))).toEqual({ kind: 'body', weak: true });
    expect(at(X(10), Y(50))).toBeNull(); // behind P1
  });

  it('renders rays and fills', () => {
    const { def, g, d } = setup('pitchfan', pts);
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, SELECTED);
    expect(calls.filter((c) => c === 'fill')).toHaveLength(4);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(6); // p2-p3 + 4 rays + median
  });

  it('culling: rays pointing away from the pane are not visible', () => {
    const def = tool('pitchfan');
    const away = setup('pitchfan', [pt(-200, 50), pt(-220, 80), pt(-220, 20)]);
    expect(def.isVisible!(away.g, away.d.style)).toBe(false);
    const into = setup('pitchfan', [pt(-200, 50), pt(-180, 52), pt(-180, 48)]);
    expect(def.isVisible!(into.g, into.d.style)).toBe(true);
  });
});
