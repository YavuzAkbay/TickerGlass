import type { OhlcvSource, TransformResult } from '../chart-types';
import {
  MutableOhlcv,
  initialCapacity,
  int32Column,
  isValidBar,
  result,
  volumeAt,
} from './buffers';

export interface LineBreakOptions {
  /** Number of lines a reversal must break (3 = three-line break). */
  lines: number;
}

/**
 * Line break chart on closes. The first line is drawn from the first valid close to the
 * first different close. A line continues its direction when the close exceeds the last
 * line's end; it reverses only when the close breaks the extreme of the last `lines` lines
 * (all lines when fewer exist). Reversal lines start at the far end of the last line.
 * Volume is summed since the previous line; time / sourceIndex are the completing bar.
 */
export function lineBreak(src: OhlcvSource, opts: LineBreakOptions): TransformResult {
  const n = src.length;
  const out = new MutableOhlcv(initialCapacity(n));
  const idx = int32Column(initialCapacity(n));
  const lines = Math.max(1, Math.floor(Number.isFinite(opts.lines) ? opts.lines : 3));
  let ref = NaN;
  let vol = 0;

  const push = (i: number, o: number, c: number): void => {
    out.push(src.time[i]!, o, Math.max(o, c), Math.min(o, c), c, vol);
    idx.push(i);
    vol = 0;
  };

  for (let i = 0; i < n; i++) {
    if (!isValidBar(src, i)) continue;
    const c = src.close[i]!;
    vol += volumeAt(src, i);
    const m = out.length;
    if (m === 0) {
      if (Number.isNaN(ref)) ref = c;
      else if (c !== ref) push(i, ref, c);
      continue;
    }
    const lo = out.open[m - 1]!;
    const lc = out.close[m - 1]!;
    const upLine = lc > lo;
    if (upLine ? c > lc : c < lc) {
      push(i, lc, c);
      continue;
    }
    const from = Math.max(0, m - lines);
    if (upLine) {
      let lowest = Infinity;
      for (let k = from; k < m; k++) lowest = Math.min(lowest, out.low[k]!);
      if (c < lowest) push(i, lo, c);
    } else {
      let highest = -Infinity;
      for (let k = from; k < m; k++) highest = Math.max(highest, out.high[k]!);
      if (c > highest) push(i, lo, c);
    }
  }
  return result(out, idx);
}
