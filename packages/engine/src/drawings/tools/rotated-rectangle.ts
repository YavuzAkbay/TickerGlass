import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingHandle, PixelPoint } from '../types';
import {
  hitPolygon,
  pointsInView,
  renderPolygon,
  SHAPE_PROPERTIES,
  shapeDefaults,
} from './shape-common';

export const ROTATED_RECTANGLE_DEFAULTS = shapeDefaults('#8e5cf6', 'rgba(142, 92, 246, 0.2)');

const corners: PixelPoint[] = Array.from({ length: 4 }, () => ({ x: 0, y: 0 }));

/**
 * Rectangle around the axis a -> b whose half width is the distance of `c`
 * from the axis line (px). Null for a zero-length axis.
 */
export function rotatedRectFrame(
  a: PixelPoint,
  b: PixelPoint,
  c: PixelPoint | undefined,
): { nx: number; ny: number; half: number } | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return null;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  const half = c ? Math.abs((c.x - a.x) * nx + (c.y - a.y) * ny) : 0;
  return Number.isFinite(half) ? { nx, ny, half } : null;
}

/** Corners a+n·h, b+n·h, b-n·h, a-n·h (shared buffer); [a, b] for a zero-length axis. */
export function rotatedRectCorners(g: DrawingGeometry): PixelPoint[] {
  const [a, b, c] = g.points;
  if (!a) return [];
  if (!b) return [a];
  const f = rotatedRectFrame(a, b, c);
  if (!f) return [a, b];
  const { nx, ny, half } = f;
  corners[0]!.x = a.x + nx * half;
  corners[0]!.y = a.y + ny * half;
  corners[1]!.x = b.x + nx * half;
  corners[1]!.y = b.y + ny * half;
  corners[2]!.x = b.x - nx * half;
  corners[2]!.y = b.y - ny * half;
  corners[3]!.x = a.x - nx * half;
  corners[3]!.y = a.y - ny * half;
  return corners;
}

/**
 * Rectangle at any angle: anchors 0 -> 1 are the centre axis (midpoints of two
 * opposite sides), anchor 2's distance from the axis line is the half width
 * (px, symmetric). Handles: 0/1 the axis ends (keep the width), 2/3 the long
 * side midpoints (set the width).
 */
export const rotatedRectangle = defineDrawingTool({
  type: 'rotated-rectangle',
  name: 'Rotated rectangle',
  group: 'shapes',
  creation: { kind: 'points', count: 3 },
  defaults: ROTATED_RECTANGLE_DEFAULTS,
  properties: SHAPE_PROPERTIES,

  render({ ctx }, g, s) {
    renderPolygon(ctx, rotatedRectCorners(g), s);
  },

  hitTest(g, s, x, y, tol) {
    return hitPolygon(rotatedRectCorners(g), s, x, y, tol);
  },

  handles(g) {
    const [a, b, c] = g.points;
    if (!a || !b) return a ? [{ x: a.x, y: a.y }] : [];
    const hs: DrawingHandle[] = [
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ];
    const f = rotatedRectFrame(a, b, c);
    if (!c || !f) return hs;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    hs.push(
      { x: mx + f.nx * f.half, y: my + f.ny * f.half },
      { x: mx - f.nx * f.half, y: my - f.ny * f.half },
    );
    return hs;
  },

  moveHandle({ start, handle, target, geometry: g }) {
    const pts = start.map((p) => ({ ...p }));
    if (start.length < 3) {
      if (handle < pts.length) pts[handle] = target;
      return pts;
    }
    if (handle >= 2) {
      pts[2] = target;
      return pts;
    }
    // Axis end: move it and put anchor 2 back on the new axis' normal through
    // its midpoint at the old half width (x snaps to a bar slot).
    const px = start.map((p) => g.toPixel(p));
    const f = rotatedRectFrame(px[0]!, px[1]!, px[2]!);
    pts[handle] = target;
    const a = g.toPixel(pts[0]!);
    const b = g.toPixel(pts[1]!);
    const nf = rotatedRectFrame(a, b, undefined);
    if (!f || !nf) return pts;
    // Keep anchor 2 on the same side of the axis.
    const side =
      (px[2]!.x - px[0]!.x) * f.nx + (px[2]!.y - px[0]!.y) * f.ny >= 0 ? f.half : -f.half;
    pts[2] = g.toPoint((a.x + b.x) / 2 + nf.nx * side, (a.y + b.y) / 2 + nf.ny * side);
    return pts;
  },

  isVisible(g) {
    return pointsInView(g, rotatedRectCorners(g));
  },
});
