// Bars pattern: copies the bars between anchors 0 and 1 (inclusive) to a copy
// origin (anchor 2: the first copied bar's slot and open price). Reads g.bars
// live, so the copy follows data updates of the source range.
//
// Mirror reverses the bars in time (open/close swap); flip reflects prices
// around the first copied bar's open (high/low swap). Created from two clicks:
// `completePoints` puts the origin one bar after the range at the last
// source close (the copy continues the source).
import { BODY_HIT, inBox, setLineStyle, WEAK_BODY_HIT } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { polylineDistance } from '../shape-utils';
import type { DrawingGeometry, DrawingPoint, PixelPoint } from '../types';

export type BarsPatternMode = 'hl' | 'oc' | 'line' | 'candles';

export const BARS_PATTERN_DEFAULTS = {
  /** Copied bars; also the handle colour. */
  lineColor: '#2962ff',
  mode: 'hl' as BarsPatternMode,
  mirrored: false,
  flipped: false,
};

type BarsPatternStyle = typeof BARS_PATTERN_DEFAULTS;

/** Copied bars cap. */
const MAX_BARS = 5000;

export interface PatternBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Source bar range [lo, hi] of anchors 0 and 1 clamped to the data, or null. */
export function sourceRange(g: DrawingGeometry): [number, number] | null {
  const [l0, l1] = g.logical;
  if (l0 === undefined || l1 === undefined || !Number.isFinite(l0) || !Number.isFinite(l1))
    return null;
  const lo = Math.max(0, Math.round(Math.min(l0, l1)));
  const hi = Math.min(g.bars.length - 1, Math.round(Math.max(l0, l1)), lo + MAX_BARS - 1);
  return lo <= hi ? [lo, hi] : null;
}

const copy: PatternBar[] = [];

/**
 * Bars of the source range transformed for the copy, shifted so the first
 * open equals `originPrice` (shared buffer).
 */
export function patternBars(
  g: DrawingGeometry,
  s: Pick<BarsPatternStyle, 'mirrored' | 'flipped'>,
  originPrice: number,
): PatternBar[] {
  copy.length = 0;
  const r = sourceRange(g);
  if (!r) return copy;
  const [lo, hi] = r;
  const b = g.bars;
  const first = s.mirrored ? hi : lo;
  const ref = s.mirrored ? b.close[first]! : b.open[first]!;
  const shift = originPrice - ref;
  const tf = (v: number) => (s.flipped ? 2 * ref - v : v) + shift;
  for (let k = 0; k <= hi - lo; k++) {
    const j = s.mirrored ? hi - k : lo + k;
    const o = s.mirrored ? b.close[j]! : b.open[j]!;
    const c = s.mirrored ? b.open[j]! : b.close[j]!;
    const h = b.high[j]!;
    const l = b.low[j]!;
    copy.push({
      open: tf(o),
      close: tf(c),
      high: s.flipped ? tf(l) : tf(h),
      low: s.flipped ? tf(h) : tf(l),
    });
  }
  return copy;
}

/** Copy origin: anchor 2, or (draft) one bar after the range at the last source close. */
function origin(g: DrawingGeometry): { logical: number; price: number } | null {
  const p2 = g.drawing.points[2];
  const l2 = g.logical[2];
  if (p2 && l2 !== undefined && Number.isFinite(l2))
    return { logical: Math.round(l2), price: p2.price };
  const r = sourceRange(g);
  if (!r) return null;
  return { logical: r[1] + 1, price: g.bars.close[r[1]]! };
}

interface Layout {
  bars: PatternBar[];
  x0: number;
  step: number;
}
const L: Layout = { bars: copy, x0: 0, step: 0 };

function layoutOf(g: DrawingGeometry, s: BarsPatternStyle): Layout | null {
  if (g.bars.length === 0) return null;
  const o = origin(g);
  if (!o) return null;
  const bars = patternBars(g, s, o.price);
  if (bars.length === 0) return null;
  L.bars = bars;
  L.x0 = g.logicalToX(o.logical);
  L.step = g.logicalToX(o.logical + 1) - L.x0;
  return L;
}

const linePts: PixelPoint[] = [];

function closeLine(g: DrawingGeometry, l: Layout): PixelPoint[] {
  linePts.length = 0;
  for (let k = 0; k < l.bars.length; k++)
    linePts.push({ x: l.x0 + k * l.step, y: g.priceToY(l.bars[k]!.close) });
  return linePts;
}

/** Copy's [top, bottom] y and the price span of the source (selection outline). */
function copyBounds(g: DrawingGeometry, l: Layout): { l: number; r: number; t: number; b: number } {
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of l.bars) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  const xe = l.x0 + (l.bars.length - 1) * l.step;
  const half = Math.max(1, l.step / 2);
  return {
    l: Math.min(l.x0, xe) - half,
    r: Math.max(l.x0, xe) + half,
    t: g.priceToY(hi),
    b: g.priceToY(lo),
  };
}

/** A copy of the source range's bars drawn at the copy origin. */
export const barsPattern = defineDrawingTool({
  type: 'bars-pattern',
  name: 'Bars pattern',
  group: 'forecasting',
  creation: { kind: 'points', count: 2 },
  panes: 'main',
  shiftConstraint: 'none',
  defaults: BARS_PATTERN_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Color' },
    {
      kind: 'enum',
      key: 'mode',
      label: 'Mode',
      options: ['hl', 'oc', 'line', 'candles'],
      labels: ['HL bars', 'OC bars', 'Line - close', 'Candles'],
    },
    { kind: 'bool', key: 'mirrored', label: 'Mirrored', inline: 'tf' },
    { kind: 'bool', key: 'flipped', label: 'Flipped', inline: 'tf' },
  ],

  render({ ctx }, g, s, state) {
    const l = layoutOf(g, s);
    if (!l) return;
    if (state.selected || state.editing) {
      // Source range outline.
      const r = sourceRange(g)!;
      let hi = -Infinity;
      let lo = Infinity;
      for (let i = r[0]; i <= r[1]; i++) {
        hi = Math.max(hi, g.bars.high[i]!);
        lo = Math.min(lo, g.bars.low[i]!);
      }
      setLineStyle(ctx, s.lineColor, 1, 'dashed');
      const x0 = g.logicalToX(r[0]);
      const x1 = g.logicalToX(r[1]);
      ctx.strokeRect(x0, g.priceToY(hi), x1 - x0, g.priceToY(lo) - g.priceToY(hi));
    }
    setLineStyle(ctx, s.lineColor, 1, 'solid');
    if (s.mode === 'line') {
      const pts = closeLine(g, l);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      return;
    }
    const bodyW = Math.max(1, Math.abs(l.step) * 0.6);
    ctx.fillStyle = s.lineColor;
    ctx.beginPath();
    for (let k = 0; k < l.bars.length; k++) {
      const b = l.bars[k]!;
      const x = l.x0 + k * l.step;
      if (x < -bodyW || x > g.width + bodyW) continue;
      const yo = g.priceToY(b.open);
      const yc = g.priceToY(b.close);
      if (s.mode === 'oc') {
        ctx.moveTo(x, yo);
        ctx.lineTo(x, yc);
        continue;
      }
      ctx.moveTo(x, g.priceToY(b.high));
      ctx.lineTo(x, g.priceToY(b.low));
      if (s.mode === 'candles') {
        // Up hollow, down filled.
        const top = Math.min(yo, yc);
        const h = Math.max(1, Math.abs(yc - yo));
        if (b.close >= b.open) ctx.rect(x - bodyW / 2, top, bodyW, h);
        else ctx.fillRect(x - bodyW / 2, top, bodyW, h);
      }
    }
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const l = layoutOf(g, s);
    if (!l) return null;
    if (s.mode === 'line') {
      if (polylineDistance(closeLine(g, l), x, y) <= tol + 0.5) return BODY_HIT;
    } else if (l.step !== 0) {
      const k = Math.round((x - l.x0) / l.step);
      const half = Math.max(tol, (Math.abs(l.step) * 0.6) / 2);
      for (let i = k - 1; i <= k + 1; i++) {
        const b = l.bars[i];
        if (!b) continue;
        const bx = l.x0 + i * l.step;
        const lo = s.mode === 'oc' ? Math.min(b.open, b.close) : b.low;
        const hi = s.mode === 'oc' ? Math.max(b.open, b.close) : b.high;
        if (inBox(x, y, bx - half, g.priceToY(hi), bx + half, g.priceToY(lo), tol)) return BODY_HIT;
      }
    }
    const bb = copyBounds(g, l);
    return inBox(x, y, bb.l, bb.t, bb.r, bb.b) ? WEAK_BODY_HIT : null;
  },

  completePoints(points, g) {
    const out = points.map((p) => ({ ...p }));
    if (points.length >= 3) return out;
    const r = g.bars.length > 0 ? sourceRange(g) : null;
    if (!r || out.length < 2) return out;
    const price = g.bars.close[r[1]]!;
    const at: DrawingPoint = g.toPoint(g.logicalToX(r[1] + 1), g.priceToY(price));
    out.push({ ...at, price });
    return out;
  },

  priceAxisLabels(d, s, state) {
    const p = d.points[2];
    return p && (state.selected || state.editing) ? [{ value: p.price, color: s.lineColor }] : [];
  },

  isVisible(g, s) {
    const l = layoutOf(g, s);
    if (!l) return false;
    const bb = copyBounds(g, l);
    const r = sourceRange(g)!;
    const sl = g.logicalToX(r[0]);
    const sr = g.logicalToX(r[1]);
    const copyIn = bb.r >= -20 && bb.l <= g.width + 20 && bb.b >= -20 && bb.t <= g.height + 20;
    return copyIn || (sr >= -20 && sl <= g.width + 20);
  },
});
