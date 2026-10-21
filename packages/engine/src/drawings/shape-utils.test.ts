import { describe, expect, it } from 'vitest';
import {
  arcDistance,
  circleThrough3,
  cubicBezierDistance,
  ellipseDistance,
  linearRegression,
  pointInPolygon,
  polylineDistance,
  quadBezierDistance,
  quadBezierPoint,
  rotate,
  strokePolyline,
} from './shape-utils';
import type { DrawingBarData } from './types';

const P = (x: number, y: number) => ({ x, y });

function bars(close: number[]): DrawingBarData {
  return {
    length: close.length,
    time: close.map((_, i) => i),
    open: close,
    high: close,
    low: close,
    close,
    volume: close.map(() => 0),
  };
}

describe('polylineDistance', () => {
  const L = [P(0, 0), P(10, 0), P(10, 10)];

  it('is the nearest segment distance', () => {
    expect(polylineDistance(L, 5, 3)).toBe(3);
    expect(polylineDistance(L, -3, -4)).toBe(5); // past the first vertex
    expect(polylineDistance(L, 13, 6)).toBe(3);
  });

  it('closed adds the last -> first segment', () => {
    expect(polylineDistance(L, 5, 5)).toBe(5);
    expect(polylineDistance(L, 5, 5, true)).toBeCloseTo(0, 12); // on y = x
  });

  it('handles one point and skips NaN points', () => {
    expect(polylineDistance([P(1, 1)], 4, 5)).toBe(5);
    expect(polylineDistance([P(0, 0), P(NaN, NaN), P(10, 0)], 5, 0)).toBe(Infinity);
    expect(polylineDistance([], 0, 0)).toBe(Infinity);
  });
});

describe('pointInPolygon', () => {
  it('square and concave U', () => {
    const sq = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];
    expect(pointInPolygon(sq, 5, 5)).toBe(true);
    expect(pointInPolygon(sq, 15, 5)).toBe(false);
    // U open at the top: the notch (4..6, 0..8) is outside.
    const u = [P(0, 0), P(4, 0), P(4, 8), P(6, 8), P(6, 0), P(10, 0), P(10, 10), P(0, 10)];
    expect(pointInPolygon(u, 5, 4)).toBe(false);
    expect(pointInPolygon(u, 2, 4)).toBe(true);
    expect(pointInPolygon(u, 5, 9)).toBe(true);
    expect(pointInPolygon([P(0, 0), P(1, 1)], 0.5, 0.5)).toBe(false);
  });
});

describe('Bézier curves', () => {
  const [a, c, b] = [P(0, 0), P(10, 20), P(20, 0)];

  it('quadratic point: t = 0.5 is 1/4 p0 + 1/2 p1 + 1/4 p2', () => {
    expect(quadBezierPoint(a, c, b, 0.5)).toEqual({ x: 10, y: 10 });
    expect(quadBezierPoint(a, c, b, 0)).toEqual(a);
    expect(quadBezierPoint(a, c, b, 1)).toEqual(b);
  });

  it('quadratic distance: 2 px above the apex (10, 10); ends', () => {
    // Radius of curvature at the apex is 5 px > 2, so the apex is nearest.
    expect(quadBezierDistance(a, c, b, 10, 12)).toBeCloseTo(2, 9);
    expect(quadBezierDistance(a, c, b, -3, -4)).toBeCloseTo(5, 9);
  });

  it('cubic distance: apex (5, 7.5) of the S-free arch; ends', () => {
    const [p0, p1, p2, p3] = [P(0, 0), P(0, 10), P(10, 10), P(10, 0)];
    // B(0.5) = (.375*10 + .125*10, .375*10 + .375*10) = (5, 7.5); curvature radius 3.75.
    expect(cubicBezierDistance(p0, p1, p2, p3, 5, 9)).toBeCloseTo(1.5, 9);
    expect(cubicBezierDistance(p0, p1, p2, p3, 0, -3)).toBeCloseTo(3, 9);
  });
});

describe('ellipseDistance', () => {
  it('circle: |distance to centre - r|', () => {
    expect(ellipseDistance(0, 0, 10, 10, 3, 4)).toBe(5);
    expect(ellipseDistance(5, 5, 10, 10, 5, 5)).toBe(10);
  });

  it('axis points of a 20 x 10 ellipse', () => {
    expect(ellipseDistance(0, 0, 20, 10, 30, 0)).toBeCloseTo(10, 6);
    expect(ellipseDistance(0, 0, 20, 10, 0, -25)).toBeCloseTo(15, 6);
    expect(ellipseDistance(0, 0, 20, 10, 20, 0)).toBeCloseTo(0, 6);
    expect(ellipseDistance(0, 0, 20, 10, 0, 0)).toBeCloseTo(10, 6); // nearest: minor vertex
  });

  it('rotation turns the axes (90°: major axis vertical)', () => {
    expect(ellipseDistance(0, 0, 20, 10, 0, 30, Math.PI / 2)).toBeCloseTo(10, 6);
    expect(ellipseDistance(0, 0, 20, 10, 30, 0, Math.PI / 2)).toBeCloseTo(20, 6);
  });

  it('matches brute force within 0.05 px', () => {
    const [rx, ry, rot] = [120, 40, 0.6];
    const brute = (x: number, y: number) => {
      let best = Infinity;
      for (let i = 0; i < 20000; i++) {
        const t = (i / 20000) * 2 * Math.PI;
        const ex = rx * Math.cos(t);
        const ey = ry * Math.sin(t);
        const px = ex * Math.cos(rot) - ey * Math.sin(rot);
        const py = ex * Math.sin(rot) + ey * Math.cos(rot);
        best = Math.min(best, Math.hypot(x - px, y - py));
      }
      return best;
    };
    for (const [x, y] of [
      [130, 10],
      [-50, 60],
      [10, -5],
      [0, 200],
      [90, 70],
    ] as const)
      expect(Math.abs(ellipseDistance(0, 0, rx, ry, x, y, rot) - brute(x, y))).toBeLessThan(0.05);
  });

  it('degenerate radii are segments', () => {
    expect(ellipseDistance(0, 0, 0, 10, 3, 4)).toBe(3);
    expect(ellipseDistance(0, 0, 10, 0, 13, 4)).toBe(5);
  });
});

describe('circleThrough3 and arcDistance', () => {
  it('circumcircle of a right triangle; null when collinear', () => {
    const c = circleThrough3(P(0, 0), P(2, 0), P(0, 2))!;
    expect(c.x).toBeCloseTo(1, 12);
    expect(c.y).toBeCloseTo(1, 12);
    expect(c.r).toBeCloseTo(Math.SQRT2, 12);
    const d = circleThrough3(P(-10, 0), P(0, 10), P(10, 0))!;
    expect(Math.abs(d.x) + Math.abs(d.y)).toBeCloseTo(0, 12);
    expect(d.r).toBeCloseTo(10, 12);
    expect(circleThrough3(P(0, 0), P(1, 1), P(3, 3))).toBeNull();
  });

  it('distance to the arc 0 -> 90° (clockwise on screen) and its complement', () => {
    expect(arcDistance(0, 0, 10, 0, Math.PI / 2, 20, 0)).toBeCloseTo(10, 12);
    expect(arcDistance(0, 0, 10, 0, Math.PI / 2, 0, 20)).toBeCloseTo(10, 12);
    // (0, -10) is outside the short arc: nearest end is (10, 0).
    expect(arcDistance(0, 0, 10, 0, Math.PI / 2, 0, -10)).toBeCloseTo(Math.hypot(10, 10), 12);
    // Anticlockwise from 0 to 90° is the long way round, through (0, -10).
    expect(arcDistance(0, 0, 10, 0, Math.PI / 2, 0, -10, true)).toBeCloseTo(0, 12);
    // (3, 4) lies in the excluded quarter: ends (10, 0) at hypot(7, 4), (0, 10) at hypot(3, 6).
    expect(arcDistance(0, 0, 10, 0, Math.PI / 2, 3, 4, true)).toBeCloseTo(Math.hypot(3, 6), 12);
    // A full turn is a circle.
    expect(arcDistance(0, 0, 10, 0, 2 * Math.PI, -13, 0)).toBeCloseTo(3, 12);
  });
});

describe('rotate', () => {
  it('turns clockwise on screen for positive angles', () => {
    const a = rotate(P(10, 0), P(0, 0), Math.PI / 2);
    expect(a.x).toBeCloseTo(0, 12);
    expect(a.y).toBeCloseTo(10, 12);
    const b = rotate(P(6, 5), P(5, 5), Math.PI);
    expect(b.x).toBeCloseTo(4, 12);
    expect(b.y).toBeCloseTo(5, 12);
  });
});

describe('linearRegression', () => {
  it('exact line: slope 2, intercept 1, stdev 0, r 1', () => {
    expect(linearRegression(bars([1, 3, 5, 7]), 0, 3)).toEqual({
      slope: 2,
      intercept: 1,
      stdev: 0,
      r: 1,
      n: 4,
    });
  });

  it('hand-computed fit of 2, 4, 3, 5', () => {
    // mx 1.5, my 3.5, Sxy 4, Sxx 5, Syy 5 -> slope .8, intercept 2.3, r .8;
    // residuals -.3 .9 -.9 .3 -> SSE 1.8, stdev sqrt(1.8 / 4).
    const r = linearRegression(bars([2, 4, 3, 5]), 0, 3)!;
    expect(r.slope).toBeCloseTo(0.8, 12);
    expect(r.intercept).toBeCloseTo(2.3, 12);
    expect(r.stdev).toBeCloseTo(Math.sqrt(0.45), 12);
    expect(r.r).toBeCloseTo(0.8, 12);
    expect(r.n).toBe(4);
  });

  it('uses logical indices: same closes at 2..5 shift the intercept', () => {
    // intercept = 3.5 - .8 * 3.5 = .7
    const r = linearRegression(bars([9, 9, 2, 4, 3, 5]), 5, 2)!; // either order
    expect(r.slope).toBeCloseTo(0.8, 12);
    expect(r.intercept).toBeCloseTo(0.7, 12);
  });

  it('clamps to the data, rounds inwards, skips NaN, needs 2 bars', () => {
    expect(linearRegression(bars([1, 3, 5, 7]), -5, 30)!.n).toBe(4);
    expect(linearRegression(bars([1, 3, 5, 7]), 0.5, 3)!.n).toBe(3);
    expect(linearRegression(bars([1, NaN, 5]), 0, 2)).toMatchObject({ slope: 2, n: 2 });
    expect(linearRegression(bars([1, 3]), 1, 1)).toBeNull();
    expect(linearRegression(bars([]), 0, 10)).toBeNull();
    const flat = linearRegression(bars([4, 4, 4]), 0, 2)!;
    expect(flat.slope).toBe(0);
    expect(flat.r).toBeNaN();
  });
});

describe('strokePolyline', () => {
  function ctx() {
    const calls: string[] = [];
    const rec =
      (k: string) =>
      (...a: number[]) =>
        calls.push(a.length ? `${k}(${a.join(',')})` : k);
    const c = {
      beginPath: rec('beginPath'),
      moveTo: rec('moveTo'),
      lineTo: rec('lineTo'),
      closePath: rec('closePath'),
      stroke: rec('stroke'),
    };
    return { c: c as unknown as CanvasRenderingContext2D, calls };
  }

  it('strokes one path, closed on request; NaN breaks the line', () => {
    const a = ctx();
    strokePolyline(a.c, [P(0, 0), P(1, 2), P(3, 4)], true);
    expect(a.calls).toEqual([
      'beginPath',
      'moveTo(0,0)',
      'lineTo(1,2)',
      'lineTo(3,4)',
      'closePath',
      'stroke',
    ]);
    const b = ctx();
    strokePolyline(b.c, [P(0, 0), P(1, 1), P(NaN, 0), P(2, 2), P(3, 3)], true);
    expect(b.calls).toEqual([
      'beginPath',
      'moveTo(0,0)',
      'lineTo(1,1)',
      'moveTo(2,2)',
      'lineTo(3,3)',
      'stroke',
    ]);
  });
});
