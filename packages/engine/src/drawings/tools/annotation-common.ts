// Shared text props, word wrapping, speech-bubble geometry and hit boxes for the
// annotation tools (callout, comment, note, price label/note, pin, table).
import { approxTextWidth, setLineStyle, TEXT_HIT, textFont, BODY_HIT } from '../draw-utils';
import { pointInPolygon } from '../shape-utils';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingProperty,
  DrawingRenderContext,
  PixelPoint,
} from '../types';

export const PAD = 6;
export const BUBBLE_RADIUS = 6;
const POINTER_HALF = 6;

/** Text + background + border style shared by the annotation tools. */
export function annotationDefaults(color: string, fill: string) {
  return {
    textColor: color,
    fontSize: 14,
    bold: false,
    italic: false,
    fillBackground: true,
    backgroundColor: fill,
    showBorder: true,
    borderColor: color,
  };
}

export type AnnotationStyle = ReturnType<typeof annotationDefaults>;

export const ANNOTATION_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
  { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
  { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
  { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
  { kind: 'bool', key: 'fillBackground', label: 'Background', tab: 'text', inline: 'bg' },
  { kind: 'color', key: 'backgroundColor', label: 'Color', tab: 'text', inline: 'bg' },
  { kind: 'bool', key: 'showBorder', label: 'Border', tab: 'text', inline: 'border' },
  { kind: 'color', key: 'borderColor', label: 'Color', tab: 'text', inline: 'border' },
];

export const WRAP_PROPERTY: DrawingProperty = {
  kind: 'number',
  key: 'wrapWidth',
  label: 'Wrap width',
  tab: 'text',
  min: 40,
  max: 600,
  step: 10,
};

/** Shown (dimmed) while the text is empty so a fresh drawing is visible. */
export const ANNOTATION_PLACEHOLDER = 'Text';

/** `text` word-wrapped to `maxWidth` px (explicit newlines kept; long words stay whole). */
export function wrapText(
  text: string,
  s: { fontSize: number; bold: boolean; italic: boolean },
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (line && approxTextWidth(next, s.fontSize, s.bold, s.italic) > maxWidth) {
        out.push(line);
        line = w;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

export interface TextBlock {
  lines: string[];
  /** Size incl. padding. */
  w: number;
  h: number;
}

/** Wrapped lines and the padded size of their block. */
export function textBlock(
  text: string,
  s: { fontSize: number; bold: boolean; italic: boolean },
  maxWidth: number,
): TextBlock {
  const lines = wrapText(text, s, maxWidth);
  let w = 0;
  for (const l of lines) w = Math.max(w, approxTextWidth(l, s.fontSize, s.bold, s.italic));
  return { lines, w: w + PAD * 2, h: lines.length * s.fontSize * 1.2 + PAD * 2 };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** (x, y) inside `r` grown by `tol`. */
export function hitBox(r: Rect, x: number, y: number, tol = 0): boolean {
  return x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol;
}

/** Whether `r` (grown by `margin`) overlaps the pane. */
export function rectInView(g: DrawingGeometry, r: Rect, margin = 20): boolean {
  return (
    r.x + r.w >= -margin &&
    r.x <= g.width + margin &&
    r.y + r.h >= -margin &&
    r.y <= g.height + margin
  );
}

/**
 * Outline of `box` with a pointer to `tip` (clockwise from the top-left corner).
 * The pointer sits on the side facing the tip; a tip inside the box adds none.
 */
export function bubblePolygon(box: Rect, tip: PixelPoint | null): PixelPoint[] {
  const { x, y, w, h } = box;
  const tl = { x, y };
  const tr = { x: x + w, y };
  const br = { x: x + w, y: y + h };
  const bl = { x, y: y + h };
  const out: PixelPoint[] = [tl];
  const hw = Math.min(POINTER_HALF, w / 4, h / 4);
  const along = (v: number, lo: number, len: number) =>
    Math.min(Math.max(v, lo + BUBBLE_RADIUS + hw), lo + len - BUBBLE_RADIUS - hw);
  if (tip && Number.isFinite(tip.x) && Number.isFinite(tip.y)) {
    if (tip.y < y) {
      const c = along(tip.x, x, w);
      out.push({ x: c - hw, y }, tip, { x: c + hw, y });
    }
  }
  out.push(tr);
  if (tip && Number.isFinite(tip.x) && Number.isFinite(tip.y)) {
    if (tip.y >= y && tip.y <= y + h && tip.x > x + w) {
      const c = along(tip.y, y, h);
      out.push({ x: x + w, y: c - hw }, tip, { x: x + w, y: c + hw });
    }
  }
  out.push(br);
  if (tip && Number.isFinite(tip.x) && Number.isFinite(tip.y)) {
    if (tip.y > y + h) {
      const c = along(tip.x, x, w);
      out.push({ x: c + hw, y: y + h }, tip, { x: c - hw, y: y + h });
    }
  }
  out.push(bl);
  if (tip && Number.isFinite(tip.x) && Number.isFinite(tip.y)) {
    if (tip.y >= y && tip.y <= y + h && tip.x < x) {
      const c = along(tip.y, y, h);
      out.push({ x, y: c + hw }, tip, { x, y: c - hw });
    }
  }
  return out;
}

/** Closed path through `pts` with corners rounded by `r` (the pointer tip stays sharp). */
function traceRounded(
  ctx: CanvasRenderingContext2D,
  pts: readonly PixelPoint[],
  tip: PixelPoint | null,
) {
  const n = pts.length;
  const mid = (a: PixelPoint, b: PixelPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const start = mid(pts[n - 1]!, pts[0]!);
  ctx.moveTo(start.x, start.y);
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const next = pts[(i + 1) % n]!;
    if (p === tip) ctx.lineTo(p.x, p.y);
    else ctx.arcTo(p.x, p.y, next.x, next.y, BUBBLE_RADIUS);
  }
  ctx.closePath();
}

/** Fill/stroke the bubble outline and draw `block` inside it. */
export function renderBubble(
  { ctx, theme }: DrawingRenderContext,
  box: Rect,
  tip: PixelPoint | null,
  block: TextBlock,
  s: AnnotationStyle,
  dim = false,
): void {
  const pts = bubblePolygon(box, tip);
  ctx.beginPath();
  traceRounded(ctx, pts, tip && pts.includes(tip) ? tip : null);
  if (s.fillBackground) {
    ctx.fillStyle = s.backgroundColor;
    ctx.fill();
  }
  if (s.showBorder) {
    setLineStyle(ctx, s.borderColor, 1, 'solid');
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  renderTextLines(ctx, theme, block.lines, s, box.x + PAD, box.y + PAD, dim);
}

/** Left-aligned lines with their top-left corner at (x, y). */
export function renderTextLines(
  ctx: CanvasRenderingContext2D,
  theme: DrawingRenderContext['theme'],
  lines: readonly string[],
  s: { textColor: string; fontSize: number; bold: boolean; italic: boolean },
  x: number,
  y: number,
  dim = false,
): void {
  ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
  ctx.fillStyle = s.textColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const prev = ctx.globalAlpha;
  if (dim) ctx.globalAlpha = prev * 0.5;
  const lineH = s.fontSize * 1.2;
  for (let i = 0; i < lines.length; i++)
    ctx.fillText(lines[i]!, x, y + i * lineH + s.fontSize * 0.1);
  ctx.globalAlpha = prev;
}

/** Hit test of a bubble: box = text, pointer/border band = body. */
export function hitBubble(
  box: Rect,
  tip: PixelPoint | null,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  if (hitBox(box, x, y, tol)) return TEXT_HIT;
  if (!tip) return null;
  const pts = bubblePolygon(box, tip);
  return pointInPolygon(pts, x, y) || Math.hypot(x - tip.x, y - tip.y) <= tol ? BODY_HIT : null;
}

/** Bounding rect of `box` and `tip`. */
export function bubbleBounds(box: Rect, tip: PixelPoint | null): Rect {
  if (!tip) return box;
  const l = Math.min(box.x, tip.x);
  const t = Math.min(box.y, tip.y);
  return {
    x: l,
    y: t,
    w: Math.max(box.x + box.w, tip.x) - l,
    h: Math.max(box.y + box.h, tip.y) - t,
  };
}
