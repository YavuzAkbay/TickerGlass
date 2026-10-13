// Rendering and geometry helpers shared by drawing tools (CSS px, pane-local).
import { DARK_THEME, type ChartTheme } from '../options';
import { roundRect } from '../render/draw';
import { segmentDistance } from '../studies/hit';
import type { DrawingGeometry, DrawingHitPart, DrawingLineStyle, DrawingStyle } from './types';

export { segmentDistance };

/** Selection/handle colour when a tool has no `lineColor`. */
export const DEFAULT_DRAWING_COLOR = '#2962ff';
export const HANDLE_RADIUS = 5;
/** Hit tolerance (px) around strokes. */
export const HIT_TOLERANCE = 4;
/** Stroke hit tolerance (CSS px) when the last pointer was a finger. */
export const TOUCH_HIT_TOLERANCE = 10;

const dashes = new Map<string, number[]>();
const SOLID: number[] = [];

/** Dash pattern for a line style at a CSS width (cached, do not mutate). */
export function dashFor(style: DrawingLineStyle, width: number): number[] {
  if (style === 'solid') return SOLID;
  const key = `${style}:${width}`;
  let d = dashes.get(key);
  if (!d) {
    const w = Math.max(1, width);
    d = style === 'dashed' ? [w * 4, w * 3] : [w, w * 2];
    dashes.set(key, d);
  }
  return d;
}

/** Set stroke colour, width and dash. */
export function setLineStyle(
  ctx: CanvasRenderingContext2D,
  color: string,
  width: number,
  style: DrawingLineStyle,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dashFor(style, width));
}

/** `style[key]` as a colour string, else the fallback. */
export function colorOf(style: DrawingStyle, key = 'lineColor', fallback = DEFAULT_DRAWING_COLOR) {
  const v = style[key];
  return typeof v === 'string' ? v : fallback;
}

/**
 * Segment (x0,y0)-(x1,y1) extended past either end to the pane box (with a
 * margin). Writes [x0, y0, x1, y1] into `out`. A degenerate segment, or a line
 * that misses the box, is written unchanged.
 */
export function extendSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  left: boolean,
  right: boolean,
  width: number,
  height: number,
  out: number[],
): number[] {
  out[0] = x0;
  out[1] = y0;
  out[2] = x1;
  out[3] = y1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  if ((!left && !right) || (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9)) return out;
  // Liang-Barsky on the infinite line against [-m, w+m] x [-m, h+m].
  const m = 10;
  clipT0 = -Infinity;
  clipT1 = Infinity;
  if (
    !clip(-dx, x0 + m) ||
    !clip(dx, width + m - x0) ||
    !clip(-dy, y0 + m) ||
    !clip(dy, height + m - y0) ||
    clipT0 > clipT1
  )
    return out;
  const a = left ? Math.min(0, clipT0) : 0;
  const b = right ? Math.max(1, clipT1) : 1;
  out[0] = x0 + a * dx;
  out[1] = y0 + a * dy;
  out[2] = x0 + b * dx;
  out[3] = y0 + b * dy;
  return out;
}

let clipT0 = 0;
let clipT1 = 0;

/** One Liang-Barsky edge; false when the line is parallel to and outside it. */
function clip(p: number, q: number): boolean {
  if (Math.abs(p) < 1e-12) return q >= 0;
  const r = q / p;
  if (p < 0) clipT0 = Math.max(clipT0, r);
  else clipT1 = Math.min(clipT1, r);
  return true;
}

/** Distance from (px, py) to a segment optionally extended to a ray/line. */
export function lineDistance(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extendLeft = false,
  extendRight = false,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  if (!extendLeft) t = Math.max(0, t);
  if (!extendRight) t = Math.min(1, t);
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/** Font family of the last rendered text (hit tests measure with it). */
let lastFontFamily = 'sans-serif';

export function textFont(theme: ChartTheme, size: number, bold = false, italic = false): string {
  lastFontFamily = theme.fontFamily;
  return `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${size}px ${theme.fontFamily}`;
}

/** Multi-line info label box (measure tools, trend-line stats) with its top-left at (x, y). */
export function infoLabel(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  x: number,
  y: number,
  theme: ChartTheme,
  bg = 'rgba(41, 98, 255, 0.85)',
  fg = '#ffffff',
): { x: number; y: number; w: number; h: number } {
  const size = theme.fontSize + 1;
  const lineH = size + 5;
  ctx.font = textFont(theme, size);
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  w += 16;
  const h = lines.length * lineH + 8;
  ctx.setLineDash(SOLID);
  ctx.fillStyle = bg;
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i]!, x + 8, y + 4 + lineH * (i + 0.5));
  return { x, y, w, h };
}

/** Compact duration, e.g. "3d 4h", "45m", "2w". */
export function formatDuration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  const units: [number, string][] = [
    [7 * 86_400, 'w'],
    [86_400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  const parts: string[] = [];
  let rest = s;
  for (const [n, u] of units) {
    if (rest >= n) {
      parts.push(`${Math.floor(rest / n)}${u}`);
      rest %= n;
    }
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(' ') : `${s}s`;
}

/** Framework handle: hollow circle (filled when hovered). */
export function drawHandle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  theme: ChartTheme,
  hovered: boolean,
): void {
  ctx.setLineDash(SOLID);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = hovered ? color : theme.background;
  ctx.beginPath();
  ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/**
 * Culling for lines: whether segment (x0,y0)-(x1,y1), optionally extended to a
 * ray/line, passes through the pane box grown by `margin` (Liang-Barsky).
 */
export function segmentInView(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  extendLeft: boolean,
  extendRight: boolean,
  width: number,
  height: number,
  margin = 50,
): boolean {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const inside = (x: number, y: number) =>
    x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return inside(x0, y0);
  let t0 = extendLeft ? -Infinity : 0;
  let t1 = extendRight ? Infinity : 1;
  const edges: [number, number][] = [
    [-dx, x0 + margin],
    [dx, width + margin - x0],
    [-dy, y0 + margin],
    [dy, height + margin - y0],
  ];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return false;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
}

/** Default culling: the anchors' x span (plus `margin` px) overlaps the pane. */
export function anchorsInView(g: DrawingGeometry, margin = 50): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of g.points) {
    if (p.x < lo) lo = p.x;
    if (p.x > hi) hi = p.x;
  }
  return hi >= -margin && lo <= g.width + margin;
}

export const BODY_HIT: DrawingHitPart = { kind: 'body' };
export const WEAK_BODY_HIT: DrawingHitPart = { kind: 'body', weak: true };
export const TEXT_HIT: DrawingHitPart = { kind: 'text' };

/**
 * Whether (x, y) is inside a text box of size (w, h) whose bottom-centre sits
 * at (cx, cy), rotated by `angle` (radians) around that point.
 */
export function hitRotatedText(
  x: number,
  y: number,
  cx: number,
  cy: number,
  angle: number,
  w: number,
  h: number,
): boolean {
  const dx = x - cx;
  const dy = y - cy;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  return Math.abs(lx) <= w / 2 && ly <= 0 && ly >= -h;
}

type Measurer = { font: string; measureText(t: string): { width: number } };
let measurer: Measurer | null | undefined;
const widthCache = new Map<string, number>();

/** Shared offscreen 2D context for measuring text outside render, or null (no DOM). */
function getMeasurer(): Measurer | null {
  if (measurer !== undefined) return measurer;
  measurer = null;
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : typeof document !== 'undefined'
          ? document.createElement('canvas')
          : null;
    const ctx = canvas?.getContext('2d') as Measurer | null | undefined;
    if (ctx && typeof ctx.measureText === 'function') measurer = ctx;
  } catch {
    // No canvas support (workers without OffscreenCanvas, tests): approximate instead.
    measurer = null;
  }
  return measurer;
}

/**
 * Text width for hit testing (no render context). Measured with an offscreen
 * canvas in the font family last used for rendering (cached); approximated
 * (0.6 em per character) where no canvas exists.
 */
export function approxTextWidth(
  text: string,
  fontSize: number,
  bold = false,
  italic = false,
): number {
  const m = getMeasurer();
  if (!m) return text.length * fontSize * 0.6;
  const font = `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}${fontSize}px ${lastFontFamily}`;
  const key = `${font}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (widthCache.size > 2000) widthCache.clear();
    m.font = font;
    w = m.measureText(text).width;
    widthCache.set(key, w);
  }
  return w;
}

// ------------------------------------------------- helpers for core tools

/** `v` clamped to [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Whether (x, y) lies in the box spanned by two corners (any order), grown by `tol`. */
export function inBox(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  tol = 0,
): boolean {
  return (
    x >= Math.min(x0, x1) - tol &&
    x <= Math.max(x0, x1) + tol &&
    y >= Math.min(y0, y1) - tol &&
    y <= Math.max(y0, y1) + tol
  );
}

/** Distance from (x, y) to the outline of the box spanned by two corners. */
export function boxEdgeDistance(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const l = Math.min(x0, x1);
  const r = Math.max(x0, x1);
  const t = Math.min(y0, y1);
  const b = Math.max(y0, y1);
  const dx = x < l ? l - x : x > r ? x - r : 0;
  const dy = y < t ? t - y : y > b ? y - b : 0;
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(x - l, r - x, y - t, b - y);
}

/** Open arrow head (chevron) at (x1, y1) pointing away from (x0, y0). Solid stroke, current colour/width. */
export function arrowHead(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: number,
): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const spread = Math.PI / 7;
  ctx.setLineDash(SOLID);
  ctx.beginPath();
  ctx.moveTo(x1 - size * Math.cos(a - spread), y1 - size * Math.sin(a - spread));
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1 - size * Math.cos(a + spread), y1 - size * Math.sin(a + spread));
  ctx.stroke();
}

const labelSize = { w: 0, h: 0 };
/** Theme of the last rendered info label (hit tests size labels with it). */
let labelTheme: ChartTheme | null = null;

/** `infoLabel` box size for hit testing: the last render's theme, text measured off-canvas. */
export function hitLabelSize(lines: readonly string[]): { w: number; h: number } {
  return approxInfoLabelSize(lines, labelTheme ?? DARK_THEME);
}

/** Size of an `infoLabel` box for `lines` (reused object; sets `ctx.font`). */
export function infoLabelSize(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  theme: ChartTheme,
): { w: number; h: number } {
  labelTheme = theme;
  const size = theme.fontSize + 1;
  ctx.font = textFont(theme, size);
  let w = 0;
  for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
  labelSize.w = w + 16;
  labelSize.h = lines.length * (size + 5) + 8;
  return labelSize;
}

/** Approximate `infoLabel` box size without a canvas (hit testing). */
export function approxInfoLabelSize(
  lines: readonly string[],
  theme: ChartTheme,
): { w: number; h: number } {
  const size = theme.fontSize + 1;
  let w = 0;
  for (const l of lines) w = Math.max(w, approxTextWidth(l, size));
  labelSize.w = w + 16;
  labelSize.h = lines.length * (size + 5) + 8;
  return labelSize;
}

const lineCache = new Map<string, string[]>();

/** `text` split into lines (cached, do not mutate). */
export function splitLines(text: string): readonly string[] {
  let lines = lineCache.get(text);
  if (!lines) {
    if (lineCache.size > 256) lineCache.clear();
    lines = text.split('\n');
    lineCache.set(text, lines);
  }
  return lines;
}

/** Signed change `to - from` and its percentage of `from` (NaN when `from` is 0). */
export function priceChange(from: number, to: number): { change: number; percent: number } {
  const change = to - from;
  return { change, percent: from !== 0 ? (change / Math.abs(from)) * 100 : NaN };
}

/** "+1.25 (+2.10%)" style price change label. */
export function priceChangeText(g: DrawingGeometry, from: number, to: number): string {
  const { change, percent } = priceChange(from, to);
  return `${change > 0 ? '+' : ''}${g.format.price(change)} (${g.format.percent(percent)})`;
}
