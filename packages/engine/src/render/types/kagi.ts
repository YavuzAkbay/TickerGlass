import type { KagiStyle, OhlcvSource, TransformExtra } from '../../chart-types';
import type { SeriesRenderContext } from '../series';
import { strokeAlign } from './common';

/**
 * Kagi line. Segment i is vertical at bar i's x from open to close, then a
 * horizontal connector at the next segment's start price to bar i+1's x.
 *
 * `extra.kagiYang[i]` is the state at the end of segment i. When it differs from
 * the previous segment's state, the change happens where the line crosses the
 * previous shoulder / waist, which is where the previous segment started
 * (`open[i-1]`); the vertical is split there. If that price is not inside the
 * segment, the whole segment takes the new state. Without `kagiYang`, rising
 * segments are yang.
 *
 * Two passes (yang, yin), each one stroked path with its own colour and width.
 */
export function drawKagi(
  rc: SeriesRenderContext,
  data: OhlcvSource,
  style: KagiStyle,
  extra: TransformExtra,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = rc;
  const lo = Math.max(0, rc.from - 1);
  const hi = Math.min(data.length - 1, rc.to + 1);
  if (lo > hi) return;
  const { open, close } = data;
  const yangArr = extra.kagiYang;
  const yangAt = (i: number): number => {
    const v = yangArr?.[i];
    if (v !== undefined) return v ? 1 : 0;
    return close[i]! >= open[i]! ? 1 : 0;
  };

  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  for (let pass = 0; pass < 2; pass++) {
    const state = pass === 0 ? 1 : 0;
    const width = Math.max(1, Math.round((state ? style.yangWidth : style.yinWidth) * dpr));
    const a = strokeAlign(width);
    const px = (i: number): number => Math.round(ts.indexToX(i) * dpr) + a;
    const py = (p: number): number => Math.round(ps.priceToY(p) * dpr) + a;
    let pen = false;
    let any = false;
    // Emit one piece of the line; contiguous pieces of this pass share a subpath.
    const piece = (s: number, xa: number, ya: number, xb: number, yb: number): void => {
      if (s !== state) {
        pen = false;
        return;
      }
      if (!pen) ctx.moveTo(xa, ya);
      ctx.lineTo(xb, yb);
      pen = true;
      any = true;
    };

    ctx.beginPath();
    for (let i = lo; i <= hi; i++) {
      const o = open[i]!;
      const c = close[i]!;
      const s = yangAt(i);
      const prev = i > 0 ? yangAt(i - 1) : s;
      const x = px(i);
      const yo = py(o);
      const yc = py(c);
      const split = i > 0 ? open[i - 1]! : o;
      if (prev !== s && split > Math.min(o, c) && split < Math.max(o, c)) {
        const ys = py(split);
        piece(prev, x, yo, x, ys);
        piece(s, x, ys, x, yc);
      } else {
        piece(s, x, yo, x, yc);
      }
      if (i < hi) {
        const yn = py(open[i + 1]!);
        if (yn !== yc) piece(s, x, yc, x, yn);
        piece(s, x, yn, px(i + 1), yn);
      }
    }
    if (any) {
      ctx.strokeStyle = state ? style.yangColor : style.yinColor;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
}
