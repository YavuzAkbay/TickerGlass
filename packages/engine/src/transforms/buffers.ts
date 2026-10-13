import type { OhlcvSource, TransformExtra, TransformResult } from '../chart-types';

const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;

/** Growable OHLCV columns (Float64Array) with an explicit length. Arrays may be longer. */
export class MutableOhlcv implements OhlcvSource {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  length = 0;

  constructor(capacity = 64) {
    const cap = Math.max(1, Math.floor(capacity));
    this.time = new Float64Array(cap);
    this.open = new Float64Array(cap);
    this.high = new Float64Array(cap);
    this.low = new Float64Array(cap);
    this.close = new Float64Array(cap);
    this.volume = new Float64Array(cap);
  }

  get capacity(): number {
    return this.time.length;
  }

  clear(): void {
    this.length = 0;
  }

  /** Grow every column to hold at least `n` bars, keeping existing values. */
  ensureCapacity(n: number): void {
    if (n <= this.time.length) return;
    const cap = Math.max(n, this.time.length * 2);
    for (const f of FIELDS) {
      const next = new Float64Array(cap);
      next.set(this[f].subarray(0, this.length));
      this[f] = next;
    }
  }

  /** Append a bar and return its index. */
  push(
    time: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
  ): number {
    const i = this.length;
    if (i >= this.time.length) this.ensureCapacity(i + 1);
    this.write(i, time, open, high, low, close, volume);
    this.length = i + 1;
    return i;
  }

  /** Overwrite the bar at `i` (must be < length). */
  write(
    i: number,
    time: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
  ): void {
    this.time[i] = time;
    this.open[i] = open;
    this.high[i] = high;
    this.low[i] = low;
    this.close[i] = close;
    this.volume[i] = volume;
  }
}

type IntArray = Int32Array | Int8Array | Uint8Array;

/** Growable integer column; `view()` returns an exact-length subarray. */
export class IntColumn<T extends IntArray> {
  data: T;
  length = 0;
  private readonly make: (n: number) => T;

  constructor(make: (n: number) => T, capacity = 64) {
    this.make = make;
    this.data = make(Math.max(1, Math.floor(capacity)));
  }

  push(v: number): void {
    if (this.length >= this.data.length) {
      const next = this.make(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }

  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

export const int32Column = (capacity?: number): IntColumn<Int32Array> =>
  new IntColumn((n) => new Int32Array(n), capacity);

/** Tolerance (in box units) for grid comparisons, absorbing float error like 0.3 / 0.1. */
export const GRID_EPS = 1e-9;

/** True when the bar's OHLC values are all finite; other bars are skipped by transforms. */
export function isValidBar(src: OhlcvSource, i: number): boolean {
  return (
    Number.isFinite(src.open[i]) &&
    Number.isFinite(src.high[i]) &&
    Number.isFinite(src.low[i]) &&
    Number.isFinite(src.close[i])
  );
}

/** Volume of bar `i`, treating missing / NaN volume as 0. */
export function volumeAt(src: OhlcvSource, i: number): number {
  const v = src.volume[i];
  return v !== undefined && Number.isFinite(v) ? v : 0;
}

/** Initial output capacity guess: brick outputs are usually far smaller than the input. */
export function initialCapacity(n: number): number {
  return Math.max(16, Math.min(n, 1 << 16));
}

export function result(
  bars: MutableOhlcv,
  sourceIndex: IntColumn<Int32Array>,
  extra: TransformExtra = {},
): TransformResult {
  return { bars, sourceIndex: sourceIndex.view(), extra };
}
