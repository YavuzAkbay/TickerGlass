import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { quadBezierDistance } from '../shape-utils';
import type { DrawingGeometry, PixelPoint } from '../types';
import { LINE_PROPERTIES, lineDefaults, pointsInView, upNormal } from './shape-common';

export const CURVE_DEFAULTS = lineDefaults('#6E9BD6');

/** Default bow of a fresh curve: the curve midpoint sits this fraction of the
 * chord length above the chord midpoint (screen). */
export const CURVE_BOW = 0.25;

/** On-curve midpoint of a fresh curve between `a` and `b` (px). */
export function defaultCurveMid(a: PixelPoint, b: PixelPoint): PixelPoint {
  const n = upNormal(a, b);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return n ? { x: mx + n.x * len * CURVE_BOW, y: my + n.y * len * CURVE_BOW } : { x: mx, y: my };
}

/** Bézier control point that makes the curve pass through `m` at t = 0.5. */
export function quadControl(a: PixelPoint, b: PixelPoint, m: PixelPoint): PixelPoint {
  return { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
}

/** Ends and control of the curve; the 2-anchor draft uses the default bow. */
function curveOf(g: DrawingGeometry): [PixelPoint, PixelPoint, PixelPoint] | null {
  const [a, b, m] = g.points;
  if (!a || !b) return null;
  return [a, quadControl(a, b, m ?? defaultCurveMid(a, b)), b];
}

/**
 * Quadratic Bézier between anchors 0 and 1. Anchor 2 (added on creation, bowed
 * up by default) is the curve's midpoint (t = 0.5), so its handle sits on the
 * curve; the control point is derived from it.
 */
export const curve = defineDrawingTool({
  type: 'curve',
  name: 'Curve',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  defaults: CURVE_DEFAULTS,
  properties: LINE_PROPERTIES,

  render({ ctx }, g, s) {
    const c = curveOf(g);
    if (!c) return;
    const [a, k, b] = c;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(k.x, k.y, b.x, b.y);
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const c = curveOf(g);
    if (!c) return null;
    return quadBezierDistance(c[0], c[1], c[2], x, y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  completePoints(points, g) {
    const out = points.map((p) => ({ ...p }));
    const [a, b] = g.points;
    if (points.length !== 2 || !a || !b) return out;
    const m = defaultCurveMid(a, b);
    out.push(g.toPoint(m.x, m.y));
    return out;
  },

  isVisible(g) {
    const c = curveOf(g);
    return c ? pointsInView(g, c) : false;
  },
});
