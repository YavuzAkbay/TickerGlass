import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { cubicBezierDistance } from '../shape-utils';
import type { DrawingGeometry, PixelPoint } from '../types';
import { LINE_PROPERTIES, lineDefaults, pointsInView, upNormal } from './shape-common';

export const S_CURVE_DEFAULTS = lineDefaults('#4f6bed');

/** Default S bow: on-curve points at t = 1/3 and 2/3 sit this fraction of the
 * chord length above / below the chord. */
export const S_CURVE_BOW = 0.15;

/** On-curve points at t = 1/3 and t = 2/3 of a fresh S curve between `a` and `b`. */
export function defaultSCurvePoints(a: PixelPoint, b: PixelPoint): [PixelPoint, PixelPoint] {
  const n = upNormal(a, b) ?? { x: 0, y: 0 };
  const off = Math.hypot(b.x - a.x, b.y - a.y) * S_CURVE_BOW;
  const lerp = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const q1 = lerp(1 / 3);
  const q2 = lerp(2 / 3);
  return [
    { x: q1.x + n.x * off, y: q1.y + n.y * off },
    { x: q2.x - n.x * off, y: q2.y - n.y * off },
  ];
}

/**
 * Cubic Bézier controls so the curve a -> b passes through q1 at t = 1/3 and
 * q2 at t = 2/3.
 */
export function cubicControls(
  a: PixelPoint,
  b: PixelPoint,
  q1: PixelPoint,
  q2: PixelPoint,
): [PixelPoint, PixelPoint] {
  return [
    {
      x: (-5 * a.x + 18 * q1.x - 9 * q2.x + 2 * b.x) / 6,
      y: (-5 * a.y + 18 * q1.y - 9 * q2.y + 2 * b.y) / 6,
    },
    {
      x: (2 * a.x - 9 * q1.x + 18 * q2.x - 5 * b.x) / 6,
      y: (2 * a.y - 9 * q1.y + 18 * q2.y - 5 * b.y) / 6,
    },
  ];
}

/** Ends and controls; the 2-anchor draft uses the default S bow. */
function curveOf(g: DrawingGeometry): [PixelPoint, PixelPoint, PixelPoint, PixelPoint] | null {
  const [a, b, q1, q2] = g.points;
  if (!a || !b) return null;
  const [d1, d2] = q1 && q2 ? [q1, q2] : defaultSCurvePoints(a, b);
  const [c1, c2] = cubicControls(a, b, d1, d2);
  return [a, c1, c2, b];
}

/**
 * S-shaped cubic Bézier between anchors 0 and 1. Anchors 2 and 3 (added on
 * creation, an S bow by default) are the curve's points at t = 1/3 and 2/3,
 * so their handles sit on the curve; the controls are derived from them.
 */
export const sCurve = defineDrawingTool({
  type: 's-curve',
  name: 'S-curve',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  defaults: S_CURVE_DEFAULTS,
  properties: LINE_PROPERTIES,

  render({ ctx }, g, s) {
    const c = curveOf(g);
    if (!c) return;
    const [a, c1, c2, b] = c;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const c = curveOf(g);
    if (!c) return null;
    return cubicBezierDistance(c[0], c[1], c[2], c[3], x, y) <= tol + s.lineWidth / 2
      ? BODY_HIT
      : null;
  },

  completePoints(points, g) {
    const out = points.map((p) => ({ ...p }));
    const [a, b] = g.points;
    if (points.length !== 2 || !a || !b) return out;
    for (const q of defaultSCurvePoints(a, b)) out.push(g.toPoint(q.x, q.y));
    return out;
  },

  isVisible(g) {
    const c = curveOf(g);
    return c ? pointsInView(g, c) : false;
  },
});
