import {
  anchorsInView,
  segmentInView,
  BODY_HIT,
  extendSegment,
  lineDistance,
  setLineStyle,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { withPrice, withTime } from '../geometry';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingHandle, DrawingLineStyle, DrawingPoint } from '../types';

const segA = [0, 0, 0, 0];
const segB = [0, 0, 0, 0];

export const PARALLEL_CHANNEL_DEFAULTS = {
  lineColor: '#2962ff',
  lineWidth: 2,
  lineStyle: 'solid' as DrawingLineStyle,
  extendLeft: false,
  extendRight: false,
  fillBackground: true,
  backgroundColor: 'rgba(41, 98, 255, 0.2)',
  showMiddleLine: true,
  middleLineColor: '#2962ff',
  middleLineWidth: 1,
  middleLineStyle: 'dashed' as DrawingLineStyle,
};

type ChannelStyle = typeof PARALLEL_CHANNEL_DEFAULTS;

/** Price on the line through (l0, v0)-(l1, v1) at logical `l` (v0 for a vertical line). */
function lineValueAt(l0: number, v0: number, l1: number, v1: number, l: number): number {
  return Math.abs(l1 - l0) < 1e-9 ? v0 : v0 + ((v1 - v0) * (l - l0)) / (l1 - l0);
}

/**
 * Channel width in price units: anchor 2's price minus the main line's price
 * at anchor 2's bar (0 with fewer than three anchors).
 */
export function channelOffset(points: readonly DrawingPoint[], logical: readonly number[]): number {
  const [p0, p1, p2] = points;
  if (!p0 || !p1 || !p2) return 0;
  const [l0 = 0, l1 = 0, l2 = 0] = logical;
  return p2.price - lineValueAt(l0, p0.price, l1, p1.price, l2);
}

/**
 * Channel width in pixels: anchor 2's y minus the main line's y at anchor 2's
 * x (0 with fewer than three anchors). Working in pixels keeps the lines
 * parallel on screen on every price scale: on a log scale the width is a
 * constant ratio, on a linear one it equals `channelOffset` in price.
 */
export function channelOffsetPx(g: DrawingGeometry, points: readonly DrawingPoint[]): number {
  const [p0, p1, p2] = points;
  if (!p0 || !p1 || !p2) return 0;
  const a = g.toPixel(p0);
  const b = g.toPixel(p1);
  const c = g.toPixel(p2);
  const dx = b.x - a.x;
  const yMain = Math.abs(dx) < 1e-9 ? a.y : a.y + ((b.y - a.y) * (c.x - a.x)) / dx;
  return c.y - yMain;
}

/** Pixel corners: main a(0,1) b(2,3), parallel c(4,5) d(6,7) at the same x as a, b. */
const corners = [0, 0, 0, 0, 0, 0, 0, 0];

function computeCorners(g: DrawingGeometry): boolean {
  const [p0, p1] = g.drawing.points;
  const [a, b] = g.points;
  if (!p0 || !p1 || !a || !b) return false;
  const dy = g.points.length >= 3 ? channelOffsetPx(g, g.drawing.points) : 0;
  corners[0] = a.x;
  corners[1] = a.y;
  corners[2] = b.x;
  corners[3] = b.y;
  corners[4] = a.x;
  corners[5] = a.y + dy;
  corners[6] = b.x;
  corners[7] = b.y + dy;
  return true;
}

function strokeSeg(ctx: CanvasRenderingContext2D, s: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(s[0]!, s[1]!);
  ctx.lineTo(s[2]!, s[3]!);
  ctx.stroke();
}

/** Two parallel lines (anchors 0-1 and the offset through anchor 2), optional middle line and fill. */
export const parallelChannel = defineDrawingTool({
  type: 'parallel-channel',
  name: 'Parallel channel',
  group: 'lines',
  creation: { kind: 'points', count: 3 },
  defaults: PARALLEL_CHANNEL_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Lines', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'showMiddleLine', label: 'Middle line', inline: 'middle' },
    { kind: 'color', key: 'middleLineColor', label: 'Color', inline: 'middle' },
    { kind: 'lineWidth', key: 'middleLineWidth', label: 'Width', inline: 'middle' },
    { kind: 'lineStyle', key: 'middleLineStyle', label: 'Style', inline: 'middle' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
    { kind: 'bool', key: 'extendLeft', label: 'Extend left' },
    { kind: 'bool', key: 'extendRight', label: 'Extend right' },
  ],

  render({ ctx }, g, s) {
    if (!computeCorners(g)) return;
    const c = corners;
    const W = g.width;
    const H = g.height;
    const full = g.points.length >= 3;
    extendSegment(c[0]!, c[1]!, c[2]!, c[3]!, s.extendLeft, s.extendRight, W, H, segA);
    if (full) {
      extendSegment(c[4]!, c[5]!, c[6]!, c[7]!, s.extendLeft, s.extendRight, W, H, segB);
      if (s.fillBackground) {
        ctx.fillStyle = s.backgroundColor;
        ctx.beginPath();
        ctx.moveTo(segA[0]!, segA[1]!);
        ctx.lineTo(segA[2]!, segA[3]!);
        ctx.lineTo(segB[2]!, segB[3]!);
        ctx.lineTo(segB[0]!, segB[1]!);
        ctx.closePath();
        ctx.fill();
      }
      if (s.showMiddleLine) {
        setLineStyle(ctx, s.middleLineColor, s.middleLineWidth, s.middleLineStyle);
        ctx.beginPath();
        ctx.moveTo((segA[0]! + segB[0]!) / 2, (segA[1]! + segB[1]!) / 2);
        ctx.lineTo((segA[2]! + segB[2]!) / 2, (segA[3]! + segB[3]!) / 2);
        ctx.stroke();
      }
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    strokeSeg(ctx, segA);
    if (full) strokeSeg(ctx, segB);
  },

  hitTest(g, s, x, y, tol) {
    if (!computeCorners(g)) return null;
    const c = corners;
    const t = tol + s.lineWidth / 2;
    const el = s.extendLeft;
    const er = s.extendRight;
    if (lineDistance(x, y, c[0]!, c[1]!, c[2]!, c[3]!, el, er) <= t) return BODY_HIT;
    if (g.points.length < 3) return null;
    if (lineDistance(x, y, c[4]!, c[5]!, c[6]!, c[7]!, el, er) <= t) return BODY_HIT;
    const mt = tol + s.middleLineWidth / 2;
    if (
      s.showMiddleLine &&
      lineDistance(x, y, c[0]!, (c[1]! + c[5]!) / 2, c[2]!, (c[3]! + c[7]!) / 2, el, er) <= mt
    )
      return BODY_HIT;
    if (!s.fillBackground) return null;
    // Inside: between the two lines over the (extended) x span.
    const dx = c[2]! - c[0]!;
    if (Math.abs(dx) < 1e-9) return null;
    const u = (x - c[0]!) / dx;
    if ((u < 0 && !(dx > 0 ? el : er)) || (u > 1 && !(dx > 0 ? er : el))) return null;
    const ya = c[1]! + (c[3]! - c[1]!) * u;
    const yb = c[5]! + (c[7]! - c[5]!) * u;
    return y >= Math.min(ya, yb) && y <= Math.max(ya, yb) ? WEAK_BODY_HIT : null;
  },

  handles(g) {
    if (!computeCorners(g)) return [];
    const c = corners;
    const hs: DrawingHandle[] = [
      { x: c[0]!, y: c[1]! },
      { x: c[2]!, y: c[3]! },
    ];
    if (g.points.length < 3) return hs;
    hs.push(
      { x: c[4]!, y: c[5]! },
      { x: c[6]!, y: c[7]! },
      { x: (c[0]! + c[2]!) / 2, y: (c[1]! + c[3]!) / 2, cursor: 'ns-resize' },
      { x: (c[4]! + c[6]!) / 2, y: (c[5]! + c[7]!) / 2, cursor: 'ns-resize' },
    );
    return hs;
  },

  /**
   * 0/1: main anchors (width kept). 2/3: parallel line ends and 5: its middle
   * set the width. 4: main line middle moves the main line vertically, the
   * parallel line stays.
   */
  moveHandle({ start, handle, target, geometry: g }) {
    const pts = start.map((p) => ({ ...p }));
    const [p0, p1, p2] = pts;
    if (!p0 || !p1) return pts;
    if (!p2) {
      if (handle < 2) pts[handle] = target;
      return pts;
    }
    // Width in pixels (parallel on screen on log scales too, see channelOffsetPx).
    const dy = channelOffsetPx(g, start);
    const ya = g.priceToY(p0.price);
    const yb = g.priceToY(p1.price);
    switch (handle) {
      case 0:
      case 1: {
        pts[handle] = target;
        const a = pts[0]!;
        return [a, pts[1]!, withPrice(a, g.yToPrice(g.priceToY(a.price) + dy))];
      }
      case 2:
        return [p0, p1, withTime(target, p0)];
      case 3:
        return [p0, p1, withTime(target, p1)];
      case 4: {
        const d = g.priceToY(target.price) - (ya + yb) / 2;
        return [withPrice(p0, g.yToPrice(ya + d)), withPrice(p1, g.yToPrice(yb + d)), p2];
      }
      case 5: {
        const w = g.priceToY(target.price) - (ya + yb) / 2;
        return [p0, p1, withPrice(p0, g.yToPrice(ya + w))];
      }
      default:
        return pts;
    }
  },

  timeAxisLabels(d, s, state) {
    if (!state.selected && !state.editing) return [];
    const out = [];
    for (let i = 0; i < Math.min(2, d.points.length); i++)
      out.push({ value: d.points[i]!.time, color: s.lineColor });
    return out;
  },

  isVisible(g, s: ChannelStyle) {
    if (!computeCorners(g)) return anchorsInView(g);
    const c = corners;
    const el = s.extendLeft;
    const er = s.extendRight;
    if (segmentInView(c[0]!, c[1]!, c[2]!, c[3]!, el, er, g.width, g.height)) return true;
    if (g.points.length < 3) return false;
    if (segmentInView(c[4]!, c[5]!, c[6]!, c[7]!, el, er, g.width, g.height)) return true;
    // Both lines off screen: the band between them may still cover the pane.
    const dx = c[2]! - c[0]!;
    if (!s.fillBackground || Math.abs(dx) < 1e-9) return false;
    const u = (g.width / 2 - c[0]!) / dx;
    if ((u < 0 && !(dx > 0 ? el : er)) || (u > 1 && !(dx > 0 ? er : el))) return false;
    const ya = c[1]! + (c[3]! - c[1]!) * u;
    const yb = c[5]! + (c[7]! - c[5]!) * u;
    return Math.min(ya, yb) <= g.height && Math.max(ya, yb) >= 0;
  },
});
