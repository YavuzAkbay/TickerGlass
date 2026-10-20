// Main-thread copy of the bars the indicator worker has (docs/plans/user-scripts.md §3).
// `bars` buffers are transferred to the indicator worker, so the router keeps
// this mirror to replay the series to sandboxes it spawns later and to answer
// their resyncs.
import type { Bar, BarColumns } from '@investopen/engine';

const COLUMNS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;

const MIN_CAPACITY = 64;

export class SeriesMirror {
  /** Series revision of the bars held; -1 = none. */
  revision = -1;
  length = 0;
  /**
   * A live bar did not fit (wrong revision or index gap): the bars held are
   * not the chart's until the next `reset`.
   */
  dirty = false;
  private cols: BarColumns = emptyColumns(0);

  /** Bars of `revision` are complete and current. */
  get valid(): boolean {
    return this.revision >= 0 && !this.dirty;
  }

  /** Take a copy of `bars` (call before its buffers are transferred). */
  reset(revision: number, bars: BarColumns): void {
    const n = bars.time.length;
    const cols = emptyColumns(Math.max(MIN_CAPACITY, n));
    for (const k of COLUMNS) cols[k].set(bars[k].subarray(0, n));
    this.cols = cols;
    this.length = n;
    this.revision = revision;
    this.dirty = false;
  }

  /** Symbol change: no bars until the next `reset`. */
  clear(): void {
    this.cols = emptyColumns(0);
    this.length = 0;
    this.revision = -1;
    this.dirty = false;
  }

  /**
   * Live bar: update an existing index or append at `length`. Anything else
   * (other revision, index past the end) marks the mirror dirty; returns
   * whether the bar applied.
   */
  apply(revision: number, index: number, bar: Bar): boolean {
    if (this.dirty || revision !== this.revision) {
      this.dirty = true;
      return false;
    }
    if (!Number.isInteger(index) || index < 0 || index > this.length) {
      this.dirty = true;
      return false;
    }
    if (index === this.length) {
      this.grow(index + 1);
      this.length++;
    }
    for (const k of COLUMNS) this.cols[k][index] = bar[k];
    return true;
  }

  /** Fresh exact-length copies of the bars held (safe to transfer or clone). */
  copyColumns(): BarColumns {
    const n = this.length;
    const out = {} as BarColumns;
    for (const k of COLUMNS) out[k] = this.cols[k].slice(0, n);
    return out;
  }

  private grow(min: number): void {
    const cap = this.cols.time.length;
    if (min <= cap) return;
    const cols = emptyColumns(Math.max(MIN_CAPACITY, cap * 2, min));
    for (const k of COLUMNS) cols[k].set(this.cols[k].subarray(0, this.length));
    this.cols = cols;
  }
}

function emptyColumns(capacity: number): BarColumns {
  return {
    time: new Float64Array(capacity),
    open: new Float64Array(capacity),
    high: new Float64Array(capacity),
    low: new Float64Array(capacity),
    close: new Float64Array(capacity),
    volume: new Float64Array(capacity),
  };
}
