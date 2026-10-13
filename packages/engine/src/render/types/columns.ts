import type { ColumnStyle, HighLowStyle, OhlcvSource } from '../../chart-types';
import { font } from '../draw';
import type { SeriesRenderContext } from '../series';
import { bodyWidth, isUp, sourceValue, thinWidth } from './common';

const COLUMN_RATIO = 0.6;
const HIGH_LOW_RATIO = 0.75;
/** Gap between a high/low box and its label, css px. */
const LABEL_GAP = 3;

/** Columns from the pane bottom up to the source value, two colour passes. */
export function drawColumns(rc: SeriesRenderContext, data: OhlcvSource, style: ColumnStyle): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  const lo = Math.max(0, rc.from);
  const hi = Math.min(data.length - 1, rc.to);
  if (lo > hi) return;
  const bottom = Math.round(rc.height * dpr);
  const w = Math.max(1, Math.round(ts.barSpacing * dpr * COLUMN_RATIO));
  const half = w >> 1;
  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 0;
    ctx.fillStyle = up ? style.upColor : style.downColor;
    for (let i = lo; i <= hi; i++) {
      if (isUp(data, i, style.colorByPrevClose) !== up) continue;
      const v = sourceValue(data, i, style.source);
      if (!Number.isFinite(v)) continue;
      const xc = Math.round(ts.indexToX(i) * dpr);
      const y = Math.min(bottom, Math.round(ps.priceToY(v) * dpr));
      ctx.fillRect(xc - half, y, w, Math.max(1, bottom - y));
    }
  }
}

/** Decimals for labels, from the visible price span (about 1/100 of it). */
function labelDecimals(rc: SeriesRenderContext): number {
  const ps = rc.priceScale;
  const span = Math.abs(ps.yToPrice(0) - ps.yToPrice(rc.height));
  if (!(span > 0) || !Number.isFinite(span)) return 2;
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(span / 100))));
}

/** High-low boxes with border; optional high/low price labels when they fit. */
export function drawHighLow(rc: SeriesRenderContext, data: OhlcvSource, style: HighLowStyle): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps, theme } = rc;
  const lo = Math.max(0, rc.from);
  const hi = Math.min(data.length - 1, rc.to);
  if (lo > hi) return;
  const { high, low } = data;
  const line = thinWidth(dpr);
  const w = bodyWidth(ts.barSpacing * dpr, HIGH_LOW_RATIO);

  if (w < 3) {
    ctx.fillStyle = style.borderColor;
    for (let i = lo; i <= hi; i++) {
      const xc = Math.round(ts.indexToX(i) * dpr);
      const yh = Math.round(ps.priceToY(high[i]!) * dpr);
      const yl = Math.round(ps.priceToY(low[i]!) * dpr);
      ctx.fillRect(xc - (line >> 1), Math.min(yh, yl), line, Math.max(1, Math.abs(yl - yh)));
    }
  } else {
    const half = w >> 1;
    ctx.fillStyle = style.color;
    for (let i = lo; i <= hi; i++) {
      const xc = Math.round(ts.indexToX(i) * dpr);
      const yh = Math.round(ps.priceToY(high[i]!) * dpr);
      const yl = Math.round(ps.priceToY(low[i]!) * dpr);
      ctx.fillRect(xc - half, Math.min(yh, yl), w, Math.max(1, Math.abs(yl - yh)));
    }
    ctx.strokeStyle = style.borderColor;
    ctx.lineWidth = line;
    const lh = line / 2;
    ctx.beginPath();
    for (let i = lo; i <= hi; i++) {
      const xc = Math.round(ts.indexToX(i) * dpr);
      const yh = Math.round(ps.priceToY(high[i]!) * dpr);
      const yl = Math.round(ps.priceToY(low[i]!) * dpr);
      const h = Math.max(1, Math.abs(yl - yh));
      ctx.rect(xc - half + lh, Math.min(yh, yl) + lh, w - line, Math.max(0, h - line));
    }
    ctx.stroke();
  }

  if (!style.showLabels) return;
  const decimals = labelDecimals(rc);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.font = font(theme);
  // Labels only when the widest visible one fits in a bar slot.
  let maxAbs = 0;
  for (let i = lo; i <= hi; i++) maxAbs = Math.max(maxAbs, Math.abs(high[i]!), Math.abs(low[i]!));
  const sample = ctx.measureText((-maxAbs).toFixed(decimals)).width;
  if (sample + 4 > ts.barSpacing) {
    ctx.restore();
    return;
  }
  const inv = ps.invert;
  ctx.fillStyle = style.labelColor;
  ctx.textAlign = 'center';
  for (let pass = 0; pass < 2; pass++) {
    const isHigh = pass === 0;
    // High labels go above the box (below it on an inverted scale).
    const above = isHigh !== inv;
    ctx.textBaseline = above ? 'bottom' : 'top';
    for (let i = lo; i <= hi; i++) {
      const p = isHigh ? high[i]! : low[i]!;
      const y = ps.priceToY(p) + (above ? -LABEL_GAP : LABEL_GAP);
      ctx.fillText(p.toFixed(decimals), ts.indexToX(i), y);
    }
  }
  ctx.restore();
}
