// Shared Gann code: default levels/fans/arcs, ratio labels, box corner
// handles, box fills, fans and quarter arcs inside a box (Gann box, Gann
// square, Gann grid) and the fan rays of the Gann fan. Pixel space
// (CSS px, pane-local): the box levels divide the box on screen.
import type { ChartTheme } from '../../options';
import {
  BODY_HIT,
  inBox,
  lineDistance,
  setLineStyle,
  textFont,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { withPrice, withTime } from '../geometry';
import { ellipseDistance, pointInPolygon } from '../shape-utils';
import type {
  DrawingProperty,
  DrawingHandle,
  DrawingHitPart,
  DrawingLevel,
  DrawingLineStyle,
  DrawingPoint,
  PixelPoint,
} from '../types';
import { fanRayBuffer, hitBoxGrid, renderBoxGrid, type FanRay } from './fan-common';
import { fillAlpha, levelsOf } from './fib-common';

/** Gann box / square grid levels (fractions of the box). */
const TV_GRID_LEVELS: readonly (readonly [number, string])[] = [
  [0, '#787b86'],
  [0.25, '#ff9800'],
  [0.382, '#00bcd4'],
  [0.5, '#4caf50'],
  [0.618, '#089981'],
  [0.75, '#2962ff'],
  [1, '#787b86'],
];

/** Fresh copy of the Gann grid levels 0, 0.25, 0.382, 0.5, 0.618, 0.75, 1. */
export function defaultGannLevels(): DrawingLevel[] {
  return TV_GRID_LEVELS.map(([value, color]) => ({ value, color, visible: true }));
}

/**
 * Gann fan ratios as price/time slope multipliers of the 1x1 line:
 * 1x8 = 1/8 (shallow) .. 8x1 = 8 (steep).
 */
const TV_FAN_LEVELS: readonly (readonly [number, string])[] = [
  [1 / 8, '#ff9800'],
  [1 / 4, '#089981'],
  [1 / 3, '#4caf50'],
  [1 / 2, '#00bcd4'],
  [1, '#2962ff'],
  [2, '#00bcd4'],
  [3, '#4caf50'],
  [4, '#089981'],
  [8, '#ff9800'],
];

/** Fresh copy of the Gann fan ratios 1x8 .. 8x1. */
export function defaultGannFanLevels(): DrawingLevel[] {
  return TV_FAN_LEVELS.map(([value, color]) => ({ value, color, visible: true }));
}

/** Gann square arcs: radii in box units around the origin corner. */
const TV_ARC_LEVELS: readonly (readonly [number, string])[] = [
  [0.25, '#ff9800'],
  [0.382, '#00bcd4'],
  [0.5, '#4caf50'],
  [0.618, '#089981'],
  [0.75, '#2962ff'],
  [1, '#787b86'],
];

/** Fresh copy of the Gann square arc radii (box units). */
export function defaultGannArcLevels(): DrawingLevel[] {
  return TV_ARC_LEVELS.map(([value, color]) => ({ value, color, visible: true }));
}

/** Ratio label of a fan slope multiplier: 2 -> "2x1", 0.25 -> "1x4", 1/3 -> "1x3". */
export function gannRatioText(v: number): string {
  if (!(v > 0) || !Number.isFinite(v)) return String(v);
  return v >= 1 ? `${+v.toFixed(3)}x1` : `1x${+(1 / v).toFixed(2)}`;
}

const sortBuf: DrawingLevel[] = [];

/** Visible, finite, positive levels sorted ascending (shared buffer: do not keep). */
export function positiveLevels(levels: unknown): readonly DrawingLevel[] {
  sortBuf.length = 0;
  for (const lv of levelsOf({ levels }))
    if (lv.visible && Number.isFinite(lv.value) && lv.value > 0) sortBuf.push(lv);
  sortBuf.sort((x, y) => x.value - y.value);
  return sortBuf;
}

/**
 * Fan rays of the box origin `a` - corner `b` (1x1 = the diagonal a-b): ratio
 * v goes through (b.x, a.y + v * dy) when v <= 1, else (a.x + dx / v, b.y),
 * i.e. the target lies on the box's far edges. Ascending ratios; each band is
 * filled with its steeper ray's colour.
 */
export function gannFanRays(a: PixelPoint, b: PixelPoint, levels: unknown): readonly FanRay[] {
  const fans = positiveLevels(levels);
  const rays = fanRayBuffer(fans.length);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (let i = 0; i < fans.length; i++) {
    const lv = fans[i]!;
    const r = rays[i]!;
    if (lv.value <= 1) {
      r.tx = b.x;
      r.ty = a.y + lv.value * dy;
    } else {
      r.tx = a.x + dx / lv.value;
      r.ty = b.y;
    }
    r.color = lv.color;
    r.fill = i > 0 ? lv.color : '';
  }
  return rays;
}

// ------------------------------------------------------------ box handles

/** Corner handles: 0/1 the anchors, 2 (x0, y1), 3 (x1, y0). */
export function boxCornerHandles(a: PixelPoint, b: PixelPoint): DrawingHandle[] {
  const diag = (b.x - a.x) * (b.y - a.y) >= 0 ? 'nwse-resize' : 'nesw-resize';
  const anti = diag === 'nwse-resize' ? 'nesw-resize' : 'nwse-resize';
  return [
    { x: a.x, y: a.y, cursor: diag },
    { x: b.x, y: b.y, cursor: diag },
    { x: a.x, y: b.y, cursor: anti },
    { x: b.x, y: a.y, cursor: anti },
  ];
}

/** Anchors after dragging corner handle `handle` of `boxCornerHandles` to `target`. */
export function moveBoxCorner(
  start: readonly DrawingPoint[],
  handle: number,
  target: DrawingPoint,
): DrawingPoint[] {
  const p0 = start[0];
  const p1 = start[1];
  if (!p0 || !p1) return start.map((p) => ({ ...p }));
  switch (handle) {
    case 0:
      return [target, { ...p1 }];
    case 1:
      return [{ ...p0 }, target];
    case 2:
      return [withTime(p0, target), withPrice(p1, target.price)];
    case 3:
      return [withPrice(p0, target.price), withTime(p1, target)];
    default:
      return [{ ...p0 }, { ...p1 }];
  }
}

/** Whether the box a-b (grown by `margin`) overlaps the pane. */
export function boxInView(
  a: PixelPoint,
  b: PixelPoint,
  width: number,
  height: number,
  margin = 50,
): boolean {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return false;
  return (
    Math.max(a.x, b.x) >= -margin &&
    Math.min(a.x, b.x) <= width + margin &&
    Math.max(a.y, b.y) >= -margin &&
    Math.min(a.y, b.y) <= height + margin
  );
}

// ------------------------------------------------------------ box fills

/**
 * Bands between consecutive visible levels: horizontal bands at y = a.y + v *
 * (b.y - a.y) for `yLevels`, vertical bands at x = a.x + v * (b.x - a.x) for
 * `xLevels`, each in its larger level's colour (`color`: one colour for all).
 */
export function renderBoxBands(
  ctx: CanvasRenderingContext2D,
  a: PixelPoint,
  b: PixelPoint,
  xLevels: unknown,
  yLevels: unknown,
  transparency: number,
  color?: string,
): void {
  if (transparency >= 100) return;
  ctx.globalAlpha = fillAlpha(transparency);
  const l = Math.min(a.x, b.x);
  const t = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  let prev: number | null = null;
  for (const lv of sortedVisible(yLevels)) {
    if (prev !== null) {
      const y0 = a.y + prev * (b.y - a.y);
      const y1 = a.y + lv.value * (b.y - a.y);
      ctx.fillStyle = color ?? lv.color;
      ctx.fillRect(l, Math.min(y0, y1), w, Math.abs(y1 - y0));
    }
    prev = lv.value;
  }
  prev = null;
  for (const lv of sortedVisible(xLevels)) {
    if (prev !== null) {
      const x0 = a.x + prev * (b.x - a.x);
      const x1 = a.x + lv.value * (b.x - a.x);
      ctx.fillStyle = color ?? lv.color;
      ctx.fillRect(Math.min(x0, x1), t, Math.abs(x1 - x0), h);
    }
    prev = lv.value;
  }
  ctx.globalAlpha = 1;
}

const visBuf: DrawingLevel[] = [];

function sortedVisible(levels: unknown): readonly DrawingLevel[] {
  visBuf.length = 0;
  for (const lv of levelsOf({ levels }))
    if (lv.visible && Number.isFinite(lv.value)) visBuf.push(lv);
  visBuf.sort((x, y) => x.value - y.value);
  return visBuf;
}

// ------------------------------------------------------------ fans inside a box

const poly: PixelPoint[] = [];
const polyPool: PixelPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

/** Band polygon between consecutive in-box rays (through corner b when they end on different edges). */
function bandPolygon(a: PixelPoint, b: PixelPoint, p: FanRay, r: FanRay): PixelPoint[] {
  poly.length = 0;
  const set = (i: number, x: number, y: number) => {
    const q = polyPool[i]!;
    q.x = x;
    q.y = y;
    poly.push(q);
  };
  set(0, a.x, a.y);
  set(1, p.tx, p.ty);
  // p ends on the far vertical edge (x = b.x), r on the far horizontal edge (y = b.y).
  if (p.tx === b.x && r.ty === b.y && p.ty !== b.y && r.tx !== b.x) set(2, b.x, b.y);
  set(poly.length, r.tx, r.ty);
  return poly;
}

/** Fan rays from the origin corner `a` to the box's far edges, optional band fills. */
export function renderBoxFan(
  ctx: CanvasRenderingContext2D,
  a: PixelPoint,
  b: PixelPoint,
  rays: readonly FanRay[],
  lineWidth: number,
  lineStyle: DrawingLineStyle,
  fill: boolean,
  transparency: number,
): void {
  if (fill && transparency < 100) {
    ctx.globalAlpha = fillAlpha(transparency);
    for (let i = 1; i < rays.length; i++) {
      const r = rays[i]!;
      if (!r.fill) continue;
      const pts = bandPolygon(a, b, rays[i - 1]!, r);
      ctx.fillStyle = r.fill;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k]!.x, pts[k]!.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  for (const r of rays) {
    setLineStyle(ctx, r.color, lineWidth, lineStyle);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(r.tx, r.ty);
    ctx.stroke();
  }
}

/** In-box rays are strong hits; filled bands weak. */
export function hitBoxFan(
  a: PixelPoint,
  b: PixelPoint,
  rays: readonly FanRay[],
  lineWidth: number,
  fill: boolean,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  const t = tol + lineWidth / 2;
  for (const r of rays) if (lineDistance(x, y, a.x, a.y, r.tx, r.ty) <= t) return BODY_HIT;
  if (!fill) return null;
  for (let i = 1; i < rays.length; i++) {
    const r = rays[i]!;
    if (r.fill && pointInPolygon(bandPolygon(a, b, rays[i - 1]!, r), x, y)) return WEAK_BODY_HIT;
  }
  return null;
}

// ------------------------------------------------------------ quarter arcs inside a box

/** Start angle (ctx.ellipse convention) of the quarter facing from `a` towards `b`. */
function quarterStart(a: PixelPoint, b: PixelPoint): number {
  const right = b.x >= a.x;
  const down = b.y >= a.y;
  if (right && down) return 0;
  if (!right && down) return Math.PI / 2;
  if (!right && !down) return Math.PI;
  return (3 * Math.PI) / 2;
}

/**
 * Quarter ellipses around the origin corner `a` with radii v * |b.x - a.x|
 * and v * |b.y - a.y| (v = arc level): circles in box units, inside the box
 * for v <= 1.
 */
export function renderBoxArcs(
  ctx: CanvasRenderingContext2D,
  a: PixelPoint,
  b: PixelPoint,
  levels: unknown,
  lineWidth: number,
  lineStyle: DrawingLineStyle,
): void {
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (!(w > 0 && h > 0)) return;
  const s = quarterStart(a, b);
  for (const lv of positiveLevels(levels)) {
    setLineStyle(ctx, lv.color, lineWidth, lineStyle);
    ctx.beginPath();
    ctx.ellipse(a.x, a.y, lv.value * w, lv.value * h, 0, s, s + Math.PI / 2);
    ctx.stroke();
  }
}

/** Whether (x, y) is within `tol` of a quarter arc of `renderBoxArcs`. */
export function hitBoxArcs(
  a: PixelPoint,
  b: PixelPoint,
  levels: unknown,
  lineWidth: number,
  x: number,
  y: number,
  tol: number,
): boolean {
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  if (!(w > 0 && h > 0)) return false;
  const t = tol + lineWidth / 2;
  // On the box side of the origin (both axes), with tolerance.
  const sx = b.x >= a.x ? 1 : -1;
  const sy = b.y >= a.y ? 1 : -1;
  if ((x - a.x) * sx < -t || (y - a.y) * sy < -t) return false;
  for (const lv of positiveLevels(levels))
    if (ellipseDistance(a.x, a.y, lv.value * w, lv.value * h, x, y) <= t) return true;
  return false;
}

/** Style keys of the box-fan-arc Gann tools (square, square fixed). */
export const GANN_SQUARE_DEFAULTS = {
  /** Handle colour. */
  lineColor: '#787b86',
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  showLevels: true,
  levels: defaultGannLevels(),
  showFans: true,
  fans: defaultGannFanLevels(),
  showArcs: true,
  arcs: defaultGannArcLevels(),
  fillBackground: true,
  backgroundTransparency: 80,
  showLabels: true,
  fontSize: 12,
};

export type GannSquareStyle = typeof GANN_SQUARE_DEFAULTS;

export const GANN_SQUARE_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Lines', inline: 'levelsLine' },
  { kind: 'lineStyle', key: 'levelsLineStyle', label: 'Style', inline: 'levelsLine' },
  { kind: 'bool', key: 'showLevels', label: 'Levels', group: 'Levels' },
  { kind: 'levels', key: 'levels', label: 'Levels', group: 'Levels' },
  { kind: 'bool', key: 'showFans', label: 'Fans', group: 'Fans' },
  { kind: 'levels', key: 'fans', label: 'Fans', group: 'Fans' },
  { kind: 'bool', key: 'showArcs', label: 'Arcs', group: 'Arcs' },
  { kind: 'levels', key: 'arcs', label: 'Arcs', group: 'Arcs' },
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
  { kind: 'bool', key: 'showLabels', label: 'Labels', group: 'Labels' },
  { kind: 'fontSize', key: 'fontSize', label: 'Font size', group: 'Labels' },
];

const LABEL_GAP = 4;

/**
 * Gann square in the box origin `a` (anchor 1) - corner `b`: the level grid
 * (same levels on both axes), fan rays from `a` to the far edges with filled
 * bands, quarter arcs around `a`, and fan ratio labels past the far edges.
 */
export function renderGannSquare(
  ctx: CanvasRenderingContext2D,
  theme: ChartTheme,
  a: PixelPoint,
  b: PixelPoint,
  s: GannSquareStyle,
): void {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return;
  const lw = s.levelsLineWidth;
  const ls = s.levelsLineStyle;
  if (s.showLevels) {
    const lv = levelsOf(s);
    renderBoxGrid(ctx, a, b, lv, lv, lw, ls);
  }
  if (s.showArcs) renderBoxArcs(ctx, a, b, s.arcs, lw, ls);
  if (!s.showFans) return;
  const rays = gannFanRays(a, b, s.fans);
  renderBoxFan(ctx, a, b, rays, lw, ls, s.fillBackground, s.backgroundTransparency);
  if (!s.showLabels) return;
  ctx.font = textFont(theme, s.fontSize);
  const fans = positiveLevels(s.fans);
  const right = b.x >= a.x;
  const down = b.y >= a.y;
  for (let i = 0; i < fans.length; i++) {
    const r = rays[i]!;
    const v = fans[i]!.value;
    ctx.fillStyle = r.color;
    if (v <= 1) {
      ctx.textAlign = right ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(gannRatioText(v), r.tx + (right ? LABEL_GAP : -LABEL_GAP), r.ty);
    } else {
      ctx.textAlign = 'center';
      ctx.textBaseline = down ? 'top' : 'bottom';
      ctx.fillText(gannRatioText(v), r.tx, r.ty + (down ? LABEL_GAP : -LABEL_GAP));
    }
  }
}

/** Grid lines, arcs and fan rays are strong hits; the filled box weak. */
export function hitGannSquare(
  a: PixelPoint,
  b: PixelPoint,
  s: GannSquareStyle,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
  if (!inBox(x, y, a.x, a.y, b.x, b.y, tol + s.levelsLineWidth)) return null;
  const lw = s.levelsLineWidth;
  const lv = levelsOf(s);
  if (s.showLevels && hitBoxGrid(a, b, lv, lv, lw, x, y, tol)) return BODY_HIT;
  if (s.showArcs && hitBoxArcs(a, b, s.arcs, lw, x, y, tol)) return BODY_HIT;
  if (!s.showFans) return null;
  return hitBoxFan(a, b, gannFanRays(a, b, s.fans), lw, s.fillBackground, x, y, tol);
}
