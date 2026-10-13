import type { BarArrays, BarInput, PriceSource } from './types';

const BASE = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;
const DERIVED = ['hl2', 'hlc3', 'ohlc4', 'hlcc4'] as const;
type Column = (typeof BASE)[number] | (typeof DERIVED)[number];

/**
 * Growable columnar bars plus derived price sources (hl2, hlc3, ohlc4, hlcc4),
 * owned by the runtime. Arrays are reallocated when capacity grows, so read
 * them fresh for every compute call.
 */
export class BarStore {
  time = new Float64Array(0);
  open = new Float64Array(0);
  high = new Float64Array(0);
  low = new Float64Array(0);
  close = new Float64Array(0);
  volume = new Float64Array(0);
  hl2 = new Float64Array(0);
  hlc3 = new Float64Array(0);
  ohlc4 = new Float64Array(0);
  hlcc4 = new Float64Array(0);
  length = 0;

  setAll(cols: BarArrays): void {
    const n = cols.time.length;
    this.ensureCapacity(n, false);
    for (const f of BASE) {
      const from = cols[f];
      const to = this[f];
      if (from instanceof Float64Array) to.set(from.subarray(0, n));
      else for (let i = 0; i < n; i++) to[i] = from[i]!;
    }
    this.length = n;
    for (let i = 0; i < n; i++) this.derive(i);
  }

  clear(): void {
    this.length = 0;
  }

  /**
   * Index-based update: `index === length - 1` replaces the last bar,
   * `index === length` appends. Anything else means the host must resend all
   * bars (brick charts can rebuild earlier indices).
   */
  setBar(index: number, bar: BarInput): 'update' | 'append' {
    const n = this.length;
    if (index !== n - 1 && index !== n)
      throw new RangeError(`Bar index ${index} is not the last (${n - 1}) or next (${n}) bar`);
    if (index === n) {
      this.ensureCapacity(n + 1, true);
      this.length = n + 1;
    }
    this.write(index, bar);
    return index === n ? 'append' : 'update';
  }

  /** Time-based upsert for time bars (timeframe series). */
  upsert(bar: BarInput): 'update' | 'append' | 'ignored' {
    const n = this.length;
    if (n > 0) {
      const last = this.time[n - 1]!;
      if (bar.time < last) return 'ignored';
      if (bar.time === last) return this.setBar(n - 1, bar);
    }
    return this.setBar(n, bar);
  }

  source(s: PriceSource): Float64Array {
    return this[s];
  }

  /** Largest index with time <= t, or -1 (times are non-decreasing). */
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

  private write(i: number, bar: BarInput): void {
    this.time[i] = bar.time;
    this.open[i] = bar.open;
    this.high[i] = bar.high;
    this.low[i] = bar.low;
    this.close[i] = bar.close;
    this.volume[i] = bar.volume;
    this.derive(i);
  }

  private derive(i: number): void {
    const h = this.high[i]!;
    const l = this.low[i]!;
    const c = this.close[i]!;
    this.hl2[i] = (h + l) / 2;
    this.hlc3[i] = (h + l + c) / 3;
    this.ohlc4[i] = (this.open[i]! + h + l + c) / 4;
    this.hlcc4[i] = (h + l + c + c) / 4;
  }

  private ensureCapacity(n: number, keep: boolean): void {
    if (this.time.length >= n) return;
    const cap = Math.max(n, Math.ceil(this.time.length * 1.5), 64);
    for (const f of [...BASE, ...DERIVED] as Column[]) {
      const arr = new Float64Array(cap);
      if (keep) arr.set(this[f].subarray(0, this.length));
      this[f] = arr;
    }
  }
}
