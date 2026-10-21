import {
  anchorsInView,
  segmentInView,
  BODY_HIT,
  clamp,
  extendSegment,
  formatDuration,
  hitLabelSize,
  infoLabel,
  infoLabelSize,
  lineDistance,
  priceChangeText,
  setLineStyle,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingLineStyle } from '../types';

const seg = [0, 0, 0, 0];
const lines: string[] = [];

export const MEASURED_LINE_DEFAULTS = {
  lineColor: '#6E9BD6',
  lineWidth: 2,
  lineStyle: 'solid' as DrawingLineStyle,
  extendLeft: false,
  extendRight: false,
  showPriceRange: true,
  showPercentChange: true,
  showBarsRange: true,
  showDateTimeRange: true,
  showDistance: true,
  showAngle: true,
  labelBackgroundColor: 'rgba(110, 155, 214, 0.85)',
  textColor: '#ffffff',
};

type MeasuredLineStyle = typeof MEASURED_LINE_DEFAULTS;

/** Measurements of a 2-anchor line. */
export interface LineStats {
  /** p1.price - p0.price (pane units). */
  priceChange: number;
  /** Change in % of |p0.price| (NaN when p0.price is 0). */
  percent: number;
  /** Whole bars from anchor 0 to anchor 1 (signed). */
  bars: number;
  /** p1.time - p0.time (signed seconds). */
  seconds: number;
  /** Screen angle in degrees, counter-clockwise from the +x axis (up is positive). */
  angle: number;
  /** Pixel length. */
  distance: number;
}

const stats: LineStats = { priceChange: 0, percent: 0, bars: 0, seconds: 0, angle: 0, distance: 0 };

/** Stats of anchors 0 -> 1 (reused object), or null with fewer than two anchors. */
export function lineStats(g: DrawingGeometry): LineStats | null {
  const [p0, p1] = g.drawing.points;
  const [a, b] = g.points;
  if (!p0 || !p1 || !a || !b) return null;
  stats.priceChange = p1.price - p0.price;
  stats.percent = p0.price !== 0 ? (stats.priceChange / Math.abs(p0.price)) * 100 : NaN;
  stats.bars = Math.round((g.logical[1] ?? 0) - (g.logical[0] ?? 0));
  stats.seconds = p1.time - p0.time;
  stats.angle = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
  stats.distance = Math.hypot(b.x - a.x, b.y - a.y);
  return stats;
}

/** Info label lines for the enabled stats (shared buffer). */
function infoLines(g: DrawingGeometry, s: MeasuredLineStyle): string[] {
  lines.length = 0;
  const st = lineStats(g);
  const [p0, p1] = g.drawing.points;
  if (!st || !p0 || !p1) return lines;
  if (s.showPriceRange && s.showPercentChange) lines.push(priceChangeText(g, p0.price, p1.price));
  else if (s.showPriceRange)
    lines.push(`${st.priceChange > 0 ? '+' : ''}${g.format.price(st.priceChange)}`);
  else if (s.showPercentChange) lines.push(g.format.percent(st.percent));
  if (s.showBarsRange && s.showDateTimeRange)
    lines.push(`${st.bars} bars, ${formatDuration(st.seconds)}`);
  else if (s.showBarsRange) lines.push(`${st.bars} bars`);
  else if (s.showDateTimeRange) lines.push(formatDuration(st.seconds));
  if (s.showDistance && s.showAngle)
    lines.push(`Distance: ${Math.round(st.distance)} px, ${st.angle.toFixed(2)}°`);
  else if (s.showDistance) lines.push(`Distance: ${Math.round(st.distance)} px`);
  else if (s.showAngle) lines.push(`${st.angle.toFixed(2)}°`);
  return lines;
}

const pos = { x: 0, y: 0 };

/** Label top-left: below the line's midpoint (above when it goes down), inside the pane. */
function labelPos(g: DrawingGeometry, w: number, h: number): typeof pos | null {
  const [a, b] = g.points;
  if (!a || !b) return null;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  pos.x = clamp(mx - w / 2, 4, Math.max(4, g.width - w - 4));
  pos.y = clamp(b.y >= a.y ? my - h - 12 : my + 12, 4, Math.max(4, g.height - h - 4));
  return pos;
}

/** Trend line with an always-on measurement label (price, %, bars, time, distance, angle). */
export const measuredLine = defineDrawingTool({
  type: 'measured-line',
  name: 'Measured line',
  group: 'lines',
  creation: { kind: 'points', count: 2 },
  defaults: MEASURED_LINE_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'extendLeft', label: 'Extend left' },
    { kind: 'bool', key: 'extendRight', label: 'Extend right' },
    { kind: 'bool', key: 'showPriceRange', label: 'Price range', group: 'Info' },
    { kind: 'bool', key: 'showPercentChange', label: 'Percent change', group: 'Info' },
    { kind: 'bool', key: 'showBarsRange', label: 'Bars range', group: 'Info' },
    { kind: 'bool', key: 'showDateTimeRange', label: 'Date/time range', group: 'Info' },
    { kind: 'bool', key: 'showDistance', label: 'Distance', group: 'Info' },
    { kind: 'bool', key: 'showAngle', label: 'Angle', group: 'Info' },
    {
      kind: 'color',
      key: 'labelBackgroundColor',
      label: 'Background',
      group: 'Label',
      inline: 'label',
    },
    { kind: 'color', key: 'textColor', label: 'Text', group: 'Label', inline: 'label' },
  ],

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    extendSegment(a.x, a.y, b.x, b.y, s.extendLeft, s.extendRight, g.width, g.height, seg);
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(seg[0]!, seg[1]!);
    ctx.lineTo(seg[2]!, seg[3]!);
    ctx.stroke();
    const ls = infoLines(g, s);
    if (!ls.length) return;
    const { w, h } = infoLabelSize(ctx, ls, theme);
    const r = labelPos(g, w, h);
    if (r) infoLabel(ctx, ls, r.x, r.y, theme, s.labelBackgroundColor, s.textColor);
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const d = lineDistance(x, y, a.x, a.y, b.x, b.y, s.extendLeft, s.extendRight);
    if (d <= tol + s.lineWidth / 2) return BODY_HIT;
    // The stats label is part of the drawing (grab to drag, right-click for the menu).
    const ls = infoLines(g, s);
    if (!ls.length) return null;
    const { w, h } = hitLabelSize(ls);
    const r = labelPos(g, w, h);
    return r && x >= r.x && x <= r.x + w && y >= r.y && y <= r.y + h ? BODY_HIT : null;
  },

  isVisible(g, s) {
    const [a, b] = g.points;
    if (!a || !b) return anchorsInView(g);
    // The label is clamped into the pane, so a line in view always shows it.
    return segmentInView(a.x, a.y, b.x, b.y, s.extendLeft, s.extendRight, g.width, g.height);
  },
});
