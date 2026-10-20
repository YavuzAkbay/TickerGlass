import { approxTextWidth, BODY_HIT, setLineStyle, textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import { TREND_LINE_DEFAULTS, trendLine } from './trend-line';

/** Max arc radius (px); shorter lines get an arc of their own length. */
const ARC_RADIUS = 40;
const LABEL_GAP = 8;

export const TREND_ANGLE_DEFAULTS = { ...TREND_LINE_DEFAULTS, angleFontSize: 12 };

type TrendAngleStyle = typeof TREND_ANGLE_DEFAULTS;

/**
 * Screen angle of anchors 0 -> 1 in degrees, counter-clockwise from the +x
 * axis (up is positive), in (-180, 180]. Pixel space: changes
 * with zoom and price scaling. NaN with fewer than two anchors.
 */
export function trendAngleDegrees(g: DrawingGeometry): number {
  const [a, b] = g.points;
  if (!a || !b) return NaN;
  return (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
}

/** Angle label text, e.g. "38.66°". */
export function trendAngleText(deg: number): string {
  return `${deg.toFixed(2)}°`;
}

const label = { x: 0, y: 0, r: 0 };

/** Arc radius and the label's left-middle point (outside the arc, at half the angle). */
function labelAt(g: DrawingGeometry): typeof label | null {
  const [a, b] = g.points;
  if (!a || !b) return null;
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return null;
  const half = Math.atan2(b.y - a.y, b.x - a.x) / 2;
  label.r = Math.min(ARC_RADIUS, len);
  label.x = a.x + (label.r + LABEL_GAP) * Math.cos(half);
  label.y = a.y + (label.r + LABEL_GAP) * Math.sin(half);
  return label;
}

/**
 * Trend line with its screen angle: a dotted horizontal reference from anchor
 * 0, an arc from it to the line and the angle in degrees. Shift snaps to 45°.
 */
export const trendAngle = defineDrawingTool({
  ...trendLine,
  type: 'trend-angle',
  name: 'Trend angle',
  defaults: TREND_ANGLE_DEFAULTS,
  shiftConstraint: 'angle',
  properties: [
    ...trendLine.properties.filter((p) => p.key !== 'showAngle'),
    { kind: 'fontSize', key: 'angleFontSize', label: 'Angle label', group: 'Stats' },
  ],

  render(rc, g, s: TrendAngleStyle, state) {
    trendLine.render(rc, g, s, state);
    const { ctx, theme } = rc;
    const [a, b] = g.points;
    const l = labelAt(g);
    if (!a || !b || !l) return;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    setLineStyle(ctx, s.lineColor, 1, 'dotted');
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(a.x + Math.max(len, l.r), a.y);
    ctx.stroke();
    setLineStyle(ctx, s.lineColor, 1, 'solid');
    ctx.beginPath();
    ctx.arc(a.x, a.y, l.r, 0, angle, angle < 0);
    ctx.stroke();
    ctx.font = textFont(theme, s.angleFontSize);
    ctx.fillStyle = s.lineColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(trendAngleText(trendAngleDegrees(g)), l.x, l.y);
  },

  hitTest(g, s: TrendAngleStyle, x, y, tol) {
    const hit = trendLine.hitTest(g, s, x, y, tol);
    if (hit) return hit;
    const l = labelAt(g);
    if (!l) return null;
    const w = approxTextWidth(trendAngleText(trendAngleDegrees(g)), s.angleFontSize);
    const h = s.angleFontSize * 1.2;
    return x >= l.x && x <= l.x + w && Math.abs(y - l.y) <= h / 2 ? BODY_HIT : null;
  },
});
