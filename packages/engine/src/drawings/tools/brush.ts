import { BODY_HIT, lineDistance, setLineStyle, WEAK_BODY_HIT } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type {
  DrawingGeometry,
  DrawingHandle,
  DrawingPoint,
  HandleMoveArgs,
  PixelPoint,
} from '../types';

export const BRUSH_DEFAULTS = {
  lineColor: '#2962ff',
  lineWidth: 2,
  /** Moving-average radius in samples (0 = raw path). */
  smoothing: 5,
  fillBackground: false,
  backgroundColor: 'rgba(41, 98, 255, 0.2)',
};

type BrushStyle = typeof BRUSH_DEFAULTS;

// Smoothed path buffers, grown on demand and reused across frames.
let sx = new Float64Array(256);
let sy = new Float64Array(256);

/**
 * Moving average of the pixel path with radius `r` (endpoints kept) into the
 * shared buffers. Returns the point count.
 */
export function smoothPath(points: readonly PixelPoint[], r: number): number {
  const n = points.length;
  if (sx.length < n) {
    sx = new Float64Array(n * 2);
    sy = new Float64Array(n * 2);
  }
  const rad = Math.max(0, Math.min(Math.floor(r), 50));
  for (let i = 0; i < n; i++) {
    const k = Math.min(rad, i, n - 1 - i);
    let x = 0;
    let y = 0;
    for (let j = i - k; j <= i + k; j++) {
      x += points[j]!.x;
      y += points[j]!.y;
    }
    sx[i] = x / (2 * k + 1);
    sy[i] = y / (2 * k + 1);
  }
  return n;
}

const bbox = { l: 0, t: 0, r: 0, b: 0 };

/** Bounding box of the raw samples in px (shared buffer). */
export function strokeBounds(g: DrawingGeometry): typeof bbox {
  bbox.l = bbox.t = Infinity;
  bbox.r = bbox.b = -Infinity;
  for (const p of g.points) {
    if (p.x < bbox.l) bbox.l = p.x;
    if (p.x > bbox.r) bbox.r = p.x;
    if (p.y < bbox.t) bbox.t = p.y;
    if (p.y > bbox.b) bbox.b = p.y;
  }
  return bbox;
}

/** Path through the `n` samples last smoothed by `smoothPath` (quadratic curves through midpoints). */
export function tracePath(ctx: CanvasRenderingContext2D, n: number): void {
  ctx.moveTo(sx[0]!, sy[0]!);
  if (n === 2) {
    ctx.lineTo(sx[1]!, sy[1]!);
    return;
  }
  for (let i = 1; i < n - 1; i++)
    ctx.quadraticCurveTo(sx[i]!, sy[i]!, (sx[i]! + sx[i + 1]!) / 2, (sy[i]! + sy[i + 1]!) / 2);
  ctx.lineTo(sx[n - 1]!, sy[n - 1]!);
}

/** Even-odd point-in-polygon on the smoothed samples (closed path). */
function insidePath(n: number, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = sx[i]!;
    const yi = sy[i]!;
    const xj = sx[j]!;
    const yj = sy[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether (x, y) is within `t` px of the path smoothed with radius `smoothing`. */
export function nearStroke(
  g: DrawingGeometry,
  smoothing: number,
  x: number,
  y: number,
  t: number,
): boolean {
  const b = strokeBounds(g);
  if (x < b.l - t || x > b.r + t || y < b.t - t || y > b.b + t) return false;
  const n = smoothPath(g.points, smoothing);
  for (let i = 1; i < n; i++)
    if (lineDistance(x, y, sx[i - 1]!, sy[i - 1]!, sx[i]!, sy[i]!) <= t) return true;
  return false;
}

/** Freehand culling: the raw samples' box (plus 20 px) overlaps the pane. */
export function strokeInView(g: DrawingGeometry): boolean {
  const b = strokeBounds(g);
  return b.r >= -20 && b.l <= g.width + 20 && b.b >= -20 && b.t <= g.height + 20;
}

/** Freehand handles: first and last sample. */
export function strokeHandles(g: DrawingGeometry): DrawingHandle[] {
  const n = g.points.length;
  const a = g.points[0];
  const b = g.points[n - 1];
  return a && b && n > 1
    ? [
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
      ]
    : [];
}

/**
 * End handles stretch the stroke: the dragged end follows the pointer, the
 * other end stays, and samples in between move by the same offset scaled by
 * their path length from the fixed end (time linearly, price in pixels so
 * log scales keep the shape).
 */
export function stretchStroke({
  start,
  handle,
  target,
  geometry: g,
}: HandleMoveArgs): DrawingPoint[] {
  const n = start.length;
  const pts = start.map((p) => ({ ...p }));
  if (!n) return pts;
  const end = handle === 0 ? 0 : n - 1;
  if (n === 1) return [target];
  const px = start.map((p) => g.toPixel(p));
  const weights = new Array<number>(n).fill(0);
  let total = 0;
  // Path length from the fixed end (n-1 when dragging 0, else 0).
  const order = end === 0 ? [...px.keys()].reverse() : [...px.keys()];
  for (let k = 1; k < n; k++) {
    const i = order[k]!;
    const j = order[k - 1]!;
    const d = Math.hypot(px[i]!.x - px[j]!.x, px[i]!.y - px[j]!.y);
    total += Number.isFinite(d) ? d : 0;
    weights[i] = total;
  }
  const dt = target.time - start[end]!.time;
  const dy = g.priceToY(target.price) - px[end]!.y;
  for (let i = 0; i < n; i++) {
    const w = total > 0 ? weights[i]! / total : i === end ? 1 : 0;
    const p = pts[i]!;
    p.time = Math.round(p.time + dt * w);
    p.price = g.yToPrice(px[i]!.y + dy * w);
  }
  pts[end] = target;
  return pts;
}

/** Freehand stroke; optional closed fill. Handles: first and last sample. */
export const brush = defineDrawingTool({
  type: 'brush',
  name: 'Brush',
  group: 'shapes',
  creation: { kind: 'freehand' },
  defaults: BRUSH_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'number', key: 'smoothing', label: 'Smooth', min: 0, max: 20, step: 1 },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
  ],

  render({ ctx }, g, s: BrushStyle) {
    const n = smoothPath(g.points, s.smoothing);
    if (n < 2) return;
    if (s.fillBackground && n > 2) {
      ctx.fillStyle = s.backgroundColor;
      ctx.beginPath();
      tracePath(ctx, n);
      ctx.closePath();
      ctx.fill();
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, 'solid');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    tracePath(ctx, n);
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    if (nearStroke(g, s.smoothing, x, y, tol + s.lineWidth / 2)) return BODY_HIT;
    const n = smoothPath(g.points, s.smoothing);
    return s.fillBackground && n > 2 && insidePath(n, x, y) ? WEAK_BODY_HIT : null;
  },

  handles(g) {
    return strokeHandles(g);
  },

  moveHandle(args) {
    return stretchStroke(args);
  },

  priceAxisLabels() {
    return [];
  },

  timeAxisLabels() {
    return [];
  },

  isVisible(g) {
    return strokeInView(g);
  },
});
