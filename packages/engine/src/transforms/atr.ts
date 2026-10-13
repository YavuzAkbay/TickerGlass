import type { OhlcvSource } from '../chart-types';
import { isValidBar } from './buffers';

/**
 * Runs Wilder's ATR (RMA of true range, seeded with the SMA of the first `length` TRs,
 * matching the common ta.atr). Invalid (NaN) bars are skipped and do not advance state.
 * Calls `emit(i, atr)` for every valid bar once warmed up.
 */
function runAtr(src: OhlcvSource, length: number, emit: (i: number, atr: number) => void): void {
  const len = Math.floor(length);
  if (!(len >= 1)) return;
  let prevClose = NaN;
  let count = 0;
  let sum = 0;
  let atr = NaN;
  for (let i = 0; i < src.length; i++) {
    if (!isValidBar(src, i)) continue;
    const h = src.high[i]!;
    const l = src.low[i]!;
    const tr = Number.isNaN(prevClose)
      ? h - l
      : Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
    prevClose = src.close[i]!;
    count++;
    if (count < len) {
      sum += tr;
      continue;
    }
    if (count === len) atr = (sum + tr) / len;
    else atr = (atr * (len - 1) + tr) / len;
    emit(i, atr);
  }
}

/** Wilder's ATR per bar; NaN during warm-up and on invalid bars. */
export function atrSeries(src: OhlcvSource, length: number): Float64Array {
  const out = new Float64Array(src.length).fill(NaN);
  runAtr(src, length, (i, atr) => {
    out[i] = atr;
  });
  return out;
}

/**
 * ATR at the most recent bar, for use as an automatic box size. Falls back to 1% of the
 * last valid close when there are fewer than `length` valid bars (or ATR is 0), and to 1
 * when there is no usable close at all.
 */
export function lastAtr(src: OhlcvSource, length: number): number {
  let atr = NaN;
  runAtr(src, length, (_i, v) => {
    atr = v;
  });
  if (Number.isFinite(atr) && atr > 0) return atr;
  for (let i = src.length - 1; i >= 0; i--) {
    if (!isValidBar(src, i)) continue;
    const c = Math.abs(src.close[i]!);
    return c > 0 ? c * 0.01 : 1;
  }
  return 1;
}

const clean = (v: number): number => Number(v.toPrecision(12));

/**
 * Rounds a raw box size to a "nice" value: two significant digits, then (when `minTick`
 * is given) to a multiple of `minTick`, never below one tick. Returns `minTick` (or NaN
 * without one) for non-positive / non-finite input.
 */
export function roundBoxSize(v: number, minTick?: number): number {
  const tick = minTick !== undefined && Number.isFinite(minTick) && minTick > 0 ? minTick : 0;
  if (!Number.isFinite(v) || v <= 0) return tick > 0 ? tick : NaN;
  const mag = Math.pow(10, Math.floor(Math.log10(v)) - 1);
  let r = clean(Math.round(v / mag) * mag);
  if (tick > 0) r = clean(Math.max(1, Math.round(r / tick)) * tick);
  return r;
}
