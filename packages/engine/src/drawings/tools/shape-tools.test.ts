import { describe, expect, it } from 'vitest';
import type { DrawingPoint, HandleMoveArgs } from '../types';
import { arcThrough } from './arc';
import { arrowMarkPolygon, MARK_HEIGHT } from './up-marker';
import { arrowPointerPolygon } from './arrow-pointer';
import { quadControl } from './curve';
import { cubicControls, defaultSCurvePoints } from './s-curve';
import { isClosedPolyline, polyline } from './polyline';
import { rotatedRectCorners, rotatedRectFrame } from './rotated-rectangle';
import {
  geometryOf,
  IDLE,
  makeDrawing,
  makeView,
  pt,
  recordingContext,
  SELECTED,
  tool,
} from './test-utils';

const { X, Y } = makeView();
const TOL = 4;
const BODY = { kind: 'body' };
const TEXT = { kind: 'text' };

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
    complete: () => def.completePoints!(d.points, g, d.style),
  };
}

const round = (ps: readonly { x: number; y: number }[]) =>
  ps.map((p) => [Math.round(p.x * 1e6) / 1e6 + 0, Math.round(p.y * 1e6) / 1e6 + 0]);

const offscreen = (type: string, points = [pt(-500, 20), pt(-480, 30), pt(-490, 25)]) => {
  const d = makeDrawing(type, points);
  return tool(type).isVisible!(geometryOf(d), d.style);
};

describe('highlighter', () => {
  const pts = [pt(20, 20), pt(22, 22), pt(24, 25), pt(26, 30), pt(28, 30)];

  it('freehand, wide stroke hit within half the width', () => {
    const { def, at, g, d } = setup('highlighter', pts);
    expect(def.creation).toEqual({ kind: 'freehand' });
    expect(d.style.lineWidth).toBe(20);
    // End sample (28, 30) is kept by the smoothing: 10 + 4 px reach.
    expect(at(X(28) + 13, Y(30))).toEqual(BODY);
    expect(at(X(28) + 16, Y(30))).toBeNull();
    expect(def.handles!(g, d.style)).toHaveLength(2);
    expect(def.priceAxisLabels!(d, d.style, SELECTED)).toEqual([]);
    expect(offscreen('highlighter')).toBe(false);
  });

  it('renders one round-capped stroke (no fill)', () => {
    const { def, g, d } = setup('highlighter', pts);
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1);
    expect(calls).not.toContain('fill');
  });

  it('end handles stretch like the brush', () => {
    const { move } = setup('highlighter', pts);
    const out = move(1, pt(30, 10));
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pt(30, 10));
  });
});

describe('arrow pointer', () => {
  it('thick arrow outline vs hand-computed corners', () => {
    expect(round(arrowPointerPolygon({ x: 0, y: 0 }, { x: 100, y: 0 })!)).toEqual([
      [0, -4],
      [80, -4],
      [80, -10],
      [100, 0],
      [80, 10],
      [80, 4],
      [0, 4],
    ]);
    // Shorter than the head: the head starts at the tail.
    expect(round(arrowPointerPolygon({ x: 0, y: 0 }, { x: 0, y: 10 })!)[2]).toEqual([10, 0]);
    expect(arrowPointerPolygon({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
  });

  it('hits the filled arrow (strong) and the text past the tail', () => {
    const { at } = setup('arrow-pointer', [pt(20, 50), pt(40, 50)], {}, 'buy');
    expect(at(X(30), Y(50) + 3)).toEqual(BODY); // shaft interior
    expect(at(X(40) - 10, Y(50) + 9)).toEqual(BODY); // head interior
    expect(at(X(30), Y(50) + 15)).toBeNull();
    expect(at(X(20) - 15, Y(50))).toEqual(TEXT); // text left of the tail
    const plain = setup('arrow-pointer', [pt(20, 50), pt(40, 50)]);
    expect(plain.at(X(20) - 15, Y(50))).toBeNull();
  });
});

describe('up and down markers', () => {
  it('up glyph hangs below its tip, down glyph above', () => {
    const up = arrowMarkPolygon(100, 100, -1);
    expect(round(up)).toEqual([
      [100, 100],
      [109, 109],
      [103.5, 109],
      [103.5, 120],
      [96.5, 120],
      [96.5, 109],
      [91, 109],
    ]);
    expect(round(arrowMarkPolygon(100, 100, 1))[3]).toEqual([103.5, 80]);
    expect(MARK_HEIGHT).toBe(20);
  });

  it('single click; glyph strong hit, text beyond the tail', () => {
    const up = setup('up-marker', [pt(30, 50)], {}, 'long');
    expect(up.def.creation).toEqual({ kind: 'click' });
    expect(up.at(X(30), Y(50) + 15)).toEqual(BODY);
    expect(up.at(X(30), Y(50) - 10)).toBeNull();
    expect(up.at(X(30), Y(50) + 32)).toEqual(TEXT); // centre 20 + 4 + 8.4 below
    const down = setup('down-marker', [pt(30, 50)], {}, 'short');
    expect(down.at(X(30), Y(50) - 15)).toEqual(BODY);
    expect(down.at(X(30), Y(50) + 10)).toBeNull();
    expect(down.at(X(30), Y(50) - 32)).toEqual(TEXT);
    expect(up.d.style.arrowColor).toBe('#7FB069');
    expect(down.d.style.arrowColor).toBe('#DE6A4F');
  });
});

describe('rotated rectangle', () => {
  // Axis (20,50)-(40,50): 200 px horizontal; anchor 2 at 40 px above -> half width 40.
  const pts = [pt(20, 50), pt(40, 50), pt(30, 60)];

  it('corners from the axis and the half width (hand-computed, rotated)', () => {
    const f = rotatedRectFrame({ x: 0, y: 0 }, { x: 30, y: 40 }, { x: -8, y: 6 })!;
    expect(f.nx).toBeCloseTo(-0.8, 12);
    expect(f.ny).toBeCloseTo(0.6, 12);
    expect(f.half).toBeCloseTo(10, 12);
    const { g } = setup('rotated-rectangle', pts);
    expect(round(rotatedRectCorners(g))).toEqual(
      round([
        { x: X(20), y: Y(50) + 40 },
        { x: X(40), y: Y(50) + 40 },
        { x: X(40), y: Y(50) - 40 },
        { x: X(20), y: Y(50) - 40 },
      ]),
    );
  });

  it('hits border and filled interior (strong)', () => {
    const { at } = setup('rotated-rectangle', pts);
    expect(at(X(30), Y(50) + 40)).toEqual(BODY);
    expect(at(X(25), Y(52))).toEqual(BODY);
    expect(at(X(30), Y(50) + 60)).toBeNull();
    const hollow = setup('rotated-rectangle', pts, { fillBackground: false });
    expect(hollow.at(X(25), Y(52))).toBeNull();
  });

  it('handles: axis ends keep the width, side midpoints set it', () => {
    const { def, g, d, move } = setup('rotated-rectangle', pts);
    expect(round(def.handles!(g, d.style))).toEqual(
      round([
        { x: X(20), y: Y(50) },
        { x: X(40), y: Y(50) },
        { x: X(30), y: Y(50) + 40 },
        { x: X(30), y: Y(50) - 40 },
      ]),
    );
    expect(move(2, pt(30, 70))).toEqual([pts[0], pts[1], pt(30, 70)]);
    const m = move(0, pt(10, 50));
    expect(m.slice(0, 2)).toEqual([pt(10, 50), pts[1]]);
    expect(m[2]!.time).toBe(pt(25, 0).time);
    expect(m[2]!.price).toBeCloseTo(60, 9);
  });

  it('2-anchor draft strokes the axis; culls off-screen', () => {
    const { def, g, d } = setup('rotated-rectangle', pts.slice(0, 2));
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls).toContain('stroke');
    expect(offscreen('rotated-rectangle')).toBe(false);
  });
});

describe('path', () => {
  const pts = [pt(20, 20), pt(30, 50), pt(40, 30)];

  it('multi-point open polyline with an end arrow', () => {
    const { def, at, g, d } = setup('path', pts);
    expect(def.creation).toEqual({ kind: 'multi', min: 2 });
    expect(at(X(25), Y(35))).toEqual(BODY);
    expect(at(X(30), Y(30))).toBeNull(); // inside the open shape: no fill
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(2); // line + head
    expect(offscreen('path')).toBe(false);
  });
});

describe('circle', () => {
  // Centre (30,50), edge 10 bars right -> r = 100 px.
  const pts = [pt(30, 50), pt(40, 50)];

  it('radius in px; outline and filled interior strong', () => {
    const { at } = setup('circle', pts);
    expect(at(X(30), Y(50) - 100)).toEqual(BODY);
    expect(at(X(30) + 70.7, Y(50) + 70.7)).toEqual(BODY);
    expect(at(X(30) + 50, Y(50))).toEqual(BODY);
    expect(at(X(30) + 110, Y(50))).toBeNull();
    const hollow = setup('circle', pts, { fillBackground: false });
    expect(hollow.at(X(30) + 50, Y(50))).toBeNull();
    const t = setup('circle', pts, {}, 'zone');
    expect(t.at(X(30), Y(50))).toEqual(TEXT);
  });

  it('culls by the circle box', () => {
    expect(offscreen('circle', [pt(-500, 50), pt(-490, 50)])).toBe(false);
    // Centre off the left edge, circle reaching into the pane.
    expect(offscreen('circle', [pt(-10, 50), pt(30, 50)])).toBe(true);
  });
});

describe('ellipse', () => {
  // Box (20,60)-(40,20): centre (X30, Y40), rx 100, ry 80.
  const pts = [pt(20, 60), pt(40, 20)];

  it('outline, strong interior, corners of the box miss', () => {
    const { at } = setup('ellipse', pts);
    expect(at(X(30), Y(60))).toEqual(BODY);
    expect(at(X(40), Y(40))).toEqual(BODY);
    expect(at(X(30) + 60, Y(40) + 64)).toEqual(BODY); // (0.6, 0.8) on the outline
    expect(at(X(30) + 50, Y(40))).toEqual(BODY);
    expect(at(X(20) + 10, Y(60) + 10)).toBeNull();
    const hollow = setup('ellipse', pts, { fillBackground: false });
    expect(hollow.at(X(30) + 50, Y(40))).toBeNull();
  });

  it('four edge handles on the ellipse mapped back to the corners', () => {
    const { def, g, d, move } = setup('ellipse', pts);
    expect(round(def.handles!(g, d.style))).toEqual(
      round([
        { x: X(20), y: Y(40) },
        { x: X(40), y: Y(40) },
        { x: X(30), y: Y(60) },
        { x: X(30), y: Y(20) },
      ]),
    );
    expect(move(0, pt(10, 99))).toEqual([pt(10, 60), pts[1]]);
    expect(move(1, pt(45, 99))).toEqual([pts[0], pt(45, 20)]);
    expect(move(2, pt(1, 80))).toEqual([pt(20, 80), pts[1]]);
    expect(move(3, pt(1, 10))).toEqual([pts[0], pt(40, 10)]);
  });
});

describe('polyline', () => {
  const open = [pt(20, 20), pt(30, 60), pt(40, 20)];
  const closed = [...open, { ...open[0]! }];

  it('is the only multi tool that closes on a first-anchor click', () => {
    expect(polyline.creation).toEqual({
      kind: 'multi',
      min: 2,
      closable: true,
    });
  });

  it('closed when the last anchor is an exact copy of the first', () => {
    expect(isClosedPolyline(closed)).toBe(true);
    expect(isClosedPolyline(open)).toBe(false);
    expect(isClosedPolyline([pt(20, 20), pt(20, 20)])).toBe(false); // 2 anchors: a point
    expect(isClosedPolyline([...open, pt(20, 20.0001)])).toBe(false);
    expect(isClosedPolyline([...open, { ...open[0]!, brick: 1 }])).toBe(false);
  });

  it('closed: filled polygon, strong interior; open: no fill', () => {
    const c = setup('polyline', closed);
    expect(c.at(X(30), Y(30))).toEqual(BODY);
    expect(c.at(X(30), Y(20))).toEqual(BODY); // closing edge
    const { rc, calls } = recordingContext();
    c.def.render(rc, c.g, c.d.style, IDLE);
    expect(calls).toContain('fill');
    expect(calls).toContain('closePath');
    const o = setup('polyline', open);
    expect(o.at(X(30), Y(30))).toBeNull();
    expect(o.at(X(30), Y(20))).toBeNull();
    expect(o.at(X(25), Y(40))).toEqual(BODY);
    const r2 = recordingContext();
    o.def.render(r2.rc, o.g, o.d.style, IDLE);
    expect(r2.calls).not.toContain('fill');
  });

  it('closed handles skip the copy; moving vertex 0 keeps it closed', () => {
    const c = setup('polyline', closed);
    expect(c.def.handles!(c.g, c.d.style)).toHaveLength(3);
    const m = c.move(0, pt(15, 25));
    expect(m[0]).toEqual(pt(15, 25));
    expect(m[3]).toEqual(pt(15, 25));
    expect(isClosedPolyline(m)).toBe(true);
    const o = setup('polyline', open);
    expect(o.def.handles!(o.g, o.d.style)).toHaveLength(3);
    expect(o.move(0, pt(15, 25))[2]).toEqual(open[2]);
    expect(offscreen('polyline')).toBe(false);
  });
});

describe('triangle', () => {
  it('three anchors; strong filled interior', () => {
    const { def, at } = setup('triangle', [pt(20, 20), pt(30, 60), pt(40, 20)]);
    expect(def.creation).toEqual({ kind: 'points', count: 3 });
    expect(at(X(30), Y(30))).toEqual(BODY);
    expect(at(X(30), Y(10))).toBeNull();
    expect(offscreen('triangle')).toBe(false);
  });
});

describe('arc', () => {
  it('circle through 3 points and the sweep through the middle anchor', () => {
    const top = arcThrough({ x: 100, y: 200 }, { x: 300, y: 200 }, { x: 200, y: 100 })!;
    expect(top.x).toBeCloseTo(200, 9);
    expect(top.y).toBeCloseTo(200, 9);
    expect(top.r).toBeCloseTo(100, 9);
    expect(top.start).toBeCloseTo(Math.PI, 9);
    expect(top.end).toBeCloseTo(0, 9);
    expect(top.anticlockwise).toBe(false); // clockwise on screen: left -> top -> right
    const bottom = arcThrough({ x: 100, y: 200 }, { x: 300, y: 200 }, { x: 200, y: 300 })!;
    expect(bottom.anticlockwise).toBe(true);
    // Larger than a half circle: through (130, 270).
    const major = arcThrough({ x: 100, y: 200 }, { x: 200, y: 100 }, { x: 270.71, y: 270.71 })!;
    expect(major.r).toBeCloseTo(100, 2);
    expect(major.anticlockwise).toBe(true);
    expect(arcThrough({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 })).toBeNull();
  });

  // Ends (20,50) and (40,50), through (30,75): centre (X30, Y50), r = 100 px.
  const pts = [pt(20, 50), pt(40, 50), pt(30, 75)];

  it('hits the arc, the filled segment, not the other half of the circle', () => {
    const { at } = setup('arc', pts);
    expect(at(X(30), Y(75))).toEqual(BODY);
    expect(at(X(30) + 70.7, Y(50) - 70.7)).toEqual(BODY);
    expect(at(X(30), Y(60))).toEqual(BODY); // segment interior
    expect(at(X(30), Y(40))).toBeNull(); // inside the circle, below the chord
    expect(at(X(30), Y(25))).toBeNull(); // where the full circle would be
    const hollow = setup('arc', pts, { fillBackground: false });
    expect(hollow.at(X(30), Y(60))).toBeNull();
  });

  it('collinear draft draws the chord', () => {
    const { def, g, d, at } = setup('arc', [pt(20, 50), pt(40, 50), pt(40, 50)]);
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls).not.toContain('arc');
    expect(at(X(30), Y(50))).toEqual(BODY);
    expect(offscreen('arc')).toBe(false);
  });
});

describe('curve', () => {
  const ends = [pt(20, 50), pt(40, 50)];

  it('completes with the on-curve midpoint bowed up a quarter of the chord', () => {
    const { complete } = setup('curve', ends);
    const out = complete();
    expect(out).toHaveLength(3);
    expect(out[2]!.time).toBe(pt(30, 0).time);
    expect(out[2]!.price).toBeCloseTo(62.5, 9); // 200 px chord -> 50 px = 12.5
  });

  it('control from the midpoint; hits along the curve, not the chord', () => {
    expect(quadControl({ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: -50 })).toEqual({
      x: 100,
      y: -100,
    });
    const { at, def, g, d } = setup('curve', [...ends, pt(30, 62.5)]);
    expect(at(X(30), Y(62.5))).toEqual(BODY);
    // t = 0.25: (0.75²·0 + 2·0.75·0.25·100 + 0.0625·200, 2·0.75·0.25·-100) = (50, -37.5).
    expect(at(X(20) + 50, Y(50) - 37.5)).toEqual(BODY);
    expect(at(X(30), Y(50))).toBeNull();
    expect(def.handles?.(g, d.style) ?? g.points).toHaveLength(3);
    // The 2-anchor draft previews the same default bow.
    const draft = setup('curve', ends);
    expect(draft.at(X(30), Y(62.5))).toEqual(BODY);
    expect(offscreen('curve')).toBe(false);
  });
});

describe('s-curve', () => {
  const ends = [pt(20, 50), pt(40, 50)];

  it('cubic controls pass through the 1/3 and 2/3 points', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 300, y: 0 };
    const [q1, q2] = defaultSCurvePoints(a, b);
    expect(q1).toEqual({ x: 100, y: -45 }); // 0.15 x 300 above
    expect(q2).toEqual({ x: 200, y: 45 });
    const [c1, c2] = cubicControls(a, b, q1, q2);
    const at = (t: number) => {
      const u = 1 - t;
      return {
        x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y,
      };
    };
    expect(at(1 / 3).x).toBeCloseTo(100, 9);
    expect(at(1 / 3).y).toBeCloseTo(-45, 9);
    expect(at(2 / 3).x).toBeCloseTo(200, 9);
    expect(at(2 / 3).y).toBeCloseTo(45, 9);
  });

  it('completes with an S of two on-curve anchors and hits along it', () => {
    const { complete } = setup('s-curve', ends);
    const out = complete();
    expect(out).toHaveLength(4);
    // 200 px chord: 30 px = 7.5 price above / below at bars 26.67 -> 27 and 33.33 -> 33.
    expect(out[2]!.price).toBeCloseTo(57.5, 9);
    expect(out[3]!.price).toBeCloseTo(42.5, 9);
    const { at } = setup('s-curve', out);
    expect(at(X(27), Y(57.5))).toEqual(BODY);
    expect(at(X(33), Y(42.5))).toEqual(BODY);
    expect(at(X(30), Y(65))).toBeNull();
    expect(offscreen('s-curve')).toBe(false);
  });
});
