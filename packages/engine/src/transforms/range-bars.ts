import type { OhlcvSource, TransformResult } from '../chart-types';
import {
  MutableOhlcv,
  initialCapacity,
  int32Column,
  isValidBar,
  result,
  volumeAt,
} from './buffers';

export interface RangeBarOptions {
  /** High - low span of every completed bar. */
  range: number;
  /** Gap between a bar's close and the next bar's open (the symbol's min tick). Default 0. */
  tick?: number;
}

/**
 * Range bars. Price is walked continuously through each source bar (gap from the previous
 * close to the open, then O→L→H→C when close >= open, else O→H→L→C). A bar completes when
 * its high - low would exceed `range`: it closes exactly `range` from its far extreme and
 * the next bar opens at that close ± tick in the move direction, so big moves produce
 * several bars from one source bar (same time / sourceIndex).
 *
 * The final, still-forming bar (span <= range) is emitted as the last output bar. A source
 * bar's volume goes to the range bar that is forming when that source bar ends.
 */
export function rangeBars(src: OhlcvSource, opts: RangeBarOptions): TransformResult {
  const range = opts.range;
  const n = src.length;
  const out = new MutableOhlcv(initialCapacity(n));
  const idx = int32Column(initialCapacity(n));
  if (!Number.isFinite(range) || range <= 0) return result(out, idx);
  const tick =
    opts.tick !== undefined && Number.isFinite(opts.tick) && opts.tick > 0 ? opts.tick : 0;
  const limit = range * (1 + 1e-9);

  let started = false;
  let o = 0;
  let h = 0;
  let l = 0;
  let c = 0;
  let vol = 0;
  let lastI = 0;

  const open = (price: number): void => {
    o = h = l = c = price;
    vol = 0;
  };

  const feed = (p: number, i: number): void => {
    const t = src.time[i]!;
    if (p > c) {
      while (p - l > limit) {
        const close = l + range;
        out.push(t, o, close, l, close, vol);
        idx.push(i);
        open(close + tick);
      }
    } else if (p < c) {
      while (h - p > limit) {
        const close = h - range;
        out.push(t, o, h, close, close, vol);
        idx.push(i);
        open(close - tick);
      }
    }
    if (p > h) h = p;
    if (p < l) l = p;
    c = p;
  };

  for (let i = 0; i < n; i++) {
    if (!isValidBar(src, i)) continue;
    const so = src.open[i]!;
    const sh = src.high[i]!;
    const sl = src.low[i]!;
    const sc = src.close[i]!;
    if (!started) {
      open(so);
      started = true;
    }
    feed(so, i);
    feed(sc >= so ? sl : sh, i);
    feed(sc >= so ? sh : sl, i);
    feed(sc, i);
    vol += volumeAt(src, i);
    lastI = i;
  }
  if (started) {
    out.push(src.time[lastI]!, o, h, l, c, vol);
    idx.push(lastI);
  }
  return result(out, idx);
}
