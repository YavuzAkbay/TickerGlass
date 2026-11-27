/**
 * Horizontal support and resistance the way a chartist draws them: prices where the market
 * turned more than once (swing highs and lows within a small band), over all loaded history,
 * classified against the latest close. A level starts at its first touch.
 */
import { findSwings } from './divergence';
import { at } from './format';
import type { BriefBars } from './types';

export interface LevelTouch {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
}

export interface Level {
  id: string;
  price: number;
  role: 'support' | 'resistance';
  /** Swing highs and lows that formed it, oldest first. */
  touches: LevelTouch[];
  /** Both highs and lows touched it (support turned resistance or the reverse). */
  flipped: boolean;
  /** Distance from the latest close in %, negative below. */
  distancePct: number;
  score: number;
}

export interface LevelOptions {
  /** Bars on each side of a swing. Default 3. */
  strength?: number;
  /** Swings within this % of each other form one level. Default 4. */
  tolerancePct?: number;
  /** Levels returned (the most important on both sides of the price). Default 5. */
  limit?: number;
  /** Bars whose price range decides which levels are still relevant. Default 250. */
  window?: number;
}

/** The most extreme bar of the last `k` bars when it beats the `k` bars before it: a swing in
 * the making (no bars after it yet), e.g. today's low after a sell-off. */
function lastSwing(values: ArrayLike<number>, kind: 'high' | 'low', k: number): number | null {
  const n = values.length;
  if (n < k + 2) return null;
  const better = (a: number, b: number) => (kind === 'high' ? a > b : a < b);
  let best = n - 1;
  for (let i = n - k; i < n; i++) if (better(at(values, i), at(values, best))) best = i;
  for (let j = Math.max(0, best - k); j < n; j++)
    if (j !== best && !better(at(values, best), at(values, j))) return null;
  return best;
}

export function findLevels(bars: BriefBars, opts: LevelOptions = {}): Level[] {
  const n = bars.length;
  if (n < 10) return [];
  const k = opts.strength ?? 3;
  const tol = (opts.tolerancePct ?? 4) / 100;
  const close = at(bars.close, n - 1);

  const touches: LevelTouch[] = [];
  for (const kind of ['high', 'low'] as const) {
    const series = kind === 'high' ? bars.high : bars.low;
    for (const s of findSwings(series, kind, { strength: k }))
      touches.push({ index: s.index, time: at(bars.time, s.index), price: s.value, kind });
    const tail = lastSwing(series, kind, k);
    if (tail !== null && !touches.some((t) => t.index === tail && t.kind === kind))
      touches.push({ index: tail, time: at(bars.time, tail), price: at(series, tail), kind });
  }

  // Greedy clustering on price: each touch joins the cluster whose average is within `tol`.
  touches.sort((a, b) => a.price - b.price);
  const clusters: LevelTouch[][] = [];
  for (const t of touches) {
    const last = clusters.at(-1);
    const mean = last ? last.reduce((s, x) => s + x.price, 0) / last.length : NaN;
    if (last && Math.abs(t.price - mean) <= mean * tol) last.push(t);
    else clusters.push([t]);
  }

  const levels: Omit<Level, 'id'>[] = clusters
    .map((c) => {
      const byTime = [...c].sort((a, b) => a.index - b.index);
      const prices = c.map((t) => t.price).sort((a, b) => a - b);
      const mid = prices.length / 2;
      const price =
        prices.length % 2 ? prices[Math.floor(mid)]! : (prices[mid - 1]! + prices[mid]!) / 2;
      const flipped = c.some((t) => t.kind === 'high') && c.some((t) => t.kind === 'low');
      const recency = byTime.at(-1)!.index / (n - 1);
      return {
        price,
        role: price <= close ? ('support' as const) : ('resistance' as const),
        touches: byTime,
        flipped,
        distancePct: ((price - close) / close) * 100,
        score: c.length * 2 + (flipped ? 1.5 : 0) + recency * 2,
      };
    })
    // A level is something price respected at least twice.
    .filter((l) => l.touches.length >= 2);

  const limit = opts.limit ?? 5;
  // How much a level matters: touches, both roles, recent use; far-away levels count less
  // (log distance, so a crash does not make every level above look remote).
  const weight = (l: Omit<Level, 'id'>) => l.score - 2 * Math.abs(Math.log(l.price / close));
  // Relevant: inside the price range of the recent window (±10%), unless a side has nothing.
  const from = Math.max(0, n - (opts.window ?? 250));
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = from; i < n; i++) {
    lo = Math.min(lo, at(bars.low, i));
    hi = Math.max(hi, at(bars.high, i));
  }
  const relevant = (l: Omit<Level, 'id'>) => l.price >= lo * 0.9 && l.price <= hi * 1.1;
  const side = (role: Level['role']) => {
    const all = levels.filter((l) => l.role === role);
    const near = all.filter(relevant);
    const pool = near.length
      ? near
      : all.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)).slice(0, 1);
    // Nearest first; a level within two bands of the one before is the same area: keep
    // whichever matters more.
    pool.sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct));
    const out: Omit<Level, 'id'>[] = [];
    for (const l of pool) {
      const prev = out.at(-1);
      if (prev && Math.abs(l.price - prev.price) <= prev.price * tol * 2) {
        if (weight(l) > weight(prev)) out[out.length - 1] = l;
      } else out.push(l);
    }
    return out.sort((a, b) => weight(b) - weight(a));
  };
  const above = side('resistance');
  const below = side('support');
  // The most important levels overall, keeping at least one on each side of the price.
  const picked = [above[0], below[0]].filter((l) => l !== undefined);
  const rest = [...above.slice(1), ...below.slice(1)].sort((a, b) => weight(b) - weight(a));
  while (picked.length < limit && rest.length) picked.push(rest.shift()!);
  picked.splice(limit);
  return picked.sort((a, b) => b.price - a.price).map((l, i) => ({ id: `L${i + 1}`, ...l }));
}
