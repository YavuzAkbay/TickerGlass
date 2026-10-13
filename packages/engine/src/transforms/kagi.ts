import type { OhlcvSource, TransformResult } from '../chart-types';
import {
  IntColumn,
  MutableOhlcv,
  initialCapacity,
  int32Column,
  isValidBar,
  result,
  volumeAt,
} from './buffers';

export interface KagiOptions {
  /** Reversal amount: absolute price ('fixed') or percent of the extreme ('percent'). */
  reversal: number;
  reversalMode: 'fixed' | 'percent';
  /** 'close' uses closes only; 'hl' walks low/high in intrabar order. */
  source: 'close' | 'hl';
}

/**
 * Kagi chart. Each output bar is one vertical segment (open = start, close = end). The
 * line starts at the first valid price and takes its first direction once price moves a
 * full reversal away. It extends while price continues and reverses when price retraces
 * by >= reversal from the extreme. The last (in-progress) segment is emitted too.
 *
 * Thickness: the first segment is yang if it rises, yin if it falls (its start acts as the
 * first waist / shoulder). The line turns yang when it rises above the previous shoulder
 * and yin when it falls below the previous waist; a segment that changes thickness is
 * split at that price, the first part taking the bar where the crossing happened.
 * time / sourceIndex = the bar where the segment's extreme was (last) reached.
 *
 * 'hl' source: each bar is walked as O→L→H→C when close >= open, else O→H→L→C.
 */
export function kagi(src: OhlcvSource, opts: KagiOptions): TransformResult {
  const n = src.length;
  const out = new MutableOhlcv(initialCapacity(n));
  const idx = int32Column(initialCapacity(n));
  const yangCol = new IntColumn((k) => new Uint8Array(k), initialCapacity(n));
  const finish = (): TransformResult => result(out, idx, { kagiYang: yangCol.view() });
  const r = opts.reversal;
  if (!Number.isFinite(r) || r <= 0) return finish();
  const percent = opts.reversalMode === 'percent';
  const rev = (x: number): number => (percent ? (Math.abs(x) * r) / 100 : r);
  const hl = opts.source === 'hl';

  let started = false;
  let p0 = 0;
  let dir = 0;
  let start = 0;
  let ext = 0;
  let extIdx = 0;
  let yang = false;
  let shoulder = NaN;
  let waist = NaN;
  let crossIdx = -1;
  let vol = 0;

  const push = (i: number, o: number, c: number, v: number): void => {
    out.push(src.time[i]!, o, Math.max(o, c), Math.min(o, c), c, v);
    idx.push(i);
    yangCol.push(yang ? 1 : 0);
  };

  const emit = (): void => {
    if (crossIdx >= 0) {
      const mid = dir > 0 ? shoulder : waist;
      push(crossIdx, start, mid, 0);
      yang = !yang;
      push(extIdx, mid, ext, vol);
    } else push(extIdx, start, ext, vol);
    vol = 0;
    crossIdx = -1;
  };

  const checkCross = (p: number, i: number): void => {
    if (crossIdx >= 0) return;
    if (dir > 0 ? !yang && p > shoulder : yang && p < waist) crossIdx = i;
  };

  const feed = (p: number, i: number): void => {
    if (dir === 0) {
      const d = p - p0;
      if (Math.abs(d) < rev(p0) || d === 0) return;
      dir = d > 0 ? 1 : -1;
      start = p0;
      ext = p;
      extIdx = i;
      yang = dir > 0;
      if (dir > 0) waist = p0;
      else shoulder = p0;
      return;
    }
    if (dir > 0 ? p > ext : p < ext) {
      ext = p;
      extIdx = i;
      checkCross(p, i);
      return;
    }
    const back = dir > 0 ? ext - p : p - ext;
    if (back <= 0 || back < rev(ext)) return;
    emit();
    if (dir > 0) shoulder = ext;
    else waist = ext;
    dir = -dir;
    start = ext;
    ext = p;
    extIdx = i;
    checkCross(p, i);
  };

  for (let i = 0; i < n; i++) {
    if (!isValidBar(src, i)) continue;
    const o = src.open[i]!;
    const c = src.close[i]!;
    if (!started) {
      p0 = c;
      started = true;
    }
    vol += volumeAt(src, i);
    if (!hl) {
      feed(c, i);
      continue;
    }
    const h = src.high[i]!;
    const l = src.low[i]!;
    feed(c >= o ? l : h, i);
    feed(c >= o ? h : l, i);
  }
  if (dir !== 0) emit();
  return finish();
}
