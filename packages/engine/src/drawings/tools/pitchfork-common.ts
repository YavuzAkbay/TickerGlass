// Shared geometry, levels and rendering for the pitchfork family (Andrews,
// Schiff, Modified Schiff, Inside) and the fork fan. Pixel space (CSS px,
// pane-local), like the parallel channel: lines stay parallel on screen on
// every price scale.
import {
  anchorsInView,
  BODY_HIT,
  lineDistance,
  segmentInView,
  setLineStyle,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { pointInPolygon } from '../shape-utils';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingLevel,
  DrawingLineStyle,
  DrawingProperty,
  PixelPoint,
} from '../types';
import { levelsOf } from './fib-common';

export type PitchforkVariant = 'original' | 'schiff' | 'modified-schiff' | 'inside';

/** default pitchfork/fork fan levels: [value, colour, visible]. */
const TV_LEVELS: readonly (readonly [number, string, boolean])[] = [
  [0.25, '#ffb74d', false],
  [0.382, '#81c784', false],
  [0.5, '#089981', true],
  [0.618, '#089981', false],
  [0.75, '#00bcd4', false],
  [1, '#2962ff', true],
  [1.5, '#9c27b0', false],
  [1.75, '#e91e63', false],
  [2, '#f23645', false],
];

/** Fresh copy of the default pitchfork levels (sorted by value). */
export function defaultPitchforkLevels(): DrawingLevel[] {
  return TV_LEVELS.map(([value, color, visible]) => ({ value, color, visible }));
}

/** Style keys shared by the pitchforks and the fork fan. */
export const PITCHFORK_COMMON_DEFAULTS = {
  /** Median line; also the handle colour. */
  lineColor: '#f23645',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  fillBackground: true,
  /** 0 = opaque, 100 = invisible. */
  backgroundTransparency: 80,
};

export type PitchforkCommonStyle = typeof PITCHFORK_COMMON_DEFAULTS & { levels: DrawingLevel[] };

export const PITCHFORK_COMMON_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'color', key: 'lineColor', label: 'Median', inline: 'median' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'median' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'median' },
  { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Levels line', inline: 'levelsLine' },
  { kind: 'lineStyle', key: 'levelsLineStyle', label: 'Style', inline: 'levelsLine' },
  { kind: 'levels', key: 'levels', label: 'Levels', group: 'Levels' },
  { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
  {
    kind: 'number',
    key: 'backgroundTransparency',
    label: 'Transparency',
    inline: 'bg',
    min: 0,
    max: 100,
    step: 1,
  },
];

/**
 * Pitchfork construction from anchors p1, p2, p3 (pixels):
 * - `mid`: midpoint of p2-p3, where the median tine starts;
 * - `half`: (p3 - p2) / 2, so level c's tine starts at mid ± c * half (level 1 at p2/p3);
 * - `dir`: tine direction and length (every tine runs from its start to start + dir);
 * - `handle0`-`handle1`: the handle segment drawn in the median style.
 *
 * Original: median from p1 through mid. Schiff: origin (p1.x, (p1.y + p2.y) / 2).
 * Modified Schiff: origin at the midpoint of p1-p2. Inside: origin at the
 * midpoint m of p1-p2, the handle runs m -> p3 and the tines are parallel to it
 * (median from mid along p3 - m).
 */
export interface PitchforkGeometry {
  mid: PixelPoint;
  half: PixelPoint;
  dir: PixelPoint;
  handle0: PixelPoint;
  handle1: PixelPoint;
}

/** Fork of anchors p1, p2, p3 (pixels), or null when the median has no length. */
export function pitchforkGeometry(
  variant: PitchforkVariant,
  p1: PixelPoint,
  p2: PixelPoint,
  p3: PixelPoint,
): PitchforkGeometry | null {
  const mid = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
  const half = { x: (p3.x - p2.x) / 2, y: (p3.y - p2.y) / 2 };
  let origin: PixelPoint;
  let handle1 = mid;
  switch (variant) {
    case 'schiff':
      origin = { x: p1.x, y: (p1.y + p2.y) / 2 };
      break;
    case 'modified-schiff':
      origin = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      break;
    case 'inside':
      origin = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      handle1 = p3;
      break;
    default:
      origin = p1;
  }
  const dir = { x: handle1.x - origin.x, y: handle1.y - origin.y };
  if (![mid.x, mid.y, dir.x, dir.y].every(Number.isFinite) || Math.hypot(dir.x, dir.y) < 1e-6)
    return null;
  return { mid, half, dir, handle0: origin, handle1 };
}

/** Visible level values, ascending (shared buffer). */
const visible: DrawingLevel[] = [];

function visibleLevels(s: { levels: unknown }): readonly DrawingLevel[] {
  visible.length = 0;
  for (const lv of levelsOf(s)) if (lv.visible && Number.isFinite(lv.value)) visible.push(lv);
  visible.sort((a, b) => a.value - b.value);
  return visible;
}

/** Scale so a line of length `len` starting at `p` reaches past the pane (min 1). */
function farScale(g: DrawingGeometry, p: PixelPoint, len: number): number {
  if (len < 1e-9) return 1;
  const reach = Math.hypot(g.width, g.height) + Math.hypot(p.x - g.width / 2, p.y - g.height / 2);
  return Math.max(1, reach / len);
}

/** Tine (or ray) of one level: start (0,1) and end (2,3) in px. */
type Seg = [number, number, number, number];

/** Opacity of a fill from `backgroundTransparency` (0..100). */
function fillAlpha(s: PitchforkCommonStyle): number {
  return Math.max(0, Math.min(1, 1 - s.backgroundTransparency / 100));
}

function strokeLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function fillQuad(ctx: CanvasRenderingContext2D, a: Seg, b: Seg): void {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(a[2], a[3]);
  ctx.lineTo(b[2], b[3]);
  ctx.lineTo(b[0], b[1]);
  ctx.closePath();
  ctx.fill();
}

// ------------------------------------------------------------ pitchfork

/** Tine of level `c` (signed; 0 = median): start at mid + c * half, `k` times `dir` long. */
function tine(f: PitchforkGeometry, c: number, k: number, out: Seg): Seg {
  out[0] = f.mid.x + c * f.half.x;
  out[1] = f.mid.y + c * f.half.y;
  out[2] = out[0] + f.dir.x * k;
  out[3] = out[1] + f.dir.y * k;
  return out;
}

/** Tine length factor: 1, or long enough to cross the pane when extended. */
function tineScale(g: DrawingGeometry, f: PitchforkGeometry, extend: boolean, maxC: number) {
  if (!extend) return 1;
  const len = Math.hypot(f.dir.x, f.dir.y);
  return farScale(g, f.mid, len) + (maxC * Math.hypot(f.half.x, f.half.y)) / Math.max(len, 1e-9);
}

const segA: Seg = [0, 0, 0, 0];
const segB: Seg = [0, 0, 0, 0];

/** Fork of the drawing's first three anchors, or null. */
export function forkOf(g: DrawingGeometry, variant: PitchforkVariant): PitchforkGeometry | null {
  const [p1, p2, p3] = g.points;
  if (!p1 || !p2 || !p3) return null;
  return pitchforkGeometry(variant, p1, p2, p3);
}

/**
 * Draw a pitchfork: fills between consecutive visible levels (median to the
 * first level included; colour of the outer level), the base segment through
 * the tine starts, level tines, the handle and the median. With two anchors
 * (draft) only the first leg p1-p2.
 */
export function renderPitchfork(
  ctx: CanvasRenderingContext2D,
  g: DrawingGeometry,
  s: PitchforkCommonStyle,
  variant: PitchforkVariant,
  extend: boolean,
): void {
  const [p1, p2] = g.points;
  if (!p1 || !p2) return;
  const f = forkOf(g, variant);
  if (!f) {
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    strokeLine(ctx, p1.x, p1.y, p2.x, p2.y);
    return;
  }
  const levels = visibleLevels(s);
  const maxC = levels.length ? Math.abs(levels[levels.length - 1]!.value) : 0;
  const k = tineScale(g, f, extend, maxC);
  if (s.fillBackground && s.backgroundTransparency < 100 && levels.length) {
    ctx.globalAlpha = fillAlpha(s);
    for (const side of [1, -1]) {
      let prev = 0;
      for (const lv of levels) {
        ctx.fillStyle = lv.color;
        fillQuad(ctx, tine(f, side * prev, k, segA), tine(f, side * lv.value, k, segB));
        prev = lv.value;
      }
    }
    ctx.globalAlpha = 1;
  }
  if (levels.length) {
    // Base: through the tine starts (p2-p3 when level 1 is the outermost).
    setLineStyle(ctx, s.lineColor, s.levelsLineWidth, s.levelsLineStyle);
    strokeLine(
      ctx,
      f.mid.x - maxC * f.half.x,
      f.mid.y - maxC * f.half.y,
      f.mid.x + maxC * f.half.x,
      f.mid.y + maxC * f.half.y,
    );
  }
  for (const lv of levels) {
    setLineStyle(ctx, lv.color, s.levelsLineWidth, s.levelsLineStyle);
    for (const side of [1, -1]) {
      tine(f, side * lv.value, k, segA);
      strokeLine(ctx, segA[0], segA[1], segA[2], segA[3]);
    }
  }
  setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
  strokeLine(ctx, f.handle0.x, f.handle0.y, f.handle1.x, f.handle1.y);
  tine(f, 0, k, segA);
  strokeLine(ctx, segA[0], segA[1], segA[2], segA[3]);
}

const quad: PixelPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

function setQuad(a: Seg, b: Seg): PixelPoint[] {
  quad[0]!.x = a[0];
  quad[0]!.y = a[1];
  quad[1]!.x = a[2];
  quad[1]!.y = a[3];
  quad[2]!.x = b[2];
  quad[2]!.y = b[3];
  quad[3]!.x = b[0];
  quad[3]!.y = b[1];
  return quad;
}

/** Median, handle, tines and base are strong hits; the band between the outer tines is weak. */
export function hitPitchfork(
  g: DrawingGeometry,
  s: PitchforkCommonStyle,
  variant: PitchforkVariant,
  extend: boolean,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  const [p1, p2] = g.points;
  if (!p1 || !p2) return null;
  const mt = tol + s.lineWidth / 2;
  const f = forkOf(g, variant);
  if (!f) return lineDistance(x, y, p1.x, p1.y, p2.x, p2.y) <= mt ? BODY_HIT : null;
  const levels = visibleLevels(s);
  const maxC = levels.length ? Math.abs(levels[levels.length - 1]!.value) : 0;
  const k = tineScale(g, f, extend, maxC);
  if (lineDistance(x, y, f.handle0.x, f.handle0.y, f.handle1.x, f.handle1.y) <= mt) return BODY_HIT;
  tine(f, 0, k, segA);
  if (lineDistance(x, y, segA[0], segA[1], segA[2], segA[3]) <= mt) return BODY_HIT;
  if (!levels.length) return null;
  const lt = tol + s.levelsLineWidth / 2;
  const bx = maxC * f.half.x;
  const by = maxC * f.half.y;
  if (lineDistance(x, y, f.mid.x - bx, f.mid.y - by, f.mid.x + bx, f.mid.y + by) <= lt)
    return BODY_HIT;
  for (const lv of levels)
    for (const side of [1, -1]) {
      tine(f, side * lv.value, k, segA);
      if (lineDistance(x, y, segA[0], segA[1], segA[2], segA[3]) <= lt) return BODY_HIT;
    }
  if (!s.fillBackground) return null;
  tine(f, -maxC, k, segA);
  tine(f, maxC, k, segB);
  return pointInPolygon(setQuad(segA, segB), x, y) ? WEAK_BODY_HIT : null;
}

/** Culling: a tine, the median or the handle crosses the pane, or the band covers it. */
export function pitchforkInView(
  g: DrawingGeometry,
  s: PitchforkCommonStyle,
  variant: PitchforkVariant,
  extend: boolean,
): boolean {
  const f = forkOf(g, variant);
  if (!f) return anchorsInView(g);
  const W = g.width;
  const H = g.height;
  if (segmentInView(f.handle0.x, f.handle0.y, f.handle1.x, f.handle1.y, false, false, W, H))
    return true;
  const levels = visibleLevels(s);
  const maxC = levels.length ? Math.abs(levels[levels.length - 1]!.value) : 0;
  const k = tineScale(g, f, extend, maxC);
  for (const c of [0, maxC, -maxC]) {
    tine(f, c, k, segA);
    if (segmentInView(segA[0], segA[1], segA[2], segA[3], false, false, W, H)) return true;
  }
  if (!s.fillBackground || !levels.length) return false;
  tine(f, -maxC, k, segA);
  tine(f, maxC, k, segB);
  return pointInPolygon(setQuad(segA, segB), W / 2, H / 2);
}

// ------------------------------------------------------------ fork fan

/**
 * Fork fan ray of level `c` (signed; 0 = median): from p1 through the point
 * mid + c * half on line p2-p3, long enough to cross the pane. Null when the
 * point coincides with p1.
 */
export function fanRay(
  g: DrawingGeometry,
  p1: PixelPoint,
  f: PitchforkGeometry,
  c: number,
  out: Seg,
): Seg | null {
  const tx = f.mid.x + c * f.half.x;
  const ty = f.mid.y + c * f.half.y;
  const dx = tx - p1.x;
  const dy = ty - p1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const k = farScale(g, p1, len);
  out[0] = p1.x;
  out[1] = p1.y;
  out[2] = p1.x + dx * k;
  out[3] = p1.y + dy * k;
  return out;
}

function fanTriangle(ctx: CanvasRenderingContext2D, a: Seg, b: Seg): void {
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(a[2], a[3]);
  ctx.lineTo(b[2], b[3]);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draw a fork fan: rays from p1 through the median point and the level
 * points on p2-p3, fills between consecutive rays, and the p2-p3 segment.
 * With two anchors (draft) only p1-p2.
 */
export function renderForkFan(
  ctx: CanvasRenderingContext2D,
  g: DrawingGeometry,
  s: PitchforkCommonStyle,
): void {
  const [p1, p2] = g.points;
  if (!p1 || !p2) return;
  const f = forkOf(g, 'original');
  if (!f) {
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    strokeLine(ctx, p1.x, p1.y, p2.x, p2.y);
    return;
  }
  const levels = visibleLevels(s);
  if (s.fillBackground && s.backgroundTransparency < 100) {
    ctx.globalAlpha = fillAlpha(s);
    for (const side of [1, -1]) {
      let prev = 0;
      for (const lv of levels) {
        const a = fanRay(g, p1, f, side * prev, segA);
        const b = fanRay(g, p1, f, side * lv.value, segB);
        prev = lv.value;
        if (!a || !b) continue;
        ctx.fillStyle = lv.color;
        fanTriangle(ctx, a, b);
      }
    }
    ctx.globalAlpha = 1;
  }
  const [, q2, q3] = g.points;
  setLineStyle(ctx, s.lineColor, s.levelsLineWidth, s.levelsLineStyle);
  strokeLine(ctx, q2!.x, q2!.y, q3!.x, q3!.y);
  for (const lv of levels) {
    setLineStyle(ctx, lv.color, s.levelsLineWidth, s.levelsLineStyle);
    for (const side of [1, -1]) {
      const r = fanRay(g, p1, f, side * lv.value, segA);
      if (r) strokeLine(ctx, r[0], r[1], r[2], r[3]);
    }
  }
  setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
  const m = fanRay(g, p1, f, 0, segA);
  if (m) strokeLine(ctx, m[0], m[1], m[2], m[3]);
}

const tri: PixelPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

/** Rays and p2-p3 are strong hits; the wedge between the outer rays is weak. */
export function hitForkFan(
  g: DrawingGeometry,
  s: PitchforkCommonStyle,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  const [p1, p2, p3] = g.points;
  if (!p1 || !p2) return null;
  const mt = tol + s.lineWidth / 2;
  const f = forkOf(g, 'original');
  if (!f || !p3) return lineDistance(x, y, p1.x, p1.y, p2.x, p2.y) <= mt ? BODY_HIT : null;
  const m = fanRay(g, p1, f, 0, segA);
  if (m && lineDistance(x, y, m[0], m[1], m[2], m[3]) <= mt) return BODY_HIT;
  const lt = tol + s.levelsLineWidth / 2;
  if (lineDistance(x, y, p2.x, p2.y, p3.x, p3.y) <= lt) return BODY_HIT;
  const levels = visibleLevels(s);
  for (const lv of levels)
    for (const side of [1, -1]) {
      const r = fanRay(g, p1, f, side * lv.value, segA);
      if (r && lineDistance(x, y, r[0], r[1], r[2], r[3]) <= lt) return BODY_HIT;
    }
  if (!s.fillBackground || !levels.length) return null;
  const maxC = levels[levels.length - 1]!.value;
  const a = fanRay(g, p1, f, -maxC, segA);
  const b = fanRay(g, p1, f, maxC, segB);
  if (!a || !b) return null;
  tri[0]!.x = p1.x;
  tri[0]!.y = p1.y;
  tri[1]!.x = a[2];
  tri[1]!.y = a[3];
  tri[2]!.x = b[2];
  tri[2]!.y = b[3];
  return pointInPolygon(tri, x, y) ? WEAK_BODY_HIT : null;
}

/** Culling: a ray crosses the pane, p2-p3 is in view, or the wedge covers it. */
export function forkFanInView(g: DrawingGeometry, s: PitchforkCommonStyle): boolean {
  const [p1, p2, p3] = g.points;
  const f = forkOf(g, 'original');
  if (!f || !p1 || !p2 || !p3) return anchorsInView(g);
  const W = g.width;
  const H = g.height;
  if (segmentInView(p2.x, p2.y, p3.x, p3.y, false, false, W, H)) return true;
  const levels = visibleLevels(s);
  const maxC = levels.length ? levels[levels.length - 1]!.value : 0;
  for (const c of [0, maxC, -maxC]) {
    const r = fanRay(g, p1, f, c, segA);
    if (r && segmentInView(r[0], r[1], r[2], r[3], false, false, W, H)) return true;
  }
  if (!s.fillBackground || !levels.length) return false;
  const a = fanRay(g, p1, f, -maxC, segA);
  const b = fanRay(g, p1, f, maxC, segB);
  if (!a || !b) return false;
  tri[0]!.x = p1.x;
  tri[0]!.y = p1.y;
  tri[1]!.x = a[2];
  tri[1]!.y = a[3];
  tri[2]!.x = b[2];
  tri[2]!.y = b[3];
  return pointInPolygon(tri, W / 2, H / 2);
}
