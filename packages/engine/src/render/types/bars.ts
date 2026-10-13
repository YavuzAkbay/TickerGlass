import type { BarStyle, OhlcvSource } from '../../chart-types';
import type { SeriesRenderContext } from '../series';
import { bodyWidth, isUp, thinWidth } from './common';

const TICK_RATIO = 0.8;

/** Line width of thick bars in device px: grows with spacing, capped at ~3 css px. */
function thickWidth(spacingDev: number, dpr: number): number {
  const min = thinWidth(dpr);
  const max = Math.max(min, Math.round(3 * dpr));
  const w = Math.min(max, Math.max(min, Math.floor(spacingDev / 6)));
  // Never wider than half a slot, or neighbours merge.
  return Math.max(1, Math.min(w, Math.floor(spacingDev / 2)));
}

/**
 * OHLC bars (also used for range bars): vertical high-low line, open tick on the
 * left, close tick on the right. Two passes, one per colour.
 */
export function drawOhlcBars(rc: SeriesRenderContext, data: OhlcvSource, style: BarStyle): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  const lo = Math.max(0, rc.from);
  const hi = Math.min(data.length - 1, rc.to);
  if (lo > hi) return;
  const { open, high, low, close } = data;

  const spacingDev = ts.barSpacing * dpr;
  const lw = style.thinBars ? 1 : thickWidth(spacingDev, dpr);
  const lwHalf = lw >> 1;
  const half = bodyWidth(spacingDev, TICK_RATIO) >> 1;
  const leftLen = half - lwHalf;
  const rightLen = half + 1 - lw + lwHalf;

  for (let pass = 0; pass < 2; pass++) {
    const up = pass === 0;
    ctx.fillStyle = up ? style.upColor : style.downColor;
    for (let i = lo; i <= hi; i++) {
      if (isUp(data, i, style.colorByPrevClose) !== up) continue;
      const xc = Math.round(ts.indexToX(i) * dpr);
      const yh = Math.round(ps.priceToY(high[i]!) * dpr);
      const yl = Math.round(ps.priceToY(low[i]!) * dpr);
      const top = Math.min(yh, yl);
      const xl = xc - lwHalf;
      ctx.fillRect(xl, top, lw, Math.max(1, Math.abs(yl - yh)));
      if (!style.hlcBars && leftLen > 0) {
        const yo = Math.round(ps.priceToY(open[i]!) * dpr);
        ctx.fillRect(xc - half, yo - lwHalf, leftLen, lw);
      }
      if (rightLen > 0) {
        const yc = Math.round(ps.priceToY(close[i]!) * dpr);
        ctx.fillRect(xl + lw, yc - lwHalf, rightLen, lw);
      }
    }
  }
}
