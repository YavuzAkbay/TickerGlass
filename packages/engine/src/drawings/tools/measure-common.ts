// Measure tools: Price measure, Time measure, Price & time measure (2 anchors, filled box + arrows + stats label).
import {
  arrowHead,
  BODY_HIT,
  boxEdgeDistance,
  clamp,
  formatDuration,
  inBox,
  infoLabel,
  infoLabelSize,
  setLineStyle,
} from '../draw-utils';
import { formatVolume } from '../../scale/price-ticks';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingToolDefinition } from '../types';

export type MeasureKind = 'price' | 'date' | 'date-price';

export const MEASURE_DEFAULTS = {
  /** Arrows and edges; also the handle colour. */
  lineColor: '#4f6bed',
  lineWidth: 1,
  fillBackground: true,
  backgroundColor: 'rgba(79, 107, 237, 0.12)',
  showBorder: false,
  borderColor: '#4f6bed',
  labelBackgroundColor: 'rgba(79, 107, 237, 0.9)',
  textColor: '#ffffff',
};

export type MeasureStyle = typeof MEASURE_DEFAULTS;

export interface MeasureStats {
  /** p1.price - p0.price. */
  priceChange: number;
  /** Change in % of |p0.price| (NaN when 0). */
  percent: number;
  /** Whole bars from anchor 0 to anchor 1 (signed). */
  bars: number;
  /** p1.time - p0.time (signed seconds). */
  seconds: number;
  /** Volume of the displayed bars between the anchors (inclusive); NaN without volume data. */
  volume: number;
}

const stats: MeasureStats = { priceChange: 0, percent: 0, bars: 0, seconds: 0, volume: NaN };

/** Sum of volume over displayed bars [from, to] (clamped); NaN when no bar has volume. */
export function rangeVolume(g: DrawingGeometry, from: number, to: number): number {
  const b = g.bars;
  const lo = Math.max(0, Math.ceil(Math.min(from, to) - 1e-9));
  const hi = Math.min(b.length - 1, Math.floor(Math.max(from, to) + 1e-9));
  let sum = 0;
  let any = false;
  for (let i = lo; i <= hi; i++) {
    const v = b.volume[i]!;
    if (v === v) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : NaN;
}

/** Stats of anchors 0 -> 1 (reused object), or null with fewer than two anchors. */
export function measureStats(g: DrawingGeometry): MeasureStats | null {
  const [p0, p1] = g.drawing.points;
  if (!p0 || !p1) return null;
  stats.priceChange = p1.price - p0.price;
  stats.percent = p0.price !== 0 ? (stats.priceChange / Math.abs(p0.price)) * 100 : NaN;
  stats.bars = Math.round((g.logical[1] ?? 0) - (g.logical[0] ?? 0));
  stats.seconds = p1.time - p0.time;
  stats.volume = rangeVolume(g, Math.round(g.logical[0] ?? NaN), Math.round(g.logical[1] ?? NaN));
  return stats;
}

const lines: string[] = [];

/** Label lines for a kind (shared buffer). */
export function measureLines(g: DrawingGeometry, kind: MeasureKind): string[] {
  lines.length = 0;
  const st = measureStats(g);
  if (!st) return lines;
  if (kind !== 'date')
    lines.push(
      `${st.priceChange > 0 ? '+' : ''}${g.format.price(st.priceChange)} (${g.format.percent(st.percent)})`,
    );
  if (kind !== 'price') {
    lines.push(`${st.bars} bars, ${formatDuration(st.seconds)}`);
    if (st.volume === st.volume) lines.push(`Vol ${formatVolume(st.volume)}`);
  }
  return lines;
}

const NAMES: Record<MeasureKind, [string, string]> = {
  price: ['price-measure', 'Price measure'],
  date: ['time-measure', 'Time measure'],
  'date-price': ['price-time-measure', 'Price & time measure'],
};

/** Tool definition for one measure kind. */
export function measureTool(kind: MeasureKind): DrawingToolDefinition<MeasureStyle> {
  const [type, name] = NAMES[kind];
  const vArrow = kind !== 'date';
  const hArrow = kind !== 'price';
  return defineDrawingTool({
    type,
    name,
    group: 'forecasting',
    creation: { kind: 'points', count: 2 },
    shiftConstraint: 'none',
    defaults: MEASURE_DEFAULTS,
    properties: [
      { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
      { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
      { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
      { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
      { kind: 'bool', key: 'showBorder', label: 'Border', inline: 'border' },
      { kind: 'color', key: 'borderColor', label: 'Color', inline: 'border' },
      { kind: 'color', key: 'labelBackgroundColor', label: 'Label background', inline: 'label' },
      { kind: 'color', key: 'textColor', label: 'Text', inline: 'label' },
    ],

    render({ ctx, theme }, g, s) {
      const [a, b] = g.points;
      if (!a || !b) return;
      const l = Math.min(a.x, b.x);
      const r = Math.max(a.x, b.x);
      const t = Math.min(a.y, b.y);
      const bt = Math.max(a.y, b.y);
      if (s.fillBackground) {
        ctx.fillStyle = s.backgroundColor;
        ctx.fillRect(l, t, r - l, bt - t);
      }
      if (s.showBorder) {
        setLineStyle(ctx, s.borderColor, s.lineWidth, 'solid');
        ctx.strokeRect(l, t, r - l, bt - t);
      }
      setLineStyle(ctx, s.lineColor, s.lineWidth, 'solid');
      ctx.beginPath();
      // Edge lines perpendicular to the measured axis.
      if (vArrow && !hArrow) {
        ctx.moveTo(l, a.y);
        ctx.lineTo(r, a.y);
        ctx.moveTo(l, b.y);
        ctx.lineTo(r, b.y);
      } else if (hArrow && !vArrow) {
        ctx.moveTo(a.x, t);
        ctx.lineTo(a.x, bt);
        ctx.moveTo(b.x, t);
        ctx.lineTo(b.x, bt);
      }
      const mx = (l + r) / 2;
      const my = (t + bt) / 2;
      if (vArrow) {
        ctx.moveTo(mx, a.y);
        ctx.lineTo(mx, b.y);
      }
      if (hArrow) {
        ctx.moveTo(a.x, my);
        ctx.lineTo(b.x, my);
      }
      ctx.stroke();
      const size = 5 + s.lineWidth * 2;
      if (vArrow && Math.abs(b.y - a.y) > size) arrowHead(ctx, mx, a.y, mx, b.y, size);
      if (hArrow && Math.abs(b.x - a.x) > size) arrowHead(ctx, a.x, my, b.x, my, size);

      const ls = measureLines(g, kind);
      if (!ls.length) return;
      const { w, h } = infoLabelSize(ctx, ls, theme);
      // Beyond the end anchor's edge: below when measuring down (or sideways), above when up.
      const up = b.y < a.y;
      const x = clamp(mx - w / 2, 2, Math.max(2, g.width - w - 2));
      const y = clamp(up ? t - h - 6 : bt + 6, 2, Math.max(2, g.height - h - 2));
      infoLabel(ctx, ls, x, y, theme, s.labelBackgroundColor, s.textColor);
    },

    hitTest(g, s, x, y, tol) {
      const [a, b] = g.points;
      if (!a || !b) return null;
      if (boxEdgeDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2) return BODY_HIT;
      // The measured area is grabbable (strong), like a rectangle.
      return inBox(x, y, a.x, a.y, b.x, b.y) ? BODY_HIT : null;
    },
  });
}
