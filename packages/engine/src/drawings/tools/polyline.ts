import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { polylineDistance, strokePolyline } from '../shape-utils';
import type { DrawingPoint, PixelPoint } from '../types';
import {
  hitPolygon,
  pointsInView,
  renderPolygon,
  samePoint,
  SHAPE_PROPERTIES,
  shapeDefaults,
} from './shape-common';

export const POLYLINE_DEFAULTS = shapeDefaults('#4f6bed', 'rgba(79, 107, 237, 0.2)');

/** Closed polyline: more than 2 anchors and the last is an exact copy of the first
 * (creation finished by clicking on anchor 0). */
export function isClosedPolyline(points: readonly DrawingPoint[]): boolean {
  const n = points.length;
  return n > 2 && samePoint(points[0]!, points[n - 1]!);
}

/** Pixel vertices: the duplicate closing anchor dropped when closed. */
function vertices(points: readonly PixelPoint[], closed: boolean): readonly PixelPoint[] {
  return closed ? points.slice(0, -1) : points;
}

/**
 * Polyline of 2+ clicked anchors. Clicking on the first anchor closes it
 * (filled polygon); otherwise it stays open (no fill). Handles: one per
 * vertex; the first also moves the closing copy.
 */
export const polyline = defineDrawingTool({
  type: 'polyline',
  name: 'Polyline',
  group: 'shapes',
  creation: { kind: 'multi', min: 2, closable: true },
  defaults: POLYLINE_DEFAULTS,
  properties: SHAPE_PROPERTIES,

  render({ ctx }, g, s) {
    if (g.points.length < 2) return;
    const closed = isClosedPolyline(g.drawing.points);
    if (closed) return renderPolygon(ctx, vertices(g.points, true), s);
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokePolyline(ctx, g.points);
  },

  hitTest(g, s, x, y, tol) {
    if (g.points.length < 2) return null;
    if (isClosedPolyline(g.drawing.points))
      return hitPolygon(vertices(g.points, true), s, x, y, tol);
    return polylineDistance(g.points, x, y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  handles(g) {
    const pts = vertices(g.points, isClosedPolyline(g.drawing.points));
    return pts.map((p) => ({ x: p.x, y: p.y }));
  },

  moveHandle({ start, handle, target }) {
    const pts = start.map((p) => ({ ...p }));
    if (handle >= pts.length) return pts;
    if (handle === 0 && isClosedPolyline(start)) pts[pts.length - 1] = { ...target };
    pts[handle] = target;
    return pts;
  },

  isVisible(g) {
    return pointsInView(g, g.points);
  },
});
