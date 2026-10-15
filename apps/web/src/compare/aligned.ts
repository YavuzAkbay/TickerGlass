// Aligned external series: another symbol's bars joined onto the displayed
// bars with Compare's rules (docs/compare.md §3: left as-of join on the main
// series, keys per interval mode, bounded staleness). Pure; used by the
// indicator controller to feed external symbols to the indicator worker. The
// join primitives live in the engine (feed/expression/align.ts).
import {
  alignKeys,
  alignModeFor,
  asOfIndex,
  asOfIndexAt,
  calendarContext,
  createBucketContext,
  lowerBound,
  maxStaleSeconds,
  type AlignMode,
  type Bar,
  type BarColumns,
  type BucketContext,
  type Interval,
} from '@investopen/engine';

const UTC_CTX = createBucketContext({ timezone: null, session: null });

/** Join axis of the displayed bars. */
export interface AlignGrid {
  mode: AlignMode;
  /** Longest gap (seconds) a value is carried forward. */
  stale: number;
  ctx: BucketContext;
  /** Join key per displayed bar. */
  keys: number[];
}

export function buildGrid(
  interval: Interval,
  time: ArrayLike<number>,
  n: number,
  timezone: string | null,
): AlignGrid {
  const mode = alignModeFor(interval);
  const ctx = mode === 'calendar' && n ? calendarContext(timezone, time, n) : UTC_CTX;
  return {
    mode,
    stale: maxStaleSeconds(interval),
    ctx,
    keys: n ? Array.from(alignKeys(time, n, mode, ctx)) : [],
  };
}

/** Append the key of displayed bar time `t`. */
export function pushGridKey(grid: AlignGrid, t: number): void {
  grid.keys.push(alignKeys([t], 1, grid.mode, grid.ctx)[0]!);
}

const COLUMNS = ['open', 'high', 'low', 'close', 'volume'] as const;

/** One fetched symbol series (ascending times) with its join keys. */
export class AlignedSeries {
  time: number[] = [];
  open: number[] = [];
  high: number[] = [];
  low: number[] = [];
  close: number[] = [];
  volume: number[] = [];
  keys: number[] = [];
  ctx: BucketContext = UTC_CTX;

  constructor(readonly timezone: string | null) {}

  get length(): number {
    return this.time.length;
  }

  /** Bars before the current ones (older history). */
  prepend(bars: BarColumns, len: number): void {
    const pre = (cur: number[], src: ArrayLike<number>) => [
      ...Array.from(src).slice(0, len),
      ...cur,
    ];
    this.time = pre(this.time, bars.time);
    for (const c of COLUMNS) this[c] = pre(this[c], bars[c]);
  }

  /** Replace all bars. */
  set(bars: BarColumns, len: number): void {
    this.time = Array.from(bars.time).slice(0, len);
    for (const c of COLUMNS) this[c] = Array.from(bars[c]).slice(0, len);
  }

  /** Recompute join keys (after set/prepend). */
  rekey(grid: AlignGrid): void {
    const n = this.time.length;
    this.ctx = grid.mode === 'calendar' ? calendarContext(this.timezone, this.time, n) : UTC_CTX;
    this.keys = Array.from(alignKeys(this.time, n, grid.mode, this.ctx));
  }

  /**
   * Live bar (replace the last or append). Returns the first displayed row it
   * may change, or -1 when ignored (older than the last bar).
   */
  upsert(bar: Bar, grid: AlignGrid): number {
    const n = this.time.length;
    const last = n ? this.time[n - 1]! : -Infinity;
    if (bar.time < last) return -1;
    const put = (i: number) => {
      this.open[i] = bar.open;
      this.high[i] = bar.high;
      this.low[i] = bar.low;
      this.close[i] = bar.close;
      this.volume[i] = bar.volume;
    };
    if (bar.time === last) put(n - 1);
    else {
      this.time.push(bar.time);
      put(n);
      this.keys.push(alignKeys([bar.time], 1, grid.mode, this.ctx)[0]!);
    }
    return lowerBound(grid.keys, grid.keys.length, this.keys[this.keys.length - 1]!);
  }

  /**
   * Columns for displayed rows [from, n): time of the displayed bars, prices
   * of the latest series bar at or before each (NaN where none within the
   * staleness bound).
   */
  columns(grid: AlignGrid, time: ArrayLike<number>, from: number): BarColumns {
    const n = grid.keys.length;
    const len = n - from;
    const out: BarColumns = {
      time: new Float64Array(len),
      open: new Float64Array(len),
      high: new Float64Array(len),
      low: new Float64Array(len),
      close: new Float64Array(len),
      volume: new Float64Array(len),
    };
    const idx =
      from === 0 ? asOfIndex(grid.keys, n, this.keys, this.keys.length, grid.stale) : null;
    for (let i = from; i < n; i++) {
      const j = idx ? idx[i]! : asOfIndexAt(grid.keys[i]!, this.keys, this.keys.length, grid.stale);
      const k = i - from;
      out.time[k] = time[i]!;
      for (const c of COLUMNS) out[c][k] = j >= 0 ? this[c][j]! : NaN;
    }
    return out;
  }
}
