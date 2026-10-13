import type { OhlcvSource } from '../chart-types';
import type { Bar, BarColumns } from '../types';

const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;
type Field = (typeof FIELDS)[number];

/**
 * Columnar OHLCV store backed by growable Float64Arrays. Index 0 is the oldest
 * bar. Prepending history shifts every index; callers adjust (see TimeScale).
 */
export class SeriesStore {
  time = new Float64Array(0);
  open = new Float64Array(0);
  high = new Float64Array(0);
  low = new Float64Array(0);
  close = new Float64Array(0);
  volume = new Float64Array(0);
  length = 0;

  setAll(cols: BarColumns): void {
    const n = cols.time.length;
    this.ensureCapacity(n, false);
    for (const f of FIELDS) this[f].set(cols[f].subarray(0, n));
    this.length = n;
  }

  /** Replace contents from any OHLCV source (e.g. a transform result). */
  setFrom(src: OhlcvSource): void {
    const n = src.length;
    this.ensureCapacity(n, false);
    for (const f of FIELDS) {
      const from = src[f];
      const to = this[f];
      if (from instanceof Float64Array) to.set(from.subarray(0, n));
      else for (let i = 0; i < n; i++) to[i] = from[i]!;
    }
    this.length = n;
  }

  clear(): void {
    this.length = 0;
  }

  /** Insert older bars in front. Bars overlapping existing times are dropped. */
  prepend(cols: BarColumns): number {
    const first = this.length ? this.time[0]! : Infinity;
    let n = cols.time.length;
    while (n > 0 && cols.time[n - 1]! >= first) n--;
    if (n === 0) return 0;
    const total = this.length + n;
    const next = {} as Record<Field, Float64Array>;
    const cap = Math.max(total, Math.ceil(total * 1.25));
    for (const f of FIELDS) {
      const arr = new Float64Array(cap);
      arr.set(cols[f].subarray(0, n), 0);
      arr.set(this[f].subarray(0, this.length), n);
      next[f] = arr;
    }
    Object.assign(this, next);
    this.length = total;
    return n;
  }

  /** Update the last bar (same time) or append a newer one. */
  upsert(bar: Bar): 'update' | 'append' | 'ignored' {
    const n = this.length;
    if (n > 0) {
      const last = this.time[n - 1]!;
      if (bar.time < last) return 'ignored';
      if (bar.time === last) {
        this.write(n - 1, bar);
        return 'update';
      }
    }
    this.ensureCapacity(n + 1, true);
    this.write(n, bar);
    this.length = n + 1;
    return 'append';
  }

  bar(i: number): Bar | null {
    if (i < 0 || i >= this.length) return null;
    return {
      time: this.time[i]!,
      open: this.open[i]!,
      high: this.high[i]!,
      low: this.low[i]!,
      close: this.close[i]!,
      volume: this.volume[i]!,
    };
  }

  last(): Bar | null {
    return this.bar(this.length - 1);
  }

  /** Largest index with time <= t, or -1. */
  indexAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.time[mid]! <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  private write(i: number, bar: Bar): void {
    this.time[i] = bar.time;
    this.open[i] = bar.open;
    this.high[i] = bar.high;
    this.low[i] = bar.low;
    this.close[i] = bar.close;
    this.volume[i] = bar.volume;
  }

  private ensureCapacity(n: number, keep: boolean): void {
    if (this.time.length >= n) return;
    const cap = Math.max(n, Math.ceil(this.time.length * 1.5), 64);
    for (const f of FIELDS) {
      const arr = new Float64Array(cap);
      if (keep) arr.set(this[f].subarray(0, this.length));
      this[f] = arr;
    }
  }
}
