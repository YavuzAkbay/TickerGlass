import type { BarArrays, BarInput } from './types';

/** Deterministic random-walk bars (mulberry32), for tests only. */
export function randomBars(n: number, seed = 1, start = 1_700_000_000, step = 60): BarArrays {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cols = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + (rnd() - 0.5) * 2;
    cols.time[i] = start + i * step;
    cols.open[i] = open;
    cols.close[i] = close;
    cols.high[i] = Math.max(open, close) + rnd();
    cols.low[i] = Math.min(open, close) - rnd();
    cols.volume[i] = Math.round(1000 + rnd() * 9000);
    price = close;
  }
  return cols;
}

export function barAt(cols: BarArrays, i: number): BarInput {
  return {
    time: cols.time[i]!,
    open: cols.open[i]!,
    high: cols.high[i]!,
    low: cols.low[i]!,
    close: cols.close[i]!,
    volume: cols.volume[i]!,
  };
}

export function slice(cols: BarArrays, from: number, to: number): BarArrays {
  const pick = (a: ArrayLike<number>) => Float64Array.from(Array.prototype.slice.call(a, from, to));
  return {
    time: pick(cols.time),
    open: pick(cols.open),
    high: pick(cols.high),
    low: pick(cols.low),
    close: pick(cols.close),
    volume: pick(cols.volume),
  };
}
