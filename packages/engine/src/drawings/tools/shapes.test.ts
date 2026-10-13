import { describe, expect, it } from 'vitest';
import type { DrawingPoint, HandleMoveArgs } from '../types';
import { channelOffset } from './parallel-channel';
import { TEXT_PLACEHOLDER } from './text';
import {
  D,
  geometryOf,
  IDLE,
  makeDrawing,
  makeView,
  pt,
  recordingContext,
  SELECTED,
  START,
  tool,
} from './test-utils';

const { X, Y } = makeView();
const TOL = 4;

function setup(type: string, points: DrawingPoint[], style = {}, text = '') {
  const d = makeDrawing(type, points, style, text);
  const g = geometryOf(d);
  const def = tool(type);
  return {
    d,
    g,
    def,
    at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL),
    move: (handle: number, target: DrawingPoint) =>
      def.moveHandle!({
        start: d.points,
        handle,
        target,
        x: g.toPixel(target).x,
        y: g.toPixel(target).y,
        geometry: g,
        style: d.style,
      } as HandleMoveArgs),
  };
}

describe('parallel channel', () => {
  // Main line (20,20)-(40,40); anchor 2 at bar 30 price 50 -> offset 20.
  const pts = [pt(20, 20), pt(40, 40), pt(30, 50)];

  it('offset is anchor 2 relative to the main line', () => {
    const { g } = setup('parallel-channel', pts);
    expect(channelOffset(g.drawing.points, g.logical)).toBeCloseTo(20, 9);
    expect(channelOffset(pts.slice(0, 2), [20, 40])).toBe(0);
  });

  it('hits both lines, the middle line and the weak background', () => {
    const { at } = setup('parallel-channel', pts);
    expect(at(X(30), Y(30))).toEqual({ kind: 'body' }); // main
    expect(at(X(30), Y(50))).toEqual({ kind: 'body' }); // parallel
    expect(at(X(30), Y(40))).toEqual({ kind: 'body' }); // middle
    expect(at(X(30), Y(35))).toEqual({ kind: 'body', weak: true });
    expect(at(X(50), Y(50))).toBeNull();
    const noFill = setup('parallel-channel', pts, { fillBackground: false });
    expect(noFill.at(X(30), Y(35))).toBeNull();
  });

  it('derived handles: corners and width handles', () => {
    const { def, g, d } = setup('parallel-channel', pts);
    const hs = def.handles!(g, d.style);
    expect(hs.map((h) => [Math.round(h.x), Math.round(h.y)])).toEqual(
      [
        [X(20), Y(20)],
        [X(40), Y(40)],
        [X(20), Y(40)],
        [X(40), Y(60)],
        [X(30), Y(30)],
        [X(30), Y(50)],
      ].map(([x, y]) => [Math.round(x!), Math.round(y!)]),
    );
  });

  it('maps handles back to anchors', () => {
    const { move, g } = setup('parallel-channel', pts);
    const off = (p: DrawingPoint[]) =>
      channelOffset(
        p,
        p.map((q) => g.xToLogical(g.toPixel(q).x)),
      );
    // Width handle on the parallel middle: new width 30.
    const w = move(5, pt(30, 60));
    expect(w.slice(0, 2)).toEqual(pts.slice(0, 2));
    expect(off(w)).toBeCloseTo(30, 9);
    // Main anchor keeps the width.
    const a = move(0, pt(10, 10));
    expect(a[0]).toEqual(pt(10, 10));
    expect(off(a)).toBeCloseTo(20, 9);
    // Main-line middle moves the main line, parallel line stays put.
    const m = move(4, pt(30, 35));
    expect(m[0]!.price).toBeCloseTo(25, 9);
    expect(m[1]!.price).toBeCloseTo(45, 9);
    expect(off(m)).toBeCloseTo(15, 9);
    // Parallel corner sets the width at that end.
    const c = move(3, pt(40, 70));
    expect(off(c)).toBeCloseTo(30, 9);
  });

  it('renders a 2-anchor draft as a single line', () => {
    const { def, g, d } = setup('parallel-channel', pts.slice(0, 2));
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1);
    expect(calls).not.toContain('fill');
    expect(def.handles!(g, d.style)).toHaveLength(2);
  });

  it('time labels only for the main anchors', () => {
    const { def, d } = setup('parallel-channel', pts);
    expect(def.timeAxisLabels!(d, d.style, SELECTED).map((l) => l.value)).toEqual([
      START + 20 * D,
      START + 40 * D,
    ]);
    expect(def.timeAxisLabels!(d, d.style, IDLE)).toEqual([]);
  });
});

describe('rectangle', () => {
  const pts = [pt(20, 60), pt(40, 20)];

  it('hits border, filled interior (strong) and text', () => {
    const { at } = setup('rectangle', pts, {}, 'zone');
    expect(at(X(20), Y(40))).toEqual({ kind: 'body' });
    expect(at(X(25), Y(30))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(40))).toEqual({ kind: 'text' }); // centred text
    expect(at(X(50), Y(40))).toBeNull();
    const hollow = setup('rectangle', pts, { fillBackground: false });
    expect(hollow.at(X(25), Y(30))).toBeNull();
    const ext = setup('rectangle', pts, { extendRight: true });
    expect(ext.at(X(80), Y(30))).toEqual({ kind: 'body' });
  });

  it('has 8 handles mapped back to the two anchors', () => {
    const { def, g, d, move } = setup('rectangle', pts);
    expect(def.handles!(g, d.style)).toHaveLength(8);
    expect(move(0, pt(10, 70))).toEqual([pt(10, 70), pts[1]]);
    expect(move(2, pt(10, 10))).toEqual([pt(10, 60), pt(40, 10)]);
    expect(move(3, pt(50, 70))).toEqual([pt(20, 70), pt(50, 20)]);
    expect(move(4, pt(15, 99))).toEqual([pt(15, 60), pts[1]]); // left edge: time only
    expect(move(5, pt(45, 99))).toEqual([pts[0], pt(45, 20)]);
    expect(move(6, pt(1, 80))).toEqual([pt(20, 80), pts[1]]); // y0 edge: price only
    expect(move(7, pt(1, 10))).toEqual([pts[0], pt(40, 10)]);
  });

  it('opts out of the Shift angle constraint', () => {
    expect(tool('rectangle').shiftConstraint).toBe('none');
  });
});

describe('text', () => {
  it('single click, multiline text prop, placeholder while empty', () => {
    const def = tool('text');
    expect(def.creation).toEqual({ kind: 'click' });
    expect(def.text).toEqual({ default: '', multiline: true });
    const { g, d, at } = setup('text', [pt(30, 50)]);
    const { rc, texts } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(texts).toEqual([TEXT_PLACEHOLDER]);
    expect(at(X(30) + 5, Y(50) + 5)).toEqual({ kind: 'text' });
    expect(at(X(30) - 20, Y(50))).toBeNull();
  });

  it('renders and hit-tests every line', () => {
    const { def, g, d, at } = setup('text', [pt(30, 50)], {}, 'one\ntwo\nthree');
    const { rc, texts } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(texts).toEqual(['one', 'two', 'three']);
    expect(at(X(30) + 5, Y(50) + 45)).toEqual({ kind: 'text' }); // third line
  });
});

describe('brush', () => {
  const pts = [pt(20, 20), pt(21, 22), pt(22, 25), pt(23, 30), pt(24, 30), pt(26, 28)];

  it('freehand creation; hits near the stroke, not far away', () => {
    const { def, at } = setup('brush', pts, { smoothing: 0 });
    expect(def.creation).toEqual({ kind: 'freehand' });
    expect(at(X(23), Y(30))).toEqual({ kind: 'body' });
    expect(at(X(23), Y(50))).toBeNull();
  });

  it('fill is a weak hit inside the closed path', () => {
    const tri = [pt(20, 20), pt(30, 40), pt(40, 20)];
    const { at } = setup('brush', tri, { smoothing: 0, fillBackground: true });
    expect(at(X(30), Y(25))).toEqual({ kind: 'body', weak: true });
  });

  it('handles at the ends move one sample; no axis labels', () => {
    const { def, g, d, move } = setup('brush', pts);
    expect(def.handles!(g, d.style)).toHaveLength(2);
    const out = move(1, pt(30, 10));
    expect(out[out.length - 1]).toEqual(pt(30, 10));
    expect(out.slice(0, -1)).toEqual(pts.slice(0, -1));
    expect(def.priceAxisLabels!(d, d.style, SELECTED)).toEqual([]);
    expect(def.timeAxisLabels!(d, d.style, SELECTED)).toEqual([]);
  });

  it('culls by bounding box', () => {
    const def = tool('brush');
    const off = makeDrawing('brush', [pt(-100, 20), pt(-90, 30)]);
    expect(def.isVisible!(geometryOf(off), off.style)).toBe(false);
  });
});
