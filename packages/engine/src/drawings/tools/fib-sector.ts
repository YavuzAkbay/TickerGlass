import { anchorsInView, BODY_HIT, lineDistance, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import {
  arcLevelsInView,
  defaultArcLevels,
  FIB_ARC_DEFAULTS,
  FIB_ARC_PROPERTIES,
  hitArcLevels,
  maxArcRadius,
  renderArcLevels,
  type ArcLevelsSpec,
  type FibArcStyle,
} from './fib-common';

export const FIB_SECTOR_DEFAULTS: FibArcStyle = {
  ...FIB_ARC_DEFAULTS,
  lineStyle: 'solid',
  levels: defaultArcLevels(1),
};

const spec: ArcLevelsSpec = {
  cx: 0,
  cy: 0,
  unit: 0,
  start: 0,
  end: 0,
  anticlockwise: false,
  full: false,
  labelAngle: 0,
};

/**
 * Wedge arcs: centred on the apex (anchor 1), radius level * |anchor 1 -
 * anchor 2|, over the smaller angle between the rays to anchors 2 and 3.
 */
export function wedgeSpec(g: DrawingGeometry): ArcLevelsSpec | null {
  const [a, b, c] = g.points;
  if (!a || !b || !c) return null;
  const a1 = Math.atan2(b.y - a.y, b.x - a.x);
  const a2 = Math.atan2(c.y - a.y, c.x - a.x);
  let d = a2 - a1;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  spec.cx = a.x;
  spec.cy = a.y;
  spec.unit = Math.hypot(b.x - a.x, b.y - a.y);
  spec.start = a1;
  spec.end = a1 + d;
  spec.anticlockwise = d < 0;
  spec.labelAngle = a1 + d / 2;
  return spec;
}

/** Wedge side (apex -> angle `t`) of length `r`. */
function side(ctx: CanvasRenderingContext2D, w: ArcLevelsSpec, t: number, r: number): void {
  ctx.moveTo(w.cx, w.cy);
  ctx.lineTo(w.cx + Math.cos(t) * r, w.cy + Math.sin(t) * r);
}

function sideDistance(w: ArcLevelsSpec, t: number, r: number, x: number, y: number): number {
  return lineDistance(x, y, w.cx, w.cy, w.cx + Math.cos(t) * r, w.cy + Math.sin(t) * r);
}

/**
 * Fib sector: apex anchor 1, sides towards anchors 2 and 3 (out to the
 * largest level), arcs at level * |anchor 1 - anchor 2| between them. Pixel space.
 */
export const fibSector = defineDrawingTool({
  type: 'fib-sector',
  name: 'Fib sector',
  group: 'fib',
  creation: { kind: 'points', count: 3 },
  defaults: FIB_SECTOR_DEFAULTS,
  properties: FIB_ARC_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    const w = wedgeSpec(g);
    if (!w) {
      setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      return;
    }
    renderArcLevels(ctx, theme, s, w);
    if (s.showTrendLine) {
      const r = Math.max(maxArcRadius(s, w.unit), w.unit);
      setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
      ctx.beginPath();
      side(ctx, w, w.start, r);
      side(ctx, w, w.end, r);
      ctx.stroke();
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const t = tol + s.lineWidth / 2;
    const w = wedgeSpec(g);
    if (!w) return lineDistance(x, y, a.x, a.y, b.x, b.y) <= t ? BODY_HIT : null;
    if (s.showTrendLine) {
      const r = Math.max(maxArcRadius(s, w.unit), w.unit);
      if (sideDistance(w, w.start, r, x, y) <= t || sideDistance(w, w.end, r, x, y) <= t)
        return BODY_HIT;
    }
    return hitArcLevels(s, w, x, y, tol);
  },

  isVisible(g, s) {
    const w = wedgeSpec(g);
    return w ? arcLevelsInView(g, s, w) : anchorsInView(g);
  },
});
