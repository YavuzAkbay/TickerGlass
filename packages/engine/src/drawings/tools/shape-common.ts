// Shared style schema, rendering and hit testing for the geometric shape tools
// (rotated rectangle, circle, ellipse, triangle, polyline, arc, path, curves).
import {
  approxTextWidth,
  BODY_HIT,
  setLineStyle,
  splitLines,
  TEXT_HIT,
  textFont,
} from '../draw-utils';
import { pointInPolygon, polylineDistance, tracePolyline } from '../shape-utils';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingLineStyle,
  DrawingPoint,
  DrawingProperty,
  DrawingRenderContext,
  PixelPoint,
} from '../types';

/** Border + background defaults for a closed shape in `color` (`fill` = rgba background). */
export function shapeDefaults(color: string, fill: string) {
  return {
    lineColor: color,
    lineWidth: 2,
    lineStyle: 'solid' as DrawingLineStyle,
    fillBackground: true,
    backgroundColor: fill,
  };
}

export type ShapeStyle = ReturnType<typeof shapeDefaults>;

export const SHAPE_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'color', key: 'lineColor', label: 'Border', inline: 'line' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
  { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
  { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
];

/** Open-line defaults (path, curves). */
export function lineDefaults(color: string) {
  return { lineColor: color, lineWidth: 2, lineStyle: 'solid' as DrawingLineStyle };
}

export const LINE_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
];

export function textDefaults(color: string) {
  return { textColor: color, fontSize: 14, bold: false, italic: false };
}

export type TextStyle = ReturnType<typeof textDefaults>;

export const TEXT_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
  { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
  { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
  { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
];

/** Fill (when enabled, >= 3 points) and stroke the closed polygon `pts`. */
export function renderPolygon(
  ctx: CanvasRenderingContext2D,
  pts: readonly PixelPoint[],
  s: ShapeStyle,
): void {
  if (pts.length < 2) return;
  if (s.fillBackground && pts.length > 2) {
    ctx.fillStyle = s.backgroundColor;
    ctx.beginPath();
    tracePolyline(ctx, pts, true);
    ctx.fill();
  }
  setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  tracePolyline(ctx, pts, true);
  ctx.stroke();
}

/** Border (strong) or filled interior (strong, grabbable) of a closed polygon. */
export function hitPolygon(
  pts: readonly PixelPoint[],
  s: ShapeStyle,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  if (!pts.length) return null;
  if (polylineDistance(pts, x, y, true) <= tol + s.lineWidth / 2) return BODY_HIT;
  return s.fillBackground && pts.length > 2 && pointInPolygon(pts, x, y) ? BODY_HIT : null;
}

const box = { l: 0, t: 0, r: 0, b: 0 };

/** Bounding box of the finite points (empty: l > r). Shared buffer. */
export function pointsBounds(pts: readonly PixelPoint[]): typeof box {
  box.l = box.t = Infinity;
  box.r = box.b = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < box.l) box.l = p.x;
    if (p.x > box.r) box.r = p.x;
    if (p.y < box.t) box.t = p.y;
    if (p.y > box.b) box.b = p.y;
  }
  return box;
}

/** Whether the box around `pts` grown by `margin` overlaps the pane. */
export function pointsInView(g: DrawingGeometry, pts: readonly PixelPoint[], margin = 20) {
  const b = pointsBounds(pts);
  return b.r >= -margin && b.l <= g.width + margin && b.b >= -margin && b.t <= g.height + margin;
}

/** Same anchor (time, price and brick). */
export function samePoint(a: DrawingPoint, b: DrawingPoint): boolean {
  return a.time === b.time && a.price === b.price && (a.brick ?? 0) === (b.brick ?? 0);
}

/** Unit normal of a -> b turned to point up on screen (y < 0); null for a zero-length segment. */
export function upNormal(a: PixelPoint, b: PixelPoint): PixelPoint | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!(len > 0)) return null;
  let nx = dy / len;
  let ny = -dx / len;
  if (ny > 0 || (ny === 0 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

const textBox = { x: 0, y: 0, w: 0, h: 0 };

/** Box (centre x/y, size) of the text block of `lines` centred at (cx, cy). Shared buffer. */
export function centeredTextBox(
  lines: readonly string[],
  s: TextStyle,
  cx: number,
  cy: number,
): typeof textBox {
  let w = 0;
  for (const l of lines) w = Math.max(w, approxTextWidth(l, s.fontSize, s.bold, s.italic));
  textBox.w = w;
  textBox.h = lines.length * s.fontSize * 1.2;
  textBox.x = cx;
  textBox.y = cy;
  return textBox;
}

/** Draw the (multiline) text centred at (cx, cy). */
export function renderCenteredText(
  { ctx, theme }: DrawingRenderContext,
  text: string,
  s: TextStyle,
  cx: number,
  cy: number,
): void {
  const lines = splitLines(text);
  const lineH = s.fontSize * 1.2;
  const top = cy - (lines.length * lineH) / 2;
  ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
  ctx.fillStyle = s.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i]!, cx, top + i * lineH);
}

/** TEXT_HIT when (x, y) is on the text block centred at (cx, cy). */
export function hitCenteredText(
  text: string,
  s: TextStyle,
  cx: number,
  cy: number,
  x: number,
  y: number,
): DrawingHitPart | null {
  const b = centeredTextBox(splitLines(text), s, cx, cy);
  return Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.h / 2 ? TEXT_HIT : null;
}
