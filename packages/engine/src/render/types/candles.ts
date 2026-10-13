import type { CandleStyle, OhlcvSource } from '../../chart-types';
import type { SeriesRenderContext } from '../series';
import { bodyWidth, thinWidth } from './common';

export interface CandleOptions {
  /** Draw wicks (still subject to `style.drawWick`). */
  wicks: boolean;
  /**
   * reference hollow candles: colour from close vs previous close, body hollow
   * (border only) when close > open, filled otherwise.
   */
  hollow: boolean;
  /** Body width proportional to volume relative to the visible maximum. */
  volume: boolean;
}

const BODY_RATIO = 0.75;
const MAX_VOLUME_RATIO = 0.9;

/**
 * Candles in device pixels. One pass per colour class (up / down) for wicks,
 * body fills and borders. Falls back to plain high-low lines when bodies are
 * narrower than 3 device px.
 */
export function drawCandles(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  style: CandleStyle,
  opt: CandleOptions,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  const lo = Math.max(0, rc.from);
  const hi = Math.min(data.length - 1, rc.to);
  if (lo > hi) return;
  const { open, high, low, close, volume } = data;

  const spacingDev = ts.barSpacing * dpr;
  const fixedBody = bodyWidth(spacingDev, BODY_RATIO);
  const maxBody = Math.max(1, Math.floor(spacingDev * MAX_VOLUME_RATIO));
  let maxVol = 0;
  if (opt.volume) {
    for (let i = lo; i <= hi; i++) {
      const v = volume[i]!;
      if (v > maxVol) maxVol = v;
    }
  }
  const useVolume = opt.volume && maxVol > 0;
  const line = thinWidth(dpr);
  const drawWick = opt.wicks && style.drawWick;
  const narrow = !useVolume && fixedBody < 3;

  const widthAt = (i: number): number => {
    if (!useVolume) return fixedBody;
    let w = Math.round((volume[i]! / maxVol) * maxBody);
    w = Math.min(maxBody, Math.max(1, w));
    if (w >= 3 && w % 2 === 0) w -= 1;
    return w;
  };
  const colourUp = (i: number): boolean => {
    const c = close[i]!;
    if (opt.hollow && i > 0) return c >= close[i - 1]!;
    return c >= open[i]!;
  };
  const isHollow = (i: number): boolean => opt.hollow && close[i]! > open[i]!;

  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 0;

    if (narrow) {
      // Too narrow for bodies: one high-low line per bar.
      ctx.fillStyle = drawWick
        ? up
          ? style.wickUpColor
          : style.wickDownColor
        : up
          ? style.upColor
          : style.downColor;
      for (let i = lo; i <= hi; i++) {
        if (colourUp(i) !== up) continue;
        const xc = Math.round(ts.indexToX(i) * dpr);
        const yh = Math.round(ps.priceToY(high[i]!) * dpr);
        const yl = Math.round(ps.priceToY(low[i]!) * dpr);
        const top = Math.min(yh, yl);
        ctx.fillRect(xc - (line >> 1), top, line, Math.max(1, Math.abs(yl - yh)));
      }
      continue;
    }

    // Wicks: only the parts outside the body, so hollow bodies stay empty.
    if (drawWick) {
      ctx.fillStyle = up ? style.wickUpColor : style.wickDownColor;
      const bodyShown = style.drawBody || style.drawBorder || opt.hollow;
      for (let i = lo; i <= hi; i++) {
        if (colourUp(i) !== up) continue;
        const xc = Math.round(ts.indexToX(i) * dpr);
        const yh = Math.round(ps.priceToY(high[i]!) * dpr);
        const yl = Math.round(ps.priceToY(low[i]!) * dpr);
        const wTop = Math.min(yh, yl);
        const wBot = Math.max(yh, yl);
        const xl = xc - (line >> 1);
        if (!bodyShown) {
          ctx.fillRect(xl, wTop, line, Math.max(1, wBot - wTop));
          continue;
        }
        const yo = Math.round(ps.priceToY(open[i]!) * dpr);
        const yc = Math.round(ps.priceToY(close[i]!) * dpr);
        const bTop = Math.min(yo, yc);
        const bBot = bTop + Math.max(1, Math.abs(yc - yo));
        if (bTop > wTop) ctx.fillRect(xl, wTop, line, bTop - wTop);
        if (wBot > bBot) ctx.fillRect(xl, bBot, line, wBot - bBot);
      }
    }

    // Filled bodies.
    if (style.drawBody) {
      ctx.fillStyle = up ? style.upColor : style.downColor;
      for (let i = lo; i <= hi; i++) {
        if (colourUp(i) !== up || isHollow(i)) continue;
        const w = widthAt(i);
        const xc = Math.round(ts.indexToX(i) * dpr);
        const yo = Math.round(ps.priceToY(open[i]!) * dpr);
        const yc = Math.round(ps.priceToY(close[i]!) * dpr);
        ctx.fillRect(xc - (w >> 1), Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
      }
    }

    // Borders (and the outline of hollow bodies), one stroked path per colour.
    if (style.drawBorder || opt.hollow) {
      ctx.strokeStyle = style.drawBorder
        ? up
          ? style.borderUpColor
          : style.borderDownColor
        : up
          ? style.upColor
          : style.downColor;
      ctx.lineWidth = line;
      const half = line / 2;
      let any = false;
      ctx.beginPath();
      for (let i = lo; i <= hi; i++) {
        if (colourUp(i) !== up) continue;
        const hollow = isHollow(i);
        if (!style.drawBorder && !hollow) continue;
        const w = widthAt(i);
        if (w < 3) continue;
        const xc = Math.round(ts.indexToX(i) * dpr);
        const yo = Math.round(ps.priceToY(open[i]!) * dpr);
        const yc = Math.round(ps.priceToY(close[i]!) * dpr);
        const h = Math.max(1, Math.abs(yc - yo));
        ctx.rect(xc - (w >> 1) + half, Math.min(yo, yc) + half, w - line, Math.max(0, h - line));
        any = true;
      }
      if (any) ctx.stroke();
    }
  }
}
