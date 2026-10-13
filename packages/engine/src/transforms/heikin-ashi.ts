import type { OhlcvSource } from '../chart-types';
import { MutableOhlcv, isValidBar } from './buffers';

/**
 * Writes the Heikin Ashi bar for source index `i` into `out[i]`, using `prev` (index of the
 * previous valid HA bar in `out`, or -1 to seed). Invalid source bars get NaN prices.
 * Returns true when bar `i` is valid.
 */
function writeHa(src: OhlcvSource, out: MutableOhlcv, i: number, prev: number): boolean {
  const t = src.time[i]!;
  const v = src.volume[i]!;
  if (!isValidBar(src, i)) {
    out.write(i, t, NaN, NaN, NaN, NaN, v);
    return false;
  }
  const o = src.open[i]!;
  const h = src.high[i]!;
  const l = src.low[i]!;
  const c = src.close[i]!;
  const haC = (o + h + l + c) / 4;
  const haO = prev < 0 ? (o + c) / 2 : (out.open[prev]! + out.close[prev]!) / 2;
  out.write(i, t, haO, Math.max(h, haO, haC), Math.min(l, haO, haC), haC, v);
  return true;
}

/**
 * Heikin Ashi bars, same length and times as `src`. Bars with NaN OHLC become NaN bars and
 * the HA chain continues from the previous valid bar. Pass `out` to reuse its buffers.
 */
export function heikinAshi(
  src: OhlcvSource,
  out: MutableOhlcv = new MutableOhlcv(src.length),
): MutableOhlcv {
  const n = src.length;
  out.clear();
  out.ensureCapacity(n);
  out.length = n;
  let prev = -1;
  for (let i = 0; i < n; i++) if (writeHa(src, out, i, prev)) prev = i;
  return out;
}

/**
 * Live-tick update: recomputes only the last bar of `out` (a result of `heikinAshi`). If
 * `src` grew by one bar it is appended; any other length mismatch triggers a full rebuild.
 */
export function heikinAshiUpdateLast(src: OhlcvSource, out: MutableOhlcv): MutableOhlcv {
  const n = src.length;
  if (n === 0) {
    out.clear();
    return out;
  }
  if (out.length === n - 1) {
    out.ensureCapacity(n);
    out.length = n;
  } else if (out.length !== n) {
    return heikinAshi(src, out);
  }
  let prev = n - 2;
  while (prev >= 0 && !Number.isFinite(out.open[prev])) prev--;
  writeHa(src, out, n - 1, prev);
  return out;
}
