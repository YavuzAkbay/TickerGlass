import {
  anchorsInView,
  BODY_HIT,
  lineDistance,
  segmentInView,
  setLineStyle,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { withTime } from '../geometry';
import { defineDrawingTool } from '../registry';
import type {
  DrawingAxisLabel,
  DrawingGeometry,
  DrawingLineStyle,
  DrawingPoint,
  DrawingProperty,
} from '../types';

/** Style keys of the two-line channels (split channel, flat-edge channel). */
export const TWO_LINE_CHANNEL_DEFAULTS = {
  lineColor: '#4f6bed',
  lineWidth: 2,
  lineStyle: 'solid' as DrawingLineStyle,
  extendLeft: false,
  extendRight: false,
  fillBackground: true,
  backgroundColor: 'rgba(79, 107, 237, 0.2)',
};

export type TwoLineChannelStyle = typeof TWO_LINE_CHANNEL_DEFAULTS;

export const TWO_LINE_CHANNEL_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'color', key: 'lineColor', label: 'Lines', inline: 'line' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
  { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
  { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
  { kind: 'bool', key: 'extendLeft', label: 'Extend left' },
  { kind: 'bool', key: 'extendRight', label: 'Extend right' },
];

/**
 * Two lines over the same x span: A a0 -> a1 and B b0 -> b1 with b0.x = a0.x
 * and b1.x = a1.x, as [a0x, a0y, a1x, a1y, b0y, b1y]. Extensions move both
 * lines' ends alike (before end 0 / after end 1), so the fill stays a quad.
 */
export type TwoLines = [number, number, number, number, number, number];

/** Parameter range [t0, t1] along a0 -> a1 with the extensions (reused). */
const span = { t0: 0, t1: 1 };

function setSpan(l: TwoLines, s: TwoLineChannelStyle, width: number): boolean {
  const dx = l[2] - l[0];
  span.t0 = 0;
  span.t1 = 1;
  if (Math.abs(dx) < 1e-9) return !s.extendLeft && !s.extendRight;
  // t where x reaches the pane's left/right edge (plus a margin).
  const tl = (-10 - l[0]) / dx;
  const tr = (width + 10 - l[0]) / dx;
  if (s.extendLeft) span.t0 = Math.min(0, Math.min(tl, tr));
  if (s.extendRight) span.t1 = Math.max(1, Math.max(tl, tr));
  return true;
}

/** Extended ends: A (0..3), B (4..7) as x, y pairs (reused). */
const ends = [0, 0, 0, 0, 0, 0, 0, 0];

function extendedEnds(l: TwoLines, s: TwoLineChannelStyle, width: number): number[] | null {
  if (!setSpan(l, s, width)) return null;
  const dx = l[2] - l[0];
  const { t0, t1 } = span;
  const xa = l[0] + dx * t0;
  const xb = l[0] + dx * t1;
  ends[0] = xa;
  ends[1] = l[1] + (l[3] - l[1]) * t0;
  ends[2] = xb;
  ends[3] = l[1] + (l[3] - l[1]) * t1;
  ends[4] = xa;
  ends[5] = l[4] + (l[5] - l[4]) * t0;
  ends[6] = xb;
  ends[7] = l[4] + (l[5] - l[4]) * t1;
  return ends;
}

function strokeLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/** Draw line A only (drafts before the second line exists). */
export function renderFirstLine(
  ctx: CanvasRenderingContext2D,
  g: DrawingGeometry,
  s: TwoLineChannelStyle,
): void {
  const [a, b] = g.points;
  if (!a || !b) return;
  setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
  strokeLine(ctx, a.x, a.y, b.x, b.y);
}

/** Fill between the lines, then both lines. */
export function renderTwoLines(
  ctx: CanvasRenderingContext2D,
  g: DrawingGeometry,
  s: TwoLineChannelStyle,
  l: TwoLines,
): void {
  const e = extendedEnds(l, s, g.width);
  if (!e) return;
  if (s.fillBackground) {
    ctx.fillStyle = s.backgroundColor;
    ctx.beginPath();
    ctx.moveTo(e[0]!, e[1]!);
    ctx.lineTo(e[2]!, e[3]!);
    ctx.lineTo(e[6]!, e[7]!);
    ctx.lineTo(e[4]!, e[5]!);
    ctx.closePath();
    ctx.fill();
  }
  setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
  strokeLine(ctx, e[0]!, e[1]!, e[2]!, e[3]!);
  strokeLine(ctx, e[4]!, e[5]!, e[6]!, e[7]!);
}

/** Lines are strong hits, the area between them weak (with a background). */
export function hitTwoLines(
  g: DrawingGeometry,
  s: TwoLineChannelStyle,
  l: TwoLines,
  x: number,
  y: number,
  tol: number,
) {
  const e = extendedEnds(l, s, g.width);
  if (!e) return null;
  const t = tol + s.lineWidth / 2;
  if (lineDistance(x, y, e[0]!, e[1]!, e[2]!, e[3]!) <= t) return BODY_HIT;
  if (lineDistance(x, y, e[4]!, e[5]!, e[6]!, e[7]!) <= t) return BODY_HIT;
  if (!s.fillBackground) return null;
  const dx = e[2]! - e[0]!;
  if (Math.abs(dx) < 1e-9) return null;
  const u = (x - e[0]!) / dx;
  if (u < 0 || u > 1) return null;
  const ya = e[1]! + (e[3]! - e[1]!) * u;
  const yb = e[5]! + (e[7]! - e[5]!) * u;
  return y >= Math.min(ya, yb) && y <= Math.max(ya, yb) ? WEAK_BODY_HIT : null;
}

/** Culling: a line crosses the pane, or the fill covers its centre column. */
export function twoLinesInView(g: DrawingGeometry, s: TwoLineChannelStyle, l: TwoLines): boolean {
  const e = extendedEnds(l, s, g.width);
  if (!e) return anchorsInView(g);
  const W = g.width;
  const H = g.height;
  if (segmentInView(e[0]!, e[1]!, e[2]!, e[3]!, false, false, W, H)) return true;
  if (segmentInView(e[4]!, e[5]!, e[6]!, e[7]!, false, false, W, H)) return true;
  if (!s.fillBackground) return false;
  const dx = e[2]! - e[0]!;
  if (Math.abs(dx) < 1e-9) return false;
  const u = (W / 2 - e[0]!) / dx;
  if (u < 0 || u > 1) return false;
  const ya = e[1]! + (e[3]! - e[1]!) * u;
  const yb = e[5]! + (e[7]! - e[5]!) * u;
  return Math.min(ya, yb) <= H && Math.max(ya, yb) >= 0;
}

/** Time-axis labels of the first two anchors (the others share their times). */
export function twoLineTimeLabels(
  d: { points: readonly DrawingPoint[] },
  s: TwoLineChannelStyle,
  state: { selected: boolean; editing: boolean },
): DrawingAxisLabel[] {
  if (!state.selected && !state.editing) return [];
  const out: DrawingAxisLabel[] = [];
  for (let i = 0; i < Math.min(2, d.points.length); i++)
    out.push({ value: d.points[i]!.time, color: s.lineColor });
  return out;
}

/**
 * Fourth anchor of a split channel from the first three: at anchor 1's
 * time, mirroring line 0-1's price change from anchor 2 (the second line
 * slopes the other way).
 */
export function splitFourth(points: readonly DrawingPoint[]): DrawingPoint | null {
  const [p0, p1, p2] = points;
  if (!p0 || !p1 || !p2) return null;
  return withTime({ time: p1.time, price: p2.price - (p1.price - p0.price) }, p1);
}

const lines: TwoLines = [0, 0, 0, 0, 0, 0];

/** Lines of a split channel (3-anchor drafts derive anchor 3), or null. */
function splitLines(g: DrawingGeometry): TwoLines | null {
  const [a, b, c, d] = g.points;
  if (!a || !b || !c) return null;
  lines[0] = a.x;
  lines[1] = a.y;
  lines[2] = b.x;
  lines[3] = b.y;
  lines[4] = c.y;
  if (d) lines[5] = d.y;
  else {
    const p3 = splitFourth(g.drawing.points);
    lines[5] = p3 ? g.priceToY(p3.price) : c.y;
  }
  return lines;
}

/**
 * Split channel: two independent lines over the same bars (anchors 0-1 and
 * 2-3), filled between. Three clicks; anchor 2 takes anchor 0's time and
 * anchor 3 mirrors line 0-1, then all four ends move freely in price.
 */
export const splitChannel = defineDrawingTool({
  type: 'split-channel',
  name: 'Split channel',
  group: 'lines',
  creation: { kind: 'points', count: 3 },
  defaults: TWO_LINE_CHANNEL_DEFAULTS,
  properties: TWO_LINE_CHANNEL_PROPERTIES,

  render({ ctx }, g, s) {
    const l = splitLines(g);
    if (l) renderTwoLines(ctx, g, s, l);
    else renderFirstLine(ctx, g, s);
  },

  hitTest(g, s, x, y, tol) {
    const l = splitLines(g);
    if (l) return hitTwoLines(g, s, l, x, y, tol);
    const [a, b] = g.points;
    if (!a || !b) return null;
    return lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  completePoints(points) {
    const [p0, p1, p2] = points;
    const p3 = splitFourth(points);
    if (!p0 || !p1 || !p2 || !p3) return [...points];
    return [p0, p1, withTime(p2, p0), p3];
  },

  handles(g) {
    const [a, b, c, d] = g.points;
    if (!a || !b) return g.points.map((p) => ({ x: p.x, y: p.y }));
    const l = splitLines(g);
    if (!l || !c) return [{ ...a }, { ...b }];
    // Anchors 2/3 sit on anchors 0/1's x.
    const hs = [{ ...a }, { ...b }, { x: a.x, y: c.y }];
    if (d) hs.push({ x: b.x, y: d.y });
    return hs;
  },

  /** Each handle moves its end; the time moves the end of the other line too. */
  moveHandle({ start, handle, target }) {
    const pts = start.map((p) => ({ ...p }));
    if (handle >= pts.length) return pts;
    pts[handle] = target;
    const partner = handle ^ 2; // 0 <-> 2, 1 <-> 3
    if (pts[partner]) pts[partner] = withTime(pts[partner]!, target);
    return pts;
  },

  timeAxisLabels: twoLineTimeLabels,

  isVisible(g, s) {
    const l = splitLines(g);
    return l ? twoLinesInView(g, s, l) : anchorsInView(g);
  },
});
