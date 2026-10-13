import type { OhlcvSource, TransformResult } from '../chart-types';
import {
  GRID_EPS,
  IntColumn,
  MutableOhlcv,
  initialCapacity,
  int32Column,
  isValidBar,
  result,
  volumeAt,
} from './buffers';

export interface PointFigureOptions {
  boxSize: number;
  /** Boxes needed to reverse (classic: 3). */
  reversal: number;
  /** 'close' uses closes only; 'hl' uses highs for X and lows for O (classic rule). */
  source: 'close' | 'hl';
}

/**
 * Classic point & figure. Prices are box values (level * boxSize); X columns fill up to
 * floor(high / box), O columns down to ceil(low / box). The first column starts at the
 * first valid close rounded to the grid once price moves one box. A reversal needs
 * `reversal` boxes against the column extreme and starts one box past it.
 *
 * Per bar (classic rule): try to extend the current column first; only when it does not
 * extend, test the reversal. Each output bar is one column (the last one in progress):
 * X: open = bottom, close = top; O: open = top, close = bottom. time = the bar that
 * started the column; sourceIndex = the last bar that extended it. Volume is summed over
 * the bars belonging to the column (the reversing bar belongs to the new column).
 */
export function pointFigure(src: OhlcvSource, opts: PointFigureOptions): TransformResult {
  const box = opts.boxSize;
  const n = src.length;
  const out = new MutableOhlcv(initialCapacity(n));
  const idx = int32Column(initialCapacity(n));
  const dirCol = new IntColumn((k) => new Int8Array(k), initialCapacity(n));
  const finish = (): TransformResult =>
    result(out, idx, { boxSize: box, pfDirection: dirCol.view() });
  if (!Number.isFinite(box) || box <= 0) return finish();
  const rev = Math.max(1, Math.round(Number.isFinite(opts.reversal) ? opts.reversal : 3));
  const hl = opts.source === 'hl';

  let started = false;
  let anchor = 0;
  let dir = 0;
  // Column bounds as box levels.
  let top = 0;
  let bottom = 0;
  let startIdx = 0;
  let lastIdx = 0;
  let vol = 0;

  const emit = (): void => {
    const o = dir > 0 ? bottom : top;
    const c = dir > 0 ? top : bottom;
    out.push(src.time[startIdx]!, o * box, top * box, bottom * box, c * box, vol);
    idx.push(lastIdx);
    dirCol.push(dir);
    vol = 0;
  };

  for (let i = 0; i < n; i++) {
    if (!isValidBar(src, i)) continue;
    const c = src.close[i]!;
    const hi = hl ? src.high[i]! : c;
    const lo = hl ? src.low[i]! : c;
    if (!started) {
      anchor = Math.round(c / box);
      started = true;
    }
    const up = Math.floor(hi / box + GRID_EPS);
    const dn = Math.ceil(lo / box - GRID_EPS);
    if (dir === 0) {
      if (up >= anchor + 1) {
        dir = 1;
        bottom = anchor;
        top = up;
      } else if (dn <= anchor - 1) {
        dir = -1;
        top = anchor;
        bottom = dn;
      }
      if (dir !== 0) startIdx = lastIdx = i;
    } else if (dir > 0) {
      if (up > top) {
        top = up;
        lastIdx = i;
      } else if (dn <= top - rev) {
        emit();
        dir = -1;
        top -= 1;
        bottom = dn;
        startIdx = lastIdx = i;
      }
    } else if (dn < bottom) {
      bottom = dn;
      lastIdx = i;
    } else if (up >= bottom + rev) {
      emit();
      dir = 1;
      bottom += 1;
      top = up;
      startIdx = lastIdx = i;
    }
    vol += volumeAt(src, i);
  }
  if (dir !== 0) emit();
  return finish();
}
