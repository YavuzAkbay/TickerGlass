// Shared fan (rays from one origin, fills between consecutive rays) and box
// grid code: fib fan, Gann fan/box. Pixel space (CSS px,
// pane-local): rays stay straight on every price scale.
import { BODY_HIT, lineDistance, segmentInView, setLineStyle, WEAK_BODY_HIT } from '../draw-utils';
import { pointInPolygon } from '../shape-utils';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingLevel,
  DrawingLineStyle,
  PixelPoint,
} from '../types';
import { fillAlpha } from './fib-common';

/** Segment start (0,1) and end (2,3) in px. */
export type Seg = [number, number, number, number];

/**
 * One fan ray: from the origin through the target (tx, ty), long enough to
 * cross the pane. `fill`: colour of the band between the previous ray in the
 * list and this one ('' or absent = not filled).
 */
export interface FanRay {
  tx: number;
  ty: number;
  color: string;
  fill?: string;
}

/** Style keys the fan helpers read. */
export interface FanStyle {
  levelsLineWidth: number;
  levelsLineStyle: DrawingLineStyle;
  fillBackground: boolean;
  backgroundTransparency: number;
}

/**
 * Ray from (ox, oy) through (tx, ty), scaled so its end lies past the pane
 * (never shorter than the origin-target segment). Null when the target
 * coincides with the origin or is not finite.
 */
export function rayToEdge(
  g: DrawingGeometry,
  ox: number,
  oy: number,
  tx: number,
  ty: number,
  out: Seg,
): Seg | null {
  const dx = tx - ox;
  const dy = ty - oy;
  const len = Math.hypot(dx, dy);
  if (!(len >= 1e-9) || !Number.isFinite(ox) || !Number.isFinite(oy)) return null;
  const reach = Math.hypot(g.width, g.height) + Math.hypot(ox - g.width / 2, oy - g.height / 2);
  const k = Math.max(1, reach / len);
  out[0] = ox;
  out[1] = oy;
  out[2] = ox + dx * k;
  out[3] = oy + dy * k;
  return out;
}

const segA: Seg = [0, 0, 0, 0];
const segB: Seg = [0, 0, 0, 0];
const tri: PixelPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

function setTri(o: PixelPoint, a: Seg, b: Seg): PixelPoint[] {
  tri[0]!.x = o.x;
  tri[0]!.y = o.y;
  tri[1]!.x = a[2];
  tri[1]!.y = a[3];
  tri[2]!.x = b[2];
  tri[2]!.y = b[3];
  return tri;
}

/** Draw the band fills (when enabled), then every ray in its colour. */
export function renderFan(
  ctx: CanvasRenderingContext2D,
  g: DrawingGeometry,
  origin: PixelPoint,
  rays: readonly FanRay[],
  s: FanStyle,
): void {
  if (s.fillBackground && s.backgroundTransparency < 100) {
    ctx.globalAlpha = fillAlpha(s.backgroundTransparency);
    for (let i = 1; i < rays.length; i++) {
      const r = rays[i]!;
      if (!r.fill) continue;
      const p = rays[i - 1]!;
      const a = rayToEdge(g, origin.x, origin.y, p.tx, p.ty, segA);
      const b = rayToEdge(g, origin.x, origin.y, r.tx, r.ty, segB);
      if (!a || !b) continue;
      ctx.fillStyle = r.fill;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(a[2], a[3]);
      ctx.lineTo(b[2], b[3]);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  for (const r of rays) {
    const seg = rayToEdge(g, origin.x, origin.y, r.tx, r.ty, segA);
    if (!seg) continue;
    setLineStyle(ctx, r.color, s.levelsLineWidth, s.levelsLineStyle);
    ctx.beginPath();
    ctx.moveTo(seg[0], seg[1]);
    ctx.lineTo(seg[2], seg[3]);
    ctx.stroke();
  }
}

/** Rays are strong hits; a filled band is weak. */
export function hitFan(
  g: DrawingGeometry,
  origin: PixelPoint,
  rays: readonly FanRay[],
  s: FanStyle,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  const t = tol + s.levelsLineWidth / 2;
  for (const r of rays) {
    const seg = rayToEdge(g, origin.x, origin.y, r.tx, r.ty, segA);
    if (seg && lineDistance(x, y, seg[0], seg[1], seg[2], seg[3]) <= t) return BODY_HIT;
  }
  if (!s.fillBackground) return null;
  for (let i = 1; i < rays.length; i++) {
    const r = rays[i]!;
    if (!r.fill) continue;
    const p = rays[i - 1]!;
    const a = rayToEdge(g, origin.x, origin.y, p.tx, p.ty, segA);
    const b = rayToEdge(g, origin.x, origin.y, r.tx, r.ty, segB);
    if (a && b && pointInPolygon(setTri(origin, a, b), x, y)) return WEAK_BODY_HIT;
  }
  return null;
}

/** Culling: a ray crosses the pane, or a filled band covers its centre. */
export function fanInView(
  g: DrawingGeometry,
  origin: PixelPoint,
  rays: readonly FanRay[],
  s: FanStyle,
): boolean {
  const W = g.width;
  const H = g.height;
  for (const r of rays) {
    const seg = rayToEdge(g, origin.x, origin.y, r.tx, r.ty, segA);
    if (seg && segmentInView(seg[0], seg[1], seg[2], seg[3], false, false, W, H)) return true;
  }
  if (!s.fillBackground) return false;
  for (let i = 1; i < rays.length; i++) {
    const r = rays[i]!;
    if (!r.fill) continue;
    const p = rays[i - 1]!;
    const a = rayToEdge(g, origin.x, origin.y, p.tx, p.ty, segA);
    const b = rayToEdge(g, origin.x, origin.y, r.tx, r.ty, segB);
    if (a && b && pointInPolygon(setTri(origin, a, b), W / 2, H / 2)) return true;
  }
  return false;
}

/** Reusable `FanRay` list: `fanRayBuffer(n)` returns `n` entries (contents stale). */
const rayPool: FanRay[] = [];
const rayView: FanRay[] = [];

export function fanRayBuffer(n: number): FanRay[] {
  while (rayPool.length < n) rayPool.push({ tx: 0, ty: 0, color: '', fill: '' });
  rayView.length = 0;
  for (let i = 0; i < n; i++) rayView.push(rayPool[i]!);
  return rayView;
}

// ------------------------------------------------------------ box grid

/**
 * Grid inside the box a-b: vertical lines at x = a.x + v * (b.x - a.x) for
 * `xLevels` (spanning a.y..b.y) and horizontal lines at y = a.y + v * (b.y -
 * a.y) for `yLevels` (spanning a.x..b.x). Only visible, finite levels.
 * `color`: one colour for every line (else each level's own colour).
 */
export function renderBoxGrid(
  ctx: CanvasRenderingContext2D,
  a: PixelPoint,
  b: PixelPoint,
  xLevels: readonly DrawingLevel[],
  yLevels: readonly DrawingLevel[],
  lineWidth: number,
  lineStyle: DrawingLineStyle,
  color?: string,
): void {
  for (const lv of xLevels) {
    if (!lv.visible || !Number.isFinite(lv.value)) continue;
    const x = a.x + lv.value * (b.x - a.x);
    setLineStyle(ctx, color ?? lv.color, lineWidth, lineStyle);
    ctx.beginPath();
    ctx.moveTo(x, a.y);
    ctx.lineTo(x, b.y);
    ctx.stroke();
  }
  for (const lv of yLevels) {
    if (!lv.visible || !Number.isFinite(lv.value)) continue;
    const y = a.y + lv.value * (b.y - a.y);
    setLineStyle(ctx, color ?? lv.color, lineWidth, lineStyle);
    ctx.beginPath();
    ctx.moveTo(a.x, y);
    ctx.lineTo(b.x, y);
    ctx.stroke();
  }
}

/** Whether (x, y) is within `tol` of a grid line of `renderBoxGrid`. */
export function hitBoxGrid(
  a: PixelPoint,
  b: PixelPoint,
  xLevels: readonly DrawingLevel[],
  yLevels: readonly DrawingLevel[],
  lineWidth: number,
  x: number,
  y: number,
  tol: number,
): boolean {
  const t = tol + lineWidth / 2;
  for (const lv of xLevels) {
    if (!lv.visible || !Number.isFinite(lv.value)) continue;
    const lx = a.x + lv.value * (b.x - a.x);
    if (lineDistance(x, y, lx, a.y, lx, b.y) <= t) return true;
  }
  for (const lv of yLevels) {
    if (!lv.visible || !Number.isFinite(lv.value)) continue;
    const ly = a.y + lv.value * (b.y - a.y);
    if (lineDistance(x, y, a.x, ly, b.x, ly) <= t) return true;
  }
  return false;
}
