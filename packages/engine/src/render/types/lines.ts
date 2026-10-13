import type {
  AreaStyle,
  BaselineStyle,
  HlcAreaStyle,
  LineStyle,
  OhlcvSource,
  PriceSource,
} from '../../chart-types';
import type { SeriesRenderContext } from '../series';
import { sourceValue, strokeAlign, thinWidth } from './common';
import { verticalGradient } from './gradient';

/** Markers are drawn only when bars are further apart than this (css px). */
const MARKER_MIN_SPACING = 4;

/** Index range for line-like types: visible bars plus one on each side. */
function lineRange(rc: SeriesRenderContext, data: OhlcvSource): { lo: number; hi: number } {
  return { lo: Math.max(0, rc.from - 1), hi: Math.min(data.length - 1, rc.to + 1) };
}

/**
 * Append the polyline of `source` over [lo, hi] to the current path (device px).
 * `step` draws horizontal-then-vertical steps; `connect` continues an existing
 * subpath instead of starting a new one. Non-finite values are skipped.
 */
function tracePolyline(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  source: PriceSource,
  lo: number,
  hi: number,
  step: boolean,
  connect: boolean,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  let pen = connect;
  let prevY = 0;
  for (let i = lo; i <= hi; i++) {
    const v = sourceValue(data, i, source);
    if (!Number.isFinite(v)) continue;
    const x = ts.indexToX(i) * dpr;
    const y = ps.priceToY(v) * dpr;
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else {
      if (step && i > lo) ctx.lineTo(x, prevY);
      ctx.lineTo(x, y);
    }
    prevY = y;
  }
}

/** Same as tracePolyline but walking from hi down to lo (for closed fill polygons). */
function tracePolylineBack(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  source: PriceSource,
  lo: number,
  hi: number,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  for (let i = hi; i >= lo; i--) {
    const v = sourceValue(data, i, source);
    if (!Number.isFinite(v)) continue;
    ctx.lineTo(ts.indexToX(i) * dpr, ps.priceToY(v) * dpr);
  }
}

function strokeLine(rc: SeriesRenderContext, color: string, widthCss: number): void {
  const { ctx } = rc;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, widthCss * rc.dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.stroke();
}

/** Line, line with markers, or step line. */
export function drawLine(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  style: LineStyle,
  variant: 'line' | 'markers' | 'step',
): void {
  const { lo, hi } = lineRange(rc, data);
  if (lo > hi) return;
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  ctx.beginPath();
  tracePolyline(rc, data, style.source, lo, hi, variant === 'step', false);
  strokeLine(rc, style.color, style.width);

  if (variant !== 'markers' || ts.barSpacing <= MARKER_MIN_SPACING) return;
  const r = Math.min(Math.max(1.5, style.width) * dpr, ts.barSpacing * dpr * 0.45);
  ctx.fillStyle = style.color;
  ctx.beginPath();
  for (let i = Math.max(0, rc.from); i <= Math.min(data.length - 1, rc.to); i++) {
    const v = sourceValue(data, i, style.source);
    if (!Number.isFinite(v)) continue;
    const x = ts.indexToX(i) * dpr;
    const y = ps.priceToY(v) * dpr;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
}

/** Line with a vertical gradient fill down to the pane bottom. */
export function drawArea(rc: SeriesRenderContext, data: OhlcvSource, style: AreaStyle): void {
  const { lo, hi } = lineRange(rc, data);
  if (lo > hi) return;
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  const bottom = rc.height * dpr;
  let minY = bottom;
  for (let i = lo; i <= hi; i++) {
    const v = sourceValue(data, i, style.source);
    if (!Number.isFinite(v)) continue;
    const y = ps.priceToY(v) * dpr;
    if (y < minY) minY = y;
  }
  minY = Math.max(0, Math.floor(minY));

  ctx.fillStyle = verticalGradient(ctx, 'area', minY, bottom, style.topFill, style.bottomFill);
  ctx.beginPath();
  ctx.moveTo(ts.indexToX(lo) * dpr, bottom);
  tracePolyline(rc, data, style.source, lo, hi, false, true);
  ctx.lineTo(ts.indexToX(hi) * dpr, bottom);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  tracePolyline(rc, data, style.source, lo, hi, false, false);
  strokeLine(rc, style.color, style.width);
}

/** High, low and close lines; high-close and close-low bands filled. */
export function drawHlcArea(rc: SeriesRenderContext, data: OhlcvSource, style: HlcAreaStyle): void {
  const { lo, hi } = lineRange(rc, data);
  if (lo > hi) return;
  const { ctx } = rc;

  ctx.fillStyle = style.highFill;
  ctx.beginPath();
  tracePolyline(rc, data, 'high', lo, hi, false, false);
  tracePolylineBack(rc, data, 'close', lo, hi);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = style.lowFill;
  ctx.beginPath();
  tracePolyline(rc, data, 'close', lo, hi, false, false);
  tracePolylineBack(rc, data, 'low', lo, hi);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  tracePolyline(rc, data, 'high', lo, hi, false, false);
  strokeLine(rc, style.highColor, style.width);
  ctx.beginPath();
  tracePolyline(rc, data, 'low', lo, hi, false, false);
  strokeLine(rc, style.lowColor, style.width);
  ctx.beginPath();
  tracePolyline(rc, data, 'close', lo, hi, false, false);
  strokeLine(rc, style.closeColor, style.width);
}

/**
 * Base level in device px. `baseLevelPercent` is a percent of the visible price
 * range (the scale's internal min..max, which sits inside the top/bottom margins),
 * measured from the bottom; going through internal units keeps log, percent and
 * inverted scales correct.
 */
export function baselineY(rc: SeriesRenderContext, style: BaselineStyle): number {
  const ps = rc.priceScale;
  const pct = Math.min(100, Math.max(0, style.baseLevelPercent)) / 100;
  return ps.internalToY(ps.min + (ps.max - ps.min) * pct) * rc.dpr;
}

/**
 * Add the parts of the line on one side of the base to the current path, split
 * exactly where segments cross it. side < 0: above on screen (y < base).
 */
function traceSide(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  source: PriceSource,
  lo: number,
  hi: number,
  base: number,
  side: -1 | 1,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  let pen = false;
  let started = false;
  let x0 = 0;
  let y0 = 0;
  for (let i = lo; i <= hi; i++) {
    const v = sourceValue(data, i, source);
    if (!Number.isFinite(v)) continue;
    const x1 = ts.indexToX(i) * dpr;
    const y1 = ps.priceToY(v) * dpr;
    const in1 = side < 0 ? y1 <= base : y1 >= base;
    if (!started) {
      if (in1) {
        ctx.moveTo(x1, y1);
        pen = true;
      }
      started = true;
    } else {
      const in0 = side < 0 ? y0 <= base : y0 >= base;
      if (in0 && in1) {
        if (!pen) ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        pen = true;
      } else if (in0) {
        const xc = x0 + ((base - y0) / (y1 - y0)) * (x1 - x0);
        if (!pen) ctx.moveTo(x0, y0);
        ctx.lineTo(xc, base);
        pen = false;
      } else if (in1) {
        const xc = x0 + ((base - y0) / (y1 - y0)) * (x1 - x0);
        ctx.moveTo(xc, base);
        ctx.lineTo(x1, y1);
        pen = true;
      } else {
        pen = false;
      }
    }
    x0 = x1;
    y0 = y1;
  }
}

/** Line coloured above/below a base price, gradient fills clipped to each side. */
export function drawBaseline(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  style: BaselineStyle,
): void {
  const { lo, hi } = lineRange(rc, data);
  if (lo > hi) return;
  const { ctx, dpr, timeScale: ts, theme } = rc;
  const w = rc.width * dpr;
  const h = rc.height * dpr;
  const base = baselineY(rc, style);
  // On an inverted scale the screen-top side holds prices below the base.
  const inv = rc.priceScale.invert;
  const topLine = inv ? style.bottomLineColor : style.topLineColor;
  const bottomLine = inv ? style.topLineColor : style.bottomLineColor;
  const xFirst = ts.indexToX(lo) * dpr;
  const xLast = ts.indexToX(hi) * dpr;
  const clampedBase = Math.min(h, Math.max(0, base));

  // Fills: one polygon (line + base), clipped to each side.
  for (let side = 0; side < 2; side++) {
    const above = side === 0;
    const y0 = above ? 0 : clampedBase;
    const y1 = above ? clampedBase : h;
    if (y1 <= y0) continue;
    // Gradient stops run top -> bottom of the clip band; fill1 of the "top" style
    // and fill2 of the "bottom" style are the ends far from the base.
    let c0: string;
    let c1: string;
    if (above) {
      c0 = inv ? style.bottomFill2 : style.topFill1;
      c1 = inv ? style.bottomFill1 : style.topFill2;
    } else {
      c0 = inv ? style.topFill2 : style.bottomFill1;
      c1 = inv ? style.topFill1 : style.bottomFill2;
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y0, w, y1 - y0);
    ctx.clip();
    ctx.fillStyle = verticalGradient(ctx, above ? 'baseline-a' : 'baseline-b', y0, y1, c0, c1);
    ctx.beginPath();
    ctx.moveTo(xFirst, base);
    tracePolyline(rc, data, style.source, lo, hi, false, true);
    ctx.lineTo(xLast, base);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Dotted base line.
  const bw = thinWidth(dpr);
  const by = Math.round(base) + strokeAlign(bw);
  ctx.save();
  ctx.strokeStyle = theme.textMuted;
  ctx.lineWidth = bw;
  ctx.setLineDash([bw, bw * 2]);
  ctx.beginPath();
  ctx.moveTo(0, by);
  ctx.lineTo(w, by);
  ctx.stroke();
  ctx.restore();

  // Line, split exactly at the crossings.
  ctx.beginPath();
  traceSide(rc, data, style.source, lo, hi, base, -1);
  strokeLine(rc, topLine, style.width);
  ctx.beginPath();
  traceSide(rc, data, style.source, lo, hi, base, 1);
  strokeLine(rc, bottomLine, style.width);
}
