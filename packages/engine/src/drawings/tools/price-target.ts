// Price target: source (time, price) -> target (time, price), evaluated against
// the bars that follow the source.
//
// Status (bars after the source bar up to the target bar, inclusive):
// - success: some bar reaches the target price (high >= target for an upward
//   price target, low <= target for a downward one) — shown as soon as it happens;
// - failure: the data reaches the target bar and no bar did;
// - pending: otherwise (also while the target is not after the source).
import {
  BODY_HIT,
  formatDuration,
  hitLabelSize,
  infoLabel,
  infoLabelSize,
  inBox,
  lineDistance,
  priceChangeText,
  segmentInView,
  setLineStyle,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingBarData, DrawingGeometry, DrawingLineStyle } from '../types';

export const PRICE_TARGET_DEFAULTS = {
  /** Line and pending label; also the handle colour. */
  lineColor: '#6E9BD6',
  lineWidth: 2,
  lineStyle: 'solid' as DrawingLineStyle,
  successColor: '#7FB069',
  failureColor: '#DE6A4F',
  textColor: '#ffffff',
  showLabel: true,
};

type PriceTargetStyle = typeof PRICE_TARGET_DEFAULTS;

export type PriceTargetStatus = 'pending' | 'success' | 'failure';

export interface PriceTargetResult {
  status: PriceTargetStatus;
  /** Bar that reached the target (success), else -1. */
  hitBar: number;
}

/**
 * Status of a price target from bar `from` at `sourcePrice` to `target` by bar
 * `to` (whole logical indices), evaluated on `bars`.
 */
export function priceTargetResult(
  bars: DrawingBarData,
  from: number,
  to: number,
  sourcePrice: number,
  target: number,
): PriceTargetResult {
  if (!(to > from)) return { status: 'pending', hitBar: -1 };
  const up = target >= sourcePrice;
  const last = Math.min(to, bars.length - 1);
  for (let i = Math.max(0, from + 1); i <= last; i++) {
    if (up ? bars.high[i]! >= target : bars.low[i]! <= target)
      return { status: 'success', hitBar: i };
  }
  return { status: bars.length - 1 >= to ? 'failure' : 'pending', hitBar: -1 };
}

const STATUS_TEXT: Record<PriceTargetStatus, string> = {
  pending: '',
  success: 'Success',
  failure: 'Failure',
};

interface PriceTargetLayout {
  result: PriceTargetResult;
  color: string;
  lines: string[];
  above: boolean;
}

const lines: string[] = [];
const L: PriceTargetLayout = {
  result: { status: 'pending', hitBar: -1 },
  color: '',
  lines,
  above: true,
};

/** Status, colour and label lines (shared object), or null without two anchors or bars. */
export function priceTargetLayout(
  g: DrawingGeometry,
  s: PriceTargetStyle,
): PriceTargetLayout | null {
  const [p0, p1] = g.drawing.points;
  const [l0, l1] = g.logical;
  if (!p0 || !p1 || l0 === undefined || l1 === undefined || g.bars.length === 0) return null;
  if (!Number.isFinite(l0) || !Number.isFinite(l1)) return null;
  const from = Math.round(l0);
  const to = Math.round(l1);
  L.result = priceTargetResult(g.bars, from, to, p0.price, p1.price);
  L.color =
    L.result.status === 'success'
      ? s.successColor
      : L.result.status === 'failure'
        ? s.failureColor
        : s.lineColor;
  lines.length = 0;
  lines.push(priceChangeText(g, p0.price, p1.price));
  lines.push(`${to - from} bars, ${formatDuration(p1.time - p0.time)}`);
  const st = STATUS_TEXT[L.result.status];
  if (st) lines.push(st);
  L.above = p1.price >= p0.price;
  return L;
}

const LABEL_GAP = 8;

function labelBox(g: DrawingGeometry, w: number, h: number, above: boolean) {
  const t = g.points[1]!;
  return { x: t.x + LABEL_GAP, y: above ? t.y - h - LABEL_GAP : t.y + LABEL_GAP, w, h };
}

/** Line from the source to the target, dots, change/bars/time label coloured by status. */
export const priceTarget = defineDrawingTool({
  type: 'price-target',
  name: 'Price target',
  group: 'forecasting',
  creation: { kind: 'points', count: 2 },
  panes: 'main',
  shiftConstraint: 'none',
  defaults: PRICE_TARGET_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'color', key: 'successColor', label: 'Success', inline: 'status' },
    { kind: 'color', key: 'failureColor', label: 'Failure', inline: 'status' },
    { kind: 'bool', key: 'showLabel', label: 'Label', inline: 'label' },
    { kind: 'color', key: 'textColor', label: 'Text', inline: 'label' },
  ],

  render({ ctx, theme }, g, s) {
    const f = priceTargetLayout(g, s);
    if (!f) return;
    const a = g.points[0]!;
    const b = g.points[1]!;
    setLineStyle(ctx, f.color, s.lineWidth, s.lineStyle);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.fillStyle = f.color;
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3 + s.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    if (f.result.hitBar >= 0) {
      // Where the target was reached.
      setLineStyle(ctx, f.color, 1, 'solid');
      ctx.beginPath();
      ctx.arc(g.logicalToX(f.result.hitBar), b.y, 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.showLabel) {
      const { w, h } = infoLabelSize(ctx, f.lines, theme);
      const r = labelBox(g, w, h, f.above);
      infoLabel(ctx, f.lines, r.x, r.y, theme, f.color, s.textColor);
    }
  },

  hitTest(g, s, x, y, tol) {
    const f = priceTargetLayout(g, s);
    if (!f) return null;
    const a = g.points[0]!;
    const b = g.points[1]!;
    if (lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2 + 2) return BODY_HIT;
    if (s.showLabel) {
      const { w, h } = hitLabelSize(f.lines);
      const r = labelBox(g, w, h, f.above);
      if (inBox(x, y, r.x, r.y, r.x + r.w, r.y + r.h)) return BODY_HIT;
    }
    return null;
  },

  isVisible(g, s) {
    if (g.bars.length === 0 || g.points.length < 2) return false;
    const a = g.points[0]!;
    const b = g.points[1]!;
    // The label sits right of the target.
    if (s.showLabel && b.x <= g.width && b.x >= -250) return true;
    return segmentInView(a.x, a.y, b.x, b.y, false, false, g.width, g.height);
  },
});
