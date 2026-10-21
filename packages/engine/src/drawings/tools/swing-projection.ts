// Swing projection: an origin (anchor 0), the end of a first move (anchor 1) and a
// projected end (anchor 2). Two legs from the origin, the sector between them
// up to the first leg's radius (pixel space) and % change labels of each leg
// from the origin. Fill colour follows the projected leg's direction.
import {
  BODY_HIT,
  hitLabelSize,
  inBox,
  infoLabel,
  infoLabelSize,
  lineDistance,
  priceChangeText,
  setLineStyle,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingLineStyle, PixelPoint } from '../types';
import { pointsInView } from './shape-common';

export const SWING_PROJECTION_DEFAULTS = {
  /** Legs and arc; also the handle colour. */
  lineColor: '#6E9BD6',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  fillBackground: true,
  upFillColor: 'rgba(127, 176, 105, 0.2)',
  downFillColor: 'rgba(222, 106, 79, 0.2)',
  showLabels: true,
  labelBackgroundColor: 'rgba(110, 155, 214, 0.85)',
  textColor: '#ffffff',
};

export interface SwingProjectionSector {
  cx: number;
  cy: number;
  r: number;
  /** ctx.arc angles from leg 1 to leg 2 the short way round. */
  start: number;
  end: number;
  anticlockwise: boolean;
}

const sector: SwingProjectionSector = {
  cx: 0,
  cy: 0,
  r: 0,
  start: 0,
  end: 0,
  anticlockwise: false,
};

/** Sector at the origin between the legs (shared object), or null with < 3 anchors. */
export function swingProjectionSector(g: DrawingGeometry): SwingProjectionSector | null {
  const [o, a, b] = g.points;
  if (!o || !a || !b) return null;
  sector.cx = o.x;
  sector.cy = o.y;
  sector.r = Math.hypot(a.x - o.x, a.y - o.y);
  sector.start = Math.atan2(a.y - o.y, a.x - o.x);
  sector.end = Math.atan2(b.y - o.y, b.x - o.x);
  let d = sector.end - sector.start;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  sector.anticlockwise = d < 0;
  return sector;
}

/** Whether (x, y) lies inside the sector. */
export function inSector(sc: SwingProjectionSector, x: number, y: number): boolean {
  const dist = Math.hypot(x - sc.cx, y - sc.cy);
  if (dist > sc.r || sc.r === 0) return false;
  let span = sc.end - sc.start;
  while (span > Math.PI) span -= 2 * Math.PI;
  while (span < -Math.PI) span += 2 * Math.PI;
  let t = Math.atan2(y - sc.cy, x - sc.cx) - sc.start;
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return span >= 0 ? t >= 0 && t <= span : t <= 0 && t >= span;
}

const one: string[] = [''];

/** Label box for a leg ending at `p`: above it for an upward leg, else below. */
function labelBox(p: PixelPoint, origin: PixelPoint, w: number, h: number) {
  const above = p.y <= origin.y;
  return { x: p.x - w / 2, y: above ? p.y - h - 6 : p.y + 6, w, h };
}

/** Swing projection: legs origin -> 1 and origin -> 2 with the sector between them. */
export const swingProjection = defineDrawingTool({
  type: 'swing-projection',
  name: 'Swing projection',
  group: 'forecasting',
  creation: { kind: 'points', count: 3 },
  panes: 'main',
  shiftConstraint: 'none',
  defaults: SWING_PROJECTION_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    { kind: 'color', key: 'upFillColor', label: 'Up', inline: 'bg' },
    { kind: 'color', key: 'downFillColor', label: 'Down', inline: 'bg' },
    { kind: 'bool', key: 'showLabels', label: 'Labels', inline: 'labels' },
    { kind: 'color', key: 'labelBackgroundColor', label: 'Background', inline: 'labels' },
    { kind: 'color', key: 'textColor', label: 'Text', inline: 'labels' },
  ],

  render({ ctx, theme }, g, s) {
    if (g.bars.length === 0 || g.points.length < 2) return;
    const pts = g.points;
    const o = pts[0]!;
    const sc = swingProjectionSector(g);
    const d = g.drawing.points;
    if (sc && s.fillBackground) {
      ctx.fillStyle = d[2]!.price >= d[0]!.price ? s.upFillColor : s.downFillColor;
      ctx.beginPath();
      ctx.moveTo(sc.cx, sc.cy);
      ctx.arc(sc.cx, sc.cy, sc.r, sc.start, sc.end, sc.anticlockwise);
      ctx.closePath();
      ctx.fill();
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.beginPath();
    for (let i = 1; i < pts.length; i++) {
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(pts[i]!.x, pts[i]!.y);
    }
    ctx.stroke();
    if (sc) {
      ctx.beginPath();
      ctx.arc(sc.cx, sc.cy, sc.r, sc.start, sc.end, sc.anticlockwise);
      ctx.stroke();
    }
    if (!s.showLabels) return;
    for (let i = 1; i < pts.length; i++) {
      one[0] = priceChangeText(g, d[0]!.price, d[i]!.price);
      const { w, h } = infoLabelSize(ctx, one, theme);
      const r = labelBox(pts[i]!, o, w, h);
      infoLabel(ctx, one, r.x, r.y, theme, s.labelBackgroundColor, s.textColor);
    }
  },

  hitTest(g, s, x, y, tol) {
    if (g.bars.length === 0 || g.points.length < 2) return null;
    const pts = g.points;
    const o = pts[0]!;
    const d = g.drawing.points;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i]!;
      if (lineDistance(x, y, o.x, o.y, p.x, p.y) <= tol + s.lineWidth / 2) return BODY_HIT;
      if (s.showLabels) {
        one[0] = priceChangeText(g, d[0]!.price, d[i]!.price);
        const { w, h } = hitLabelSize(one);
        const r = labelBox(p, o, w, h);
        if (inBox(x, y, r.x, r.y, r.x + r.w, r.y + r.h)) return BODY_HIT;
      }
    }
    const sc = swingProjectionSector(g);
    if (!sc) return null;
    if (Math.abs(Math.hypot(x - sc.cx, y - sc.cy) - sc.r) <= tol + s.lineWidth / 2) {
      const inner = { ...sc, r: sc.r + tol + s.lineWidth };
      if (inSector(inner, x, y)) return BODY_HIT;
    }
    return s.fillBackground && inSector(sc, x, y) ? WEAK_BODY_HIT : null;
  },

  isVisible(g) {
    if (g.bars.length === 0) return false;
    const sc = swingProjectionSector(g);
    if (!sc) return pointsInView(g, g.points);
    // The sector's bounding circle.
    return (
      (sc.cx + sc.r >= -20 &&
        sc.cx - sc.r <= g.width + 20 &&
        sc.cy + sc.r >= -20 &&
        sc.cy - sc.r <= g.height + 20) ||
      pointsInView(g, g.points)
    );
  },
});
