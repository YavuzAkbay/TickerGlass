import type { History, SeriesVar, Streaming, Ta, WeightedStreaming } from './types';

/**
 * Snapshot/restore hook every primitive implements. The runtime calls `save`
 * right before stepping a bar that may be re-run (the last bar) and `restore`
 * before re-running it. One saved slot per primitive is enough because only
 * the last bar is ever re-run.
 */
export interface Stateful {
  save(): void;
  restore(): void;
}

/** Fixed-size ring buffer whose save/restore is O(1). */
class Ring implements Stateful {
  readonly buf: Float64Array;
  /** Next write slot. */
  head = 0;
  count = 0;
  private savedHead = 0;
  private savedCount = 0;
  /** Value in the slot the next push overwrites (needed to rewind it). */
  private savedSlot = NaN;

  constructor(readonly size: number) {
    this.buf = new Float64Array(Math.max(1, size)).fill(NaN);
  }

  /** Push x; returns the value that fell out (NaN while filling). */
  push(x: number): number {
    const out = this.count === this.size ? this.buf[this.head]! : NaN;
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.size;
    if (this.count < this.size) this.count++;
    return out;
  }

  /** k = 0 newest. */
  get(k: number): number {
    if (k < 0 || k >= this.count) return NaN;
    return this.buf[(this.head - 1 - k + 2 * this.size) % this.size]!;
  }

  get full(): boolean {
    return this.count === this.size;
  }

  save(): void {
    this.savedHead = this.head;
    this.savedCount = this.count;
    this.savedSlot = this.buf[this.head]!;
  }

  restore(): void {
    this.head = this.savedHead;
    this.count = this.savedCount;
    this.buf[this.head] = this.savedSlot;
  }
}

function checkLength(length: number): number {
  if (!Number.isInteger(length) || length < 1) throw new Error(`Invalid length ${length}`);
  return length;
}

class Sum implements Streaming, Stateful {
  private ring: Ring;
  private total = 0;
  private savedTotal = 0;

  constructor(length: number) {
    this.ring = new Ring(checkLength(length));
  }

  update(x: number): number {
    if (Number.isNaN(x)) return NaN;
    const out = this.ring.push(x);
    this.total += x;
    if (!Number.isNaN(out)) this.total -= out;
    return this.ring.full ? this.total : NaN;
  }

  save(): void {
    this.ring.save();
    this.savedTotal = this.total;
  }

  restore(): void {
    this.ring.restore();
    this.total = this.savedTotal;
  }
}

class Sma implements Streaming, Stateful {
  private sum: Sum;

  constructor(private readonly length: number) {
    this.sum = new Sum(length);
  }

  update(x: number): number {
    return this.sum.update(x) / this.length;
  }

  save(): void {
    this.sum.save();
  }

  restore(): void {
    this.sum.restore();
  }
}

/** Exponential smoothing seeded with the SMA of the first `length` values. */
class Smoothed implements Streaming, Stateful {
  private seed: Sma;
  private prev = NaN;
  private savedPrev = NaN;

  constructor(
    length: number,
    private readonly alpha: number,
  ) {
    this.seed = new Sma(checkLength(length));
  }

  update(x: number): number {
    if (Number.isNaN(x)) return NaN;
    if (Number.isNaN(this.prev)) {
      this.prev = this.seed.update(x);
      return this.prev;
    }
    this.prev = this.alpha * x + (1 - this.alpha) * this.prev;
    return this.prev;
  }

  save(): void {
    this.seed.save();
    this.savedPrev = this.prev;
  }

  restore(): void {
    this.seed.restore();
    this.prev = this.savedPrev;
  }
}

/** Population standard deviation, recomputed over the window (stable). */
class Stdev implements Streaming, Stateful {
  private ring: Ring;

  constructor(length: number) {
    this.ring = new Ring(checkLength(length));
  }

  update(x: number): number {
    if (Number.isNaN(x)) return NaN;
    this.ring.push(x);
    if (!this.ring.full) return NaN;
    const buf = this.ring.buf;
    const n = this.ring.size;
    let mean = 0;
    for (let k = 0; k < n; k++) mean += buf[k]!;
    mean /= n;
    let ss = 0;
    for (let k = 0; k < n; k++) ss += (buf[k]! - mean) ** 2;
    return Math.sqrt(ss / n);
  }

  save(): void {
    this.ring.save();
  }

  restore(): void {
    this.ring.restore();
  }
}

/**
 * Rolling max/min with a monotonic deque: amortised O(1) per bar. The deque
 * lives in fixed circular arrays; one update writes exactly one slot, so a
 * snapshot is the pointers plus the old content of that slot (recorded on the
 * first write after `save`/`restore`).
 */
class Extreme implements Streaming, Stateful {
  private readonly cap: number;
  private readonly idx: Float64Array;
  private readonly val: Float64Array;
  /** Absolute positions; slot = pos % cap. Deque = [head, tail). */
  private head = 0;
  private tail = 0;
  /** Number of values fed so far (also the next value's index). */
  private seen = 0;
  private saved = { head: 0, tail: 0, seen: 0, slot: -1, idx: NaN, val: NaN };
  private recorded = false;

  constructor(
    private readonly length: number,
    private readonly max: boolean,
  ) {
    this.cap = checkLength(length) + 1;
    this.idx = new Float64Array(this.cap);
    this.val = new Float64Array(this.cap);
  }

  update(x: number): number {
    if (Number.isNaN(x)) return NaN;
    const cap = this.cap;
    while (this.tail > this.head) {
      const last = this.val[(this.tail - 1) % cap]!;
      if (this.max ? last > x : last < x) break;
      this.tail--;
    }
    const slot = this.tail % cap;
    if (!this.recorded) {
      this.recorded = true;
      this.saved.slot = slot;
      this.saved.idx = this.idx[slot]!;
      this.saved.val = this.val[slot]!;
    }
    this.idx[slot] = this.seen;
    this.val[slot] = x;
    this.tail++;
    while (this.idx[this.head % cap]! <= this.seen - this.length) this.head++;
    this.seen++;
    return this.seen >= this.length ? this.val[this.head % cap]! : NaN;
  }

  save(): void {
    this.saved.head = this.head;
    this.saved.tail = this.tail;
    this.saved.seen = this.seen;
    this.saved.slot = -1;
    this.recorded = false;
  }

  restore(): void {
    const s = this.saved;
    if (s.slot >= 0) {
      this.idx[s.slot] = s.idx;
      this.val[s.slot] = s.val;
    }
    this.head = s.head;
    this.tail = s.tail;
    this.seen = s.seen;
    this.recorded = false;
  }
}

/**
 * Linearly weighted moving average (newest weight = length), O(1) per bar:
 * with S the window sum and W the weighted sum, a new value x gives
 * W' = W - S + length * x and S' = S - out + x.
 */
class Wma implements Streaming, Stateful {
  private ring: Ring;
  private s = 0;
  private w = 0;
  private savedS = 0;
  private savedW = 0;

  constructor(private readonly length: number) {
    this.ring = new Ring(checkLength(length));
  }

  update(x: number): number {
    if (Number.isNaN(x)) return NaN;
    const n = this.length;
    const wasFull = this.ring.full;
    const out = this.ring.push(x);
    if (wasFull) {
      this.w += n * x - this.s;
      this.s += x - out;
    } else {
      // Weights while filling are relative to the final position; recompute
      // exactly once the window is complete.
      this.s += x;
      if (!this.ring.full) return NaN;
      this.w = 0;
      for (let k = 0; k < n; k++) this.w += (n - k) * this.ring.get(k);
    }
    return this.w / ((n * (n + 1)) / 2);
  }

  save(): void {
    this.ring.save();
    this.savedS = this.s;
    this.savedW = this.w;
  }

  restore(): void {
    this.ring.restore();
    this.s = this.savedS;
    this.w = this.savedW;
  }
}

/** Volume-weighted moving average: sum(x * w) / sum(w) over `length` bars. */
class Vwma implements WeightedStreaming, Stateful {
  private xw: Sum;
  private w: Sum;

  constructor(length: number) {
    this.xw = new Sum(length);
    this.w = new Sum(length);
  }

  update(x: number, w: number): number {
    if (Number.isNaN(x) || Number.isNaN(w)) return NaN;
    return this.xw.update(x * w) / this.w.update(w);
  }

  save(): void {
    this.xw.save();
    this.w.save();
  }

  restore(): void {
    this.xw.restore();
    this.w.restore();
  }
}

/** Mean absolute deviation from the window mean (standard `ta.dev`, CCI). */
class Dev implements Streaming, Stateful {
  private ring: Ring;

  constructor(length: number) {
    this.ring = new Ring(checkLength(length));
  }

  update(x: number): number {
    if (Number.isNaN(x)) return NaN;
    this.ring.push(x);
    if (!this.ring.full) return NaN;
    const buf = this.ring.buf;
    const n = this.ring.size;
    let mean = 0;
    for (let k = 0; k < n; k++) mean += buf[k]!;
    mean /= n;
    let sum = 0;
    for (let k = 0; k < n; k++) sum += Math.abs(buf[k]! - mean);
    return sum / n;
  }

  save(): void {
    this.ring.save();
  }

  restore(): void {
    this.ring.restore();
  }
}

class HistoryBuf implements History, Stateful {
  private ring: Ring;

  constructor(length: number) {
    this.ring = new Ring(checkLength(length));
  }

  push(x: number): void {
    this.ring.push(x);
  }

  get(k: number): number {
    return this.ring.get(k);
  }

  save(): void {
    this.ring.save();
  }

  restore(): void {
    this.ring.restore();
  }
}

class Vars<T extends Record<string, number>> implements Stateful {
  private saved: T;

  constructor(readonly value: T) {
    this.saved = { ...value };
  }

  save(): void {
    this.saved = { ...this.value };
  }

  restore(): void {
    Object.assign(this.value, this.saved);
  }
}

/** Bar-aligned scratch array. Needs no snapshot: re-running bar i rewrites slot i. */
export class GrowableSeries implements SeriesVar {
  private data = new Float64Array(64).fill(NaN);

  get(i: number): number {
    return i >= 0 && i < this.data.length ? this.data[i]! : NaN;
  }

  set(i: number, v: number): void {
    if (i >= this.data.length) {
      const next = new Float64Array(Math.max(i + 1, this.data.length * 2)).fill(NaN);
      next.set(this.data);
      this.data = next;
    }
    this.data[i] = v;
  }
}

/** Primitives created by one `setup` call, so the runtime can snapshot them. */
export class TaScope {
  readonly states: Stateful[] = [];
  /** Set false once setup returns: primitives must not be created per bar. */
  open = true;
  readonly ta: Ta;

  constructor() {
    const add = <T extends Stateful>(s: T): T => {
      if (!this.open) throw new Error('ta primitives must be created in setup(), not in step()');
      this.states.push(s);
      return s;
    };
    this.ta = {
      sma: (n) => add(new Sma(checkLength(n))),
      ema: (n) => add(new Smoothed(n, 2 / (n + 1))),
      rma: (n) => add(new Smoothed(n, 1 / n)),
      sum: (n) => add(new Sum(n)),
      wma: (n) => add(new Wma(n)),
      vwma: (n) => add(new Vwma(n)),
      stdev: (n) => add(new Stdev(n)),
      dev: (n) => add(new Dev(n)),
      highest: (n) => add(new Extreme(n, true)),
      lowest: (n) => add(new Extreme(n, false)),
      history: (n) => add(new HistoryBuf(n)),
      vars: (init) => add(new Vars({ ...init })).value,
      series: () => {
        if (!this.open) throw new Error('ta primitives must be created in setup(), not in step()');
        return new GrowableSeries();
      },
    };
  }

  save(): void {
    for (const s of this.states) s.save();
  }

  restore(): void {
    for (const s of this.states) s.restore();
  }
}
