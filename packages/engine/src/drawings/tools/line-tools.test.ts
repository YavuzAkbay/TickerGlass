import { describe, expect, it } from 'vitest';
import { Geometry } from '../geometry';
import type { DrawingBarData, DrawingPoint, HandleMoveArgs } from '../types';
import { disjointFourth } from './disjoint-channel';
import { pearsonText, REGRESSION_TREND_DEFAULTS, regressionChannel } from './regression-trend';
import {
  FORMAT,
  geometryOf,
  makeDrawing,
  makeView,
  N,
  pt,
  recordingContext,
  SELECTED,
  START,
  tool,
} from './test-utils';
import { trendAngleDegrees, trendAngleText } from './trend-angle';

const view = makeView();
const { X, Y } = view;
const TOL = 4;
const D = 86_400;

function setup(type: string, points: DrawingPoint[], style = {}, bars?: DrawingBarData) {
  const d = makeDrawing(type, points, style);
  const g = new Geometry();
  g.update(
    d,
    view.pane,
    { timeline: view.timeline, timeScale: view.ts, width: 800, ...(bars ? { bars } : {}) },
    FORMAT,
  );
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

type RegStyle = typeof REGRESSION_TREND_DEFAULTS;

const bar = (p: DrawingPoint) => (p.time - START) / D;

describe('trend angle', () => {
  it('measures the screen angle counter-clockwise in degrees', () => {
    // 200 px right, 160 px up: atan(160 / 200) = 38.6598°.
    const { g } = setup('trend-angle', [pt(20, 20), pt(40, 60)]);
    expect(trendAngleDegrees(g)).toBeCloseTo(38.6598, 3);
    expect(trendAngleText(trendAngleDegrees(g))).toBe('38.66°');
    // 100 px right, 100 px down: -45°; pointing left and up: 135°.
    expect(trendAngleDegrees(setup('trend-angle', [pt(20, 50), pt(30, 25)]).g)).toBeCloseTo(-45);
    expect(trendAngleDegrees(setup('trend-angle', [pt(30, 50), pt(20, 75)]).g)).toBeCloseTo(135);
    expect(trendAngleDegrees(setup('trend-angle', [pt(30, 50)]).g)).toBeNaN();
  });

  it('draws the line, reference, arc and angle label; Shift snaps to 45°', () => {
    const { def, g, d } = setup('trend-angle', [pt(20, 20), pt(40, 60)]);
    const { rc, calls, texts } = recordingContext();
    def.render(rc, g, d.style, SELECTED);
    expect(calls).toContain('arc');
    expect(texts).toContain('38.66°');
    expect(def.shiftConstraint).toBe('angle');
    expect(def.properties.some((p) => p.key === 'showAngle')).toBe(false);
  });

  it('hits the line and the angle label', () => {
    const { at } = setup('trend-angle', [pt(20, 20), pt(40, 60)]);
    expect(at(X(30), Y(40))).toEqual({ kind: 'body' });
    // Label centre: anchor 0 + 48 px at half the angle (-19.33° on canvas).
    const h = Math.atan2(-160, 200) / 2;
    expect(at(X(20) + 48 * Math.cos(h) + 4, Y(20) + 48 * Math.sin(h))).toEqual({ kind: 'body' });
    expect(at(X(20) + 20, Y(20) + 40)).toBeNull();
  });
});

/** Bars with closes 40, 48, 44, 60, 48 at 20..24 (50 elsewhere). */
function bars(): DrawingBarData {
  const close = Array.from({ length: N }, () => 50);
  [40, 48, 44, 60, 48].forEach((c, i) => (close[20 + i] = c));
  return {
    length: N,
    time: Array.from({ length: N }, (_, i) => START + i * D),
    open: close,
    high: close,
    low: close,
    close,
    volume: close,
  };
}

describe('regression trend', () => {
  // x 20..24, mean 22; y mean 48. sxy 28, sxx 10 -> slope 2.8, intercept -13.6.
  // Residuals -2.4 2.8 -4 9.2 -5.6 -> SSE 145.6 -> stdev sqrt(29.12) = 5.3963.
  // syy 224 -> r = 28 / sqrt(10 * 224) = 0.59161.
  const STDEV = Math.sqrt(29.12);
  const base = (i: number) => 2.8 * i - 13.6;

  it('fits the closes between the anchor bars', () => {
    const { g, d } = setup('regression-trend', [pt(20, 99), pt(24, 1)], {}, bars());
    const c = regressionChannel(g, d.style as RegStyle)!;
    expect(c.fit.slope).toBeCloseTo(2.8, 9);
    expect(c.fit.intercept).toBeCloseTo(-13.6, 9);
    expect(c.fit.stdev).toBeCloseTo(STDEV, 9);
    expect(c.fit.r).toBeCloseTo(0.59161, 5);
    expect(pearsonText(c.fit.r)).toBe('0.592');
    expect([c.from, c.to]).toEqual([20, 24]);
    expect(c.base[1]).toBeCloseTo(Y(base(20)), 9);
    expect(c.upper[3]).toBeCloseTo(Y(base(24) + 2 * STDEV), 9);
    expect(c.lower[1]).toBeCloseTo(Y(base(20) - 2 * STDEV), 9);
    // Anchor order does not matter.
    const r = setup('regression-trend', [pt(24, 0), pt(20, 0)], {}, bars());
    expect(regressionChannel(r.g, r.d.style as RegStyle)!.fit.slope).toBeCloseTo(2.8, 9);
  });

  it('renders the lines and Pearson r, nothing without bars', () => {
    const { def, g, d } = setup('regression-trend', [pt(20, 0), pt(24, 0)], {}, bars());
    const { rc, calls, texts } = recordingContext();
    def.render(rc, g, d.style, SELECTED);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(3);
    expect(texts).toEqual(['0.592']);
    const empty = setup('regression-trend', [pt(20, 0), pt(24, 0)]);
    const rec = recordingContext();
    def.render(rec.rc, empty.g, empty.d.style, SELECTED);
    expect(rec.calls).toEqual([]);
    expect(empty.at(X(22), Y(base(22)))).toBeNull();
    expect(def.panes).toBe('main');
    expect(def.axes).toBe('time');
  });

  it('hits the lines strongly and the band weakly; extends on request', () => {
    const { at } = setup('regression-trend', [pt(20, 0), pt(24, 0)], {}, bars());
    expect(at(X(22), Y(base(22)))).toEqual({ kind: 'body' });
    expect(at(X(22), Y(base(22) + 2 * STDEV))).toEqual({ kind: 'body' });
    expect(at(X(22), Y(base(22) - 2 * STDEV))).toEqual({ kind: 'body' });
    expect(at(X(22), Y(base(22) + STDEV))).toEqual({ kind: 'body', weak: true });
    expect(at(X(26), Y(base(26)))).toBeNull();
    const ext = setup('regression-trend', [pt(20, 0), pt(24, 0)], { extendRight: true }, bars());
    expect(ext.at(X(26), Y(base(26)))).toEqual({ kind: 'body' });
    const narrow = setup('regression-trend', [pt(20, 0), pt(24, 0)], { upperDeviation: 1 }, bars());
    expect(narrow.at(X(22), Y(base(22) + STDEV))).toEqual({ kind: 'body' });
  });

  it('puts handles on the base line and moves only the anchor times', () => {
    const { def, g, d } = setup('regression-trend', [pt(20, 90), pt(24, 10)], {}, bars());
    const [h0, h1] = def.handles!(g, d.style);
    expect(h0!.x).toBeCloseTo(X(20), 9);
    expect(h0!.y).toBeCloseTo(Y(base(20)), 9);
    expect(h1!.y).toBeCloseTo(Y(base(24)), 9);
    expect(def.moveHandle).toBeUndefined(); // framework default honours axes 'time'
    expect(def.priceAxisLabels!(d, d.style, SELECTED)).toEqual([]);
  });

  it('is culled off screen', () => {
    const far = setup('regression-trend', [pt(-300, 0), pt(-290, 0)], {}, bars());
    expect(far.def.isVisible!(far.g, far.d.style)).toBe(false);
    const on = setup('regression-trend', [pt(20, 0), pt(24, 0)], {}, bars());
    expect(on.def.isVisible!(on.g, on.d.style)).toBe(true);
  });
});

describe('flat top/bottom', () => {
  const pts = [pt(20, 20), pt(40, 40), pt(30, 60)];

  it('completes anchor 2 at anchor 0 time', () => {
    const { def, g, d } = setup('flat-top-bottom', pts);
    const out = def.completePoints!(pts, g, d.style);
    expect(out.map(bar)).toEqual([20, 40, 20]);
    expect(out[2]!.price).toBe(60);
  });

  it('hits the trend line, the flat line and the weak fill', () => {
    const { at } = setup('flat-top-bottom', pts);
    expect(at(X(30), Y(30))).toEqual({ kind: 'body' });
    expect(at(X(25), Y(60))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(45))).toEqual({ kind: 'body', weak: true });
    expect(at(X(50), Y(60))).toBeNull();
    expect(setup('flat-top-bottom', pts, { extendRight: true }).at(X(50), Y(60))).toEqual({
      kind: 'body',
    });
    expect(setup('flat-top-bottom', pts, { fillBackground: false }).at(X(30), Y(45))).toBeNull();
    // Two-anchor draft: just the trend line.
    expect(setup('flat-top-bottom', pts.slice(0, 2)).at(X(30), Y(30))).toEqual({ kind: 'body' });
  });

  it('has flat-line handles mapped back to the anchors', () => {
    const done = [pt(20, 20), pt(40, 40), pt(20, 60)];
    const { def, g, d, move } = setup('flat-top-bottom', done);
    const hs = def.handles!(g, d.style);
    expect(hs).toHaveLength(4);
    expect(hs[2]).toMatchObject({ x: X(20), y: Y(60) });
    expect(hs[3]).toMatchObject({ x: X(40), y: Y(60) });
    const a = move(2, pt(15, 70));
    expect(a.map(bar)).toEqual([15, 40, 15]);
    expect(a.map((p) => p.price)).toEqual([20, 40, 70]);
    const b = move(3, pt(45, 65));
    expect(b.map(bar)).toEqual([20, 45, 20]);
    expect(b.map((p) => p.price)).toEqual([20, 40, 65]);
    const c = move(0, pt(10, 25));
    expect(c.map(bar)).toEqual([10, 40, 10]);
    expect(c.map((p) => p.price)).toEqual([25, 40, 60]);
  });
});

describe('disjoint channel', () => {
  const pts = [pt(20, 20), pt(40, 40), pt(25, 70)];

  it('derives the mirrored fourth anchor', () => {
    // Line 0-1 rises 20: the second line falls 20 from 70.
    const p3 = disjointFourth(pts)!;
    expect(bar(p3)).toBe(40);
    expect(p3.price).toBe(50);
    const { def, g, d } = setup('disjoint-channel', pts);
    const out = def.completePoints!(pts, g, d.style);
    expect(out.map(bar)).toEqual([20, 40, 20, 40]);
    expect(out.map((p) => p.price)).toEqual([20, 40, 70, 50]);
    expect(disjointFourth(pts.slice(0, 2))).toBeNull();
  });

  it('hits both lines (draft and complete) and the weak fill', () => {
    for (const p of [pts, [pt(20, 20), pt(40, 40), pt(20, 70), pt(40, 50)]]) {
      const { at } = setup('disjoint-channel', p);
      expect(at(X(30), Y(30))).toEqual({ kind: 'body' });
      expect(at(X(30), Y(60))).toEqual({ kind: 'body' });
      expect(at(X(30), Y(45))).toEqual({ kind: 'body', weak: true });
      expect(at(X(45), Y(45))).toBeNull();
    }
  });

  it('moves each end, keeping the vertical edges', () => {
    const done = [pt(20, 20), pt(40, 40), pt(20, 70), pt(40, 50)];
    const { def, g, d, move } = setup('disjoint-channel', done);
    expect(def.handles!(g, d.style)).toHaveLength(4);
    const a = move(0, pt(15, 25));
    expect(a.map(bar)).toEqual([15, 40, 15, 40]);
    expect(a.map((p) => p.price)).toEqual([25, 40, 70, 50]);
    const b = move(3, pt(45, 55));
    expect(b.map(bar)).toEqual([20, 45, 20, 45]);
    expect(b.map((p) => p.price)).toEqual([20, 40, 70, 55]);
  });

  it('is visible while the fill covers the pane, culled far away', () => {
    const def = tool('disjoint-channel');
    const big = makeDrawing('disjoint-channel', [
      pt(-50, -50),
      pt(150, -50),
      pt(-50, 200),
      pt(150, 200),
    ]);
    expect(def.isVisible!(geometryOf(big), big.style)).toBe(true);
    const far = makeDrawing('disjoint-channel', [pt(-90, 1), pt(-80, 2), pt(-90, 5), pt(-80, 4)]);
    expect(def.isVisible!(geometryOf(far), far.style)).toBe(false);
  });
});

describe('legacy trend line showAngle', () => {
  it('a saved trend line with style.showAngle still renders its angle label', () => {
    // The Angle option moved to the trend-angle tool, but the trend line keeps the key.
    const { d, g, def } = setup('trend-line', [pt(20, 20), pt(40, 60)], { showAngle: true });
    expect(def.properties.some((p) => p.key === 'showAngle')).toBe(true);
    const r = recordingContext();
    def.render(r.rc, g, d.style, SELECTED);
    expect(r.texts).toContain('38.66°');
  });

  it('unknown saved style keys are ignored', () => {
    const { d, g, def } = setup('trend-line', [pt(20, 20), pt(40, 60)], { removedOption: 1 });
    const r = recordingContext();
    expect(() => def.render(r.rc, g, d.style, SELECTED)).not.toThrow();
  });
});
