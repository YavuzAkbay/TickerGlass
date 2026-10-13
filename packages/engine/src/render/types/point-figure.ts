import type { OhlcvSource, PointFigureStyle, TransformExtra } from '../../chart-types';
import type { SeriesRenderContext } from '../series';
import { thinWidth } from './common';

const COLUMN_RATIO = 0.8;
/** Below this many device px per box, columns are drawn as plain filled bars. */
const MIN_BOX_PX = 3;
/** Glyph half-size as a fraction of min(box height, column width). */
const GLYPH_RATIO = 0.4;

/** Box size used for drawing / ranges: the transform's, else the style's. */
export function pfBoxSize(style: PointFigureStyle, extra: TransformExtra): number {
  const b = extra.boxSize ?? style.boxSize;
  return Number.isFinite(b) && b > 0 ? b : 0;
}

/** Number of boxes in column i (at least 1). */
export function pfBoxCount(data: OhlcvSource, i: number, box: number): number {
  return Math.max(1, Math.round((data.high[i]! - data.low[i]!) / box));
}

function isX(data: OhlcvSource, extra: TransformExtra, i: number): boolean {
  const d = extra.pfDirection?.[i];
  if (d !== undefined && d !== 0) return d > 0;
  return data.close[i]! >= data.open[i]!;
}

/**
 * Point & figure. Each column stacks boxes of `boxSize` from low upwards: an X
 * (two diagonals) per box for X columns in `upColor`, a circle per box for O
 * columns in `downColor`. One stroked path per colour; tiny boxes become bars.
 */
export function drawPointFigure(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  style: PointFigureStyle,
  extra: TransformExtra,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  const lo = Math.max(0, rc.from);
  const hi = Math.min(data.length - 1, rc.to);
  if (lo > hi) return;
  const { high, low } = data;
  const box = pfBoxSize(style, extra);
  const colW = Math.max(1, Math.floor(ts.barSpacing * dpr * COLUMN_RATIO));
  const hDev = rc.height * dpr;

  for (let pass = 0; pass < 2; pass++) {
    const xs = pass === 0;
    const color = xs ? style.upColor : style.downColor;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    let any = false;
    let lineW = 0;
    ctx.beginPath();
    for (let i = lo; i <= hi; i++) {
      if (isX(data, extra, i) !== xs) continue;
      const xc = Math.round(ts.indexToX(i) * dpr);
      const l = low[i]!;
      const n = box > 0 ? pfBoxCount(data, i, box) : 1;
      const top = box > 0 ? l + n * box : high[i]!;
      const yl = ps.priceToY(l) * dpr;
      const yt = ps.priceToY(top) * dpr;
      const boxPx = Math.abs(yl - yt) / n;
      if (box <= 0 || boxPx < MIN_BOX_PX || colW < MIN_BOX_PX) {
        const y0 = Math.round(Math.min(yl, yt));
        const y1 = Math.round(Math.max(yl, yt));
        ctx.fillRect(xc - (colW >> 1), y0, colW, Math.max(1, y1 - y0));
        continue;
      }
      const r = Math.min(boxPx, colW) * GLYPH_RATIO;
      if (lineW === 0)
        lineW = Math.min(2 * thinWidth(dpr), Math.max(thinWidth(dpr), Math.round(r / 4)));
      for (let k = 0; k < n; k++) {
        const yb = ps.priceToY(l + k * box) * dpr;
        const ye = ps.priceToY(l + (k + 1) * box) * dpr;
        const yc = (yb + ye) / 2;
        if (yc + r < 0 || yc - r > hDev) continue;
        if (xs) {
          ctx.moveTo(xc - r, yc - r);
          ctx.lineTo(xc + r, yc + r);
          ctx.moveTo(xc + r, yc - r);
          ctx.lineTo(xc - r, yc + r);
        } else {
          ctx.moveTo(xc + r, yc);
          ctx.arc(xc, yc, r, 0, Math.PI * 2);
        }
        any = true;
      }
    }
    if (any) {
      ctx.lineWidth = lineW;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }
}
