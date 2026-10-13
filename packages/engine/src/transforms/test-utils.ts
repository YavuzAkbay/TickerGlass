import { MutableOhlcv } from './buffers';

export interface BarInput {
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

/** Builds a source from bar objects; time = index * 60. */
export function bars(list: BarInput[]): MutableOhlcv {
  const out = new MutableOhlcv(list.length);
  list.forEach((b, i) => out.push(i * 60, b.o, b.h, b.l, b.c, b.v ?? 1));
  return out;
}

/** Flat bars (o = h = l = c) from closes. */
export function closes(list: number[]): MutableOhlcv {
  return bars(list.map((c) => ({ o: c, h: c, l: c, c })));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic random-walk OHLCV; every 997th bar is NaN to exercise skipping. */
export function randomWalk(n: number, seed = 42): MutableOhlcv {
  const rnd = mulberry32(seed);
  const out = new MutableOhlcv(n);
  let price = 100;
  for (let i = 0; i < n; i++) {
    if (i % 997 === 500) {
      out.push(i * 60, NaN, NaN, NaN, NaN, NaN);
      continue;
    }
    const o = price;
    const c = Math.max(1, o + (rnd() - 0.5) * 2);
    const h = Math.max(o, c) + rnd() * 0.5;
    const l = Math.max(0.5, Math.min(o, c) - rnd() * 0.5);
    out.push(i * 60, o, h, l, c, Math.floor(rnd() * 1000));
    price = c;
  }
  return out;
}

/** First `n` values of a column as a plain array. */
export function col(arr: ArrayLike<number>, n: number): number[] {
  return Array.from({ length: n }, (_, i) => arr[i]!);
}
