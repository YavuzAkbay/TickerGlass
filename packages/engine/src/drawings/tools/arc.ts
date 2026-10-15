import { BODY_HIT, lineDistance, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { arcDistance, circleThrough3 } from '../shape-utils';
import type { DrawingGeometry, PixelPoint } from '../types';
import { pointsInView, SHAPE_PROPERTIES, shapeDefaults } from './shape-common';

export const ARC_DEFAULTS = shapeDefaults('#9c27b0', 'rgba(156, 39, 176, 0.2)');

export interface ArcSpec {
  x: number;
  y: number;
  r: number;
  start: number;
  end: number;
  /** `ctx.arc` direction that passes through the middle anchor. */
  anticlockwise: boolean;
}

/** Angle in [0, 2π). */
function norm(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/**
 * Circular arc from `a` to `b` through `m` (all px), or null when the points
 * are collinear or coincide (drawn as the chord a -> b).
 */
export function arcThrough(a: PixelPoint, b: PixelPoint, m: PixelPoint): ArcSpec | null {
  const c = circleThrough3(a, m, b);
  if (!c || !Number.isFinite(c.r)) return null;
  const start = Math.atan2(a.y - c.y, a.x - c.x);
  const end = Math.atan2(b.y - c.y, b.x - c.x);
  const mid = Math.atan2(m.y - c.y, m.x - c.x);
  // Clockwise (screen) sweep start -> end contains mid, else go the other way.
  const anticlockwise = norm(mid - start) > norm(end - start);
  return { x: c.x, y: c.y, r: c.r, start, end, anticlockwise };
}

function arcOf(g: DrawingGeometry): ArcSpec | null {
  const [a, b, m] = g.points;
  return a && b && m ? arcThrough(a, b, m) : null;
}

/**
 * Arc: anchors 0 and 1 are the ends, anchor 2 a point the arc passes through
 * (circle through 3 points, screen px). The background fills the circular
 * segment between the arc and the chord 0 -> 1.
 */
export const arc = defineDrawingTool({
  type: 'arc',
  name: 'Arc',
  group: 'shapes',
  creation: { kind: 'points', count: 3 },
  defaults: ARC_DEFAULTS,
  properties: SHAPE_PROPERTIES,

  render({ ctx }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    const k = arcOf(g);
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (!k) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      return;
    }
    ctx.arc(k.x, k.y, k.r, k.start, k.end, k.anticlockwise);
    if (s.fillBackground) {
      ctx.closePath();
      ctx.fillStyle = s.backgroundColor;
      ctx.fill();
      // Stroke the arc only, not the chord.
      ctx.beginPath();
      ctx.arc(k.x, k.y, k.r, k.start, k.end, k.anticlockwise);
    }
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const [a, b, m] = g.points;
    if (!a || !b) return null;
    const t = tol + s.lineWidth / 2;
    const k = arcOf(g);
    if (!k || !m) return lineDistance(x, y, a.x, a.y, b.x, b.y) <= t ? BODY_HIT : null;
    if (arcDistance(k.x, k.y, k.r, k.start, k.end, x, y, k.anticlockwise) <= t) return BODY_HIT;
    if (!s.fillBackground || Math.hypot(x - k.x, y - k.y) > k.r) return null;
    // Circular segment: inside the circle, on the arc's side of the chord.
    const side = (px: number, py: number) => (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    return side(x, y) * side(m.x, m.y) >= 0 ? BODY_HIT : null;
  },

  isVisible(g) {
    const k = arcOf(g);
    if (!k) return pointsInView(g, g.points);
    return (
      k.x + k.r >= -20 &&
      k.x - k.r <= g.width + 20 &&
      k.y + k.r >= -20 &&
      k.y - k.r <= g.height + 20
    );
  },
});
