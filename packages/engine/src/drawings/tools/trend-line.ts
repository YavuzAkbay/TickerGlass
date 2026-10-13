import {
  anchorsInView,
  approxTextWidth,
  BODY_HIT,
  extendSegment,
  formatDuration,
  hitRotatedText,
  infoLabel,
  lineDistance,
  setLineStyle,
  TEXT_HIT,
  textFont,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type {
  DrawingGeometry,
  DrawingHandle,
  DrawingLineStyle,
  DrawingPoint,
  PixelPoint,
} from '../types';

const seg = [0, 0, 0, 0];
const TEXT_GAP = 4;

export const TREND_LINE_DEFAULTS = {
  lineColor: '#2962ff',
  lineWidth: 2,
  lineStyle: 'solid' as DrawingLineStyle,
  extendLeft: false,
  extendRight: false,
  showMiddlePoint: false,
  showPriceRange: false,
  showBarsRange: false,
  showAngle: false,
  textColor: '#2962ff',
  fontSize: 14,
  bold: false,
  italic: false,
};

type TrendLineStyle = typeof TREND_LINE_DEFAULTS;

/** Text baseline angle along a->b, kept upright. */
export function textAngle(a: PixelPoint, b: PixelPoint): number {
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  if (angle > Math.PI / 2) angle -= Math.PI;
  else if (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

/** Stats lines for the info label (price range, bars range, angle). */
function statsLines(g: DrawingGeometry, s: TrendLineStyle): string[] {
  const lines: string[] = [];
  const [p0, p1] = g.drawing.points;
  const [a, b] = g.points;
  if (!p0 || !p1 || !a || !b) return lines;
  if (s.showPriceRange) {
    const d = p1.price - p0.price;
    const pct = p0.price !== 0 ? (d / Math.abs(p0.price)) * 100 : NaN;
    const sign = d > 0 ? '+' : '';
    lines.push(`${sign}${g.format.price(d)} (${g.format.percent(pct)})`);
  }
  if (s.showBarsRange) {
    const bars = Math.round((g.logical[1] ?? 0) - (g.logical[0] ?? 0));
    lines.push(`${bars} bars, ${formatDuration(p1.time - p0.time)}`);
  }
  if (s.showAngle) {
    const deg = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI;
    lines.push(`${deg.toFixed(2)}°`);
  }
  return lines;
}

export const trendLine = defineDrawingTool({
  type: 'trend-line',
  name: 'Trend line',
  group: 'lines',
  creation: { kind: 'points', count: 2 },
  defaults: TREND_LINE_DEFAULTS,
  text: { default: '', multiline: false },
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'extendLeft', label: 'Extend left' },
    { kind: 'bool', key: 'extendRight', label: 'Extend right' },
    { kind: 'bool', key: 'showMiddlePoint', label: 'Middle point' },
    { kind: 'bool', key: 'showPriceRange', label: 'Price range', group: 'Stats' },
    { kind: 'bool', key: 'showBarsRange', label: 'Bars range', group: 'Stats' },
    { kind: 'bool', key: 'showAngle', label: 'Angle', group: 'Stats' },
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
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

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (s.showMiddlePoint) {
      ctx.fillStyle = s.lineColor;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(3, s.lineWidth + 1), 0, Math.PI * 2);
      ctx.fill();
    }
    const text = g.drawing.text;
    if (text) {
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(textAngle(a, b));
      ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
      ctx.fillStyle = s.textColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(text, 0, -TEXT_GAP - s.lineWidth / 2);
      ctx.restore();
    }
    if (s.showPriceRange || s.showBarsRange || s.showAngle) {
      const lines = statsLines(g, s);
      if (lines.length) {
        const x = Math.min(Math.max(4, b.x + 10), g.width - 160);
        const y = Math.min(Math.max(4, b.y + 10), g.height - 70);
        infoLabel(ctx, lines, x, y, theme);
      }
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const text = g.drawing.text;
    if (text) {
      const off = TEXT_GAP + s.lineWidth / 2;
      const angle = textAngle(a, b);
      const cx = (a.x + b.x) / 2 + Math.sin(angle) * off;
      const cy = (a.y + b.y) / 2 - Math.cos(angle) * off;
      const w = approxTextWidth(text, s.fontSize);
      if (hitRotatedText(x, y, cx, cy, angle, w, s.fontSize * 1.2)) return TEXT_HIT;
    }
    const d = lineDistance(x, y, a.x, a.y, b.x, b.y, s.extendLeft, s.extendRight);
    return d <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  handles(g, s) {
    const [a, b] = g.points;
    if (!a || !b) return [];
    const hs: DrawingHandle[] = [
      { x: a.x, y: a.y },
      { x: b.x, y: b.y },
    ];
    // Derived handle: dragging the middle point moves the whole line.
    if (s.showMiddlePoint) hs.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, cursor: 'move' });
    return hs;
  },

  moveHandle({ start, handle, target, x, y, geometry: g }) {
    if (handle < 2) {
      const pts = start.map((p) => ({ ...p }));
      pts[handle] = target;
      return pts;
    }
    const px = start.map((p) => g.toPixel(p));
    const ls = px.map((p) => g.xToLogical(p.x));
    const midL = ((ls[0] ?? 0) + (ls[1] ?? 0)) / 2;
    const midY = ((px[0]?.y ?? 0) + (px[1]?.y ?? 0)) / 2;
    const dl = Math.round(g.xToLogical(x) - midL);
    const dy = y - midY;
    return px.map((p, i): DrawingPoint => g.toPoint(g.logicalToX((ls[i] ?? 0) + dl), p.y + dy));
  },

  isVisible(g, s) {
    return s.extendLeft || s.extendRight || anchorsInView(g);
  },
});
