// Geometry shared by shape, pattern and regression tools (CSS px, pane-local).
// Angles are canvas angles: radians, y down, so positive angles turn clockwise
// on screen.
import { segmentDistance } from '../studies/hit';
import type { DrawingBarData, PixelPoint } from './types';

/** Samples per Bézier curve for distance tests (error well below the hit tolerance). */
const CURVE_STEPS = 48;

/** Distance from (x, y) to the polyline `pts` (closed: plus the last -> first
 * segment). NaN points are skipped; Infinity when no segment is left. */
export function polylineDistance(
  pts: readonly PixelPoint[],
  x: number,
  y: number,
  closed = false,
): number {
  const n = pts.length;
  if (n === 1) return finite(pts[0]!) ? Math.hypot(x - pts[0]!.x, y - pts[0]!.y) : Infinity;
  let best = Infinity;
  const segs = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    if (!finite(a) || !finite(b)) continue;
    best = Math.min(best, segmentDistance(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}

/** Even-odd point-in-polygon test (edges count as inside only by the crossing rule). */
export function pointInPolygon(pts: readonly PixelPoint[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Point at `t` (0..1) of the quadratic Bézier p0 -> p2 with control p1. */
export function quadBezierPoint(
  p0: PixelPoint,
  p1: PixelPoint,
  p2: PixelPoint,
  t: number,
): PixelPoint {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

/** Distance from (x, y) to a quadratic Bézier (sampled polyline). */
export function quadBezierDistance(
  p0: PixelPoint,
  p1: PixelPoint,
  p2: PixelPoint,
  x: number,
  y: number,
): number {
  let best = Infinity;
  let px = p0.x;
  let py = p0.y;
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    const qx = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
    const qy = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
    best = Math.min(best, segmentDistance(x, y, px, py, qx, qy));
    px = qx;
    py = qy;
  }
  return best;
}

/** Distance from (x, y) to a cubic Bézier p0 -> p3 with controls p1, p2 (sampled). */
export function cubicBezierDistance(
  p0: PixelPoint,
  p1: PixelPoint,
  p2: PixelPoint,
  p3: PixelPoint,
  x: number,
  y: number,
): number {
  let best = Infinity;
  let px = p0.x;
  let py = p0.y;
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    const qx = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
    const qy = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
    best = Math.min(best, segmentDistance(x, y, px, py, qx, qy));
    px = qx;
    py = qy;
  }
  return best;
}

/**
 * Distance from (x, y) to the outline of the ellipse centred at (cx, cy) with
 * radii rx, ry, turned by `rotation`. Closest point by a few fixed-point
 * iterations on the parametric angle (exact for circles; < 0.1 px off for
 * typical drawing sizes).
 */
export function ellipseDistance(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  x: number,
  y: number,
  rotation = 0,
): number {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  // Into the ellipse frame, first quadrant (symmetric).
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const dx = x - cx;
  const dy = y - cy;
  const px = Math.abs(dx * cos - dy * sin);
  const py = Math.abs(dx * sin + dy * cos);
  if (rx === ry) return Math.abs(Math.hypot(px, py) - rx);
  if (rx === 0 || ry === 0) {
    // Degenerate: a segment along the non-zero axis.
    return rx === 0 ? Math.hypot(px, Math.max(0, py - ry)) : Math.hypot(Math.max(0, px - rx), py);
  }
  // Evolute iteration (Eberly / "0xfaded"): converges in 3-4 steps.
  let tx = Math.SQRT1_2;
  let ty = Math.SQRT1_2;
  for (let i = 0; i < 4; i++) {
    const ex = ((rx * rx - ry * ry) * tx ** 3) / rx;
    const ey = ((ry * ry - rx * rx) * ty ** 3) / ry;
    const qx = rx * tx - ex;
    const qy = ry * ty - ey;
    const rxp = px - ex;
    const ryp = py - ey;
    const q = Math.hypot(qx, qy);
    const r = Math.hypot(rxp, ryp);
    if (r === 0) break; // on the evolute point: the current estimate stands
    tx = Math.min(1, Math.max(0, ((rxp * q) / r + ex) / rx));
    ty = Math.min(1, Math.max(0, ((ryp * q) / r + ey) / ry));
    const t = Math.hypot(tx, ty);
    tx /= t;
    ty /= t;
  }
  return Math.hypot(px - rx * tx, py - ry * ty);
}

/** Circle through three points, or null when they are (nearly) collinear. */
export function circleThrough3(
  a: PixelPoint,
  b: PixelPoint,
  c: PixelPoint,
): { x: number; y: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

/**
 * Distance from (x, y) to the circular arc of radius r around (cx, cy) that
 * runs from angle `start` to `end` like `ctx.arc(cx, cy, r, start, end,
 * anticlockwise)` (clockwise on screen by default).
 */
export function arcDistance(
  cx: number,
  cy: number,
  r: number,
  start: number,
  end: number,
  x: number,
  y: number,
  anticlockwise = false,
): number {
  const sweep = anticlockwise ? normAngle(start - end) : normAngle(end - start);
  const a = Math.atan2(y - cy, x - cx);
  const along = anticlockwise ? normAngle(start - a) : normAngle(a - start);
  // A full turn (or more) is a circle.
  if (along <= sweep || Math.abs(end - start) >= 2 * Math.PI)
    return Math.abs(Math.hypot(x - cx, y - cy) - r);
  const d0 = Math.hypot(x - (cx + r * Math.cos(start)), y - (cy + r * Math.sin(start)));
  const d1 = Math.hypot(x - (cx + r * Math.cos(end)), y - (cy + r * Math.sin(end)));
  return Math.min(d0, d1);
}

/** `p` turned by `angle` around `center`. */
export function rotate(p: PixelPoint, center: PixelPoint, angle: number): PixelPoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

export interface LinearRegression {
  /** close = slope * index + intercept (index = logical bar index). */
  slope: number;
  intercept: number;
  /** Population standard deviation of the closes around the line. */
  stdev: number;
  /** Pearson correlation of index and close (NaN when the closes are constant). */
  r: number;
  /** Bars used. */
  n: number;
}

/**
 * Least-squares line through the closes of bars [from, to] (whole logical
 * indices, either order, clamped to the data). Non-finite closes are skipped.
 * Null with fewer than 2 bars.
 */
export function linearRegression(
  bars: DrawingBarData,
  from: number,
  to: number,
): LinearRegression | null {
  const lo = Math.max(0, Math.ceil(Math.min(from, to)));
  const hi = Math.min(bars.length - 1, Math.floor(Math.max(from, to)));
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = lo; i <= hi; i++) {
    const c = bars.close[i]!;
    if (!Number.isFinite(c)) continue;
    n++;
    sx += i;
    sy += c;
  }
  if (n < 2) return null;
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = lo; i <= hi; i++) {
    const c = bars.close[i]!;
    if (!Number.isFinite(c)) continue;
    sxx += (i - mx) ** 2;
    sxy += (i - mx) * (c - my);
    syy += (c - my) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = lo; i <= hi; i++) {
    const c = bars.close[i]!;
    if (Number.isFinite(c)) sse += (c - (slope * i + intercept)) ** 2;
  }
  const r = syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  return { slope, intercept, stdev: Math.sqrt(sse / n), r, n };
}

/** Stroke `pts` as one path (closed: back to the first point). NaN points break the line. */
export function strokePolyline(
  ctx: CanvasRenderingContext2D,
  pts: readonly PixelPoint[],
  closed = false,
): void {
  ctx.beginPath();
  tracePolyline(ctx, pts, closed);
  ctx.stroke();
}

/** Add `pts` to the current path (for fills and strokes); NaN points break the line. */
export function tracePolyline(
  ctx: CanvasRenderingContext2D,
  pts: readonly PixelPoint[],
  closed = false,
): void {
  let pen = false;
  for (const p of pts) {
    if (!finite(p)) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    pen = true;
  }
  if (closed && pts.length > 2 && pts.every(finite)) ctx.closePath();
}

function finite(p: PixelPoint): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Angle in [0, 2π). */
function normAngle(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}
