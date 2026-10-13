import type { OhlcvSource, TransformResult } from '../chart-types';
import {
  GRID_EPS,
  MutableOhlcv,
  initialCapacity,
  int32Column,
  isValidBar,
  result,
  volumeAt,
} from './buffers';

export interface RenkoOptions {
  boxSize: number;
  /** 'close' uses closes only; 'hl' walks low/high in intrabar order. */
  source: 'close' | 'hl';
  /** Show the opposite wick (extreme reached since the previous brick). */
  wicks: boolean;
}

/**
 * Traditional Renko. Bricks sit on a grid of `boxSize` seeded from the first valid close.
 * A new up brick needs price >= last brick top + box; a down brick needs price <= last
 * brick bottom - box (so a reversal needs two boxes from the far end of the last brick).
 * Only completed bricks are emitted; time / sourceIndex come from the completing bar.
 *
 * 'hl' source: each bar is walked as O→L→H→C when close >= open, else O→H→L→C, so a bar
 * can complete bricks in both directions. Wicks: up bricks get a lower wick down to the
 * lowest price since the previous brick, down bricks an upper wick up to the highest
 * (the bar's high/low with 'close' source, the walked prices with 'hl').
 */
export function renko(src: OhlcvSource, opts: RenkoOptions): TransformResult {
  const box = opts.boxSize;
  const n = src.length;
  const out = new MutableOhlcv(initialCapacity(n));
  const idx = int32Column(initialCapacity(n));
  if (!Number.isFinite(box) || box <= 0) return result(out, idx, { boxSize: box });

  const hl = opts.source === 'hl';
  const wicks = opts.wicks;
  let started = false;
  // Last brick bounds as integer grid levels (price = level * box).
  let top = 0;
  let bottom = 0;
  let vol = 0;
  let minSince = Infinity;
  let maxSince = -Infinity;

  const feed = (p: number, i: number): void => {
    const t = src.time[i]!;
    const up = Math.floor(p / box + GRID_EPS);
    if (up >= top + 1) {
      let first = true;
      while (up >= top + 1) {
        const o = top * box;
        const c = (top + 1) * box;
        const lo = first && wicks ? Math.min(o, minSince) : o;
        out.push(t, o, c, lo, c, first ? vol : 0);
        idx.push(i);
        first = false;
        bottom = top;
        top += 1;
      }
    } else {
      const dn = Math.ceil(p / box - GRID_EPS);
      if (dn > bottom - 1) return;
      let first = true;
      while (dn <= bottom - 1) {
        const o = bottom * box;
        const c = (bottom - 1) * box;
        const hi = first && wicks ? Math.max(o, maxSince) : o;
        out.push(t, o, hi, c, c, first ? vol : 0);
        idx.push(i);
        first = false;
        top = bottom;
        bottom -= 1;
      }
    }
    vol = 0;
    minSince = Infinity;
    maxSince = -Infinity;
  };

  for (let i = 0; i < n; i++) {
    if (!isValidBar(src, i)) continue;
    const o = src.open[i]!;
    const h = src.high[i]!;
    const l = src.low[i]!;
    const c = src.close[i]!;
    if (!started) {
      top = bottom = Math.round(c / box);
      started = true;
    }
    vol += volumeAt(src, i);
    if (!hl) {
      if (l < minSince) minSince = l;
      if (h > maxSince) maxSince = h;
      feed(c, i);
      continue;
    }
    const a = c >= o ? l : h;
    const b = c >= o ? h : l;
    if (a < minSince) minSince = a;
    if (a > maxSince) maxSince = a;
    feed(a, i);
    if (b < minSince) minSince = b;
    if (b > maxSince) maxSince = b;
    feed(b, i);
  }
  return result(out, idx, { boxSize: box });
}
