import type { OhlcvSource } from '../chart-types';

const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;

/** Most bars a single live rebuild may add before we fall back to a reset. */
export const MAX_TAIL_APPENDS = 16;

export interface TailChange {
  kind: 'update' | 'append';
  index: number;
}

/** Bars compared by a live brick diff: the possible appends plus the old last bar. */
export const TAIL_WINDOW = MAX_TAIL_APPENDS + 1;

/**
 * Copy of the last `window` bars of a displayed series: arrays hold bars
 * [offset, length). Live brick rebuilds only change the tail, so comparing it
 * is enough (an earlier change shows up in the window or as a length drop).
 */
export interface SeriesSnapshot {
  readonly offset: number;
  readonly length: number;
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
}

export function snapshotSeries(s: OhlcvSource, window = TAIL_WINDOW): SeriesSnapshot {
  const n = s.length;
  const off = Math.max(0, n - Math.max(1, window));
  const copy = (a: ArrayLike<number>) =>
    a instanceof Float64Array
      ? a.slice(off, n)
      : Float64Array.from({ length: n - off }, (_, k) => a[off + k]!);
  return {
    offset: off,
    length: n,
    time: copy(s.time),
    open: copy(s.open),
    high: copy(s.high),
    low: copy(s.low),
    close: copy(s.close),
    volume: copy(s.volume),
  };
}

/** Bar i of `a` (stored from index `aOff`) equals bar i of `b`. */
function sameBar(
  a: OhlcvSource | SeriesSnapshot,
  aOff: number,
  b: OhlcvSource,
  i: number,
): boolean {
  for (const f of FIELDS) {
    const x = a[f][i - aOff]!;
    const y = b[f][i]!;
    if (x !== y && !(x !== x && y !== y)) return false;
  }
  return true;
}

/**
 * Number of leading bars `next` shares with `prev` (a tail snapshot counts its
 * uncompared bars before `offset` as shared, like `diffTail`).
 */
export function commonPrefix(prev: OhlcvSource | SeriesSnapshot, next: OhlcvSource): number {
  const off = 'offset' in prev ? prev.offset : 0;
  const n = Math.min(prev.length, next.length);
  if (off >= n) return n;
  for (let i = off; i < n; i++) if (!sameBar(prev, off, next, i)) return i;
  return n;
}

/**
 * How a rebuilt series differs from the previous one (`prev` may be a tail
 * snapshot: only its bars are compared). Returns the tail changes in order
 * (update of the old last bar, then appends), [] when nothing changed, or null
 * when a compared bar before the old last one changed or bars were removed
 * (the caller emits a reset).
 */
export function diffTail(
  prev: OhlcvSource | SeriesSnapshot,
  next: OhlcvSource,
): TailChange[] | null {
  const n0 = prev.length;
  const n1 = next.length;
  const off = 'offset' in prev ? prev.offset : 0;
  if (n1 < n0 || n1 - n0 > MAX_TAIL_APPENDS) return null;
  if (n0 === 0) return n1 === 0 ? [] : null;
  for (let i = off; i < n0 - 1; i++) if (!sameBar(prev, off, next, i)) return null;
  const out: TailChange[] = [];
  if (!sameBar(prev, off, next, n0 - 1)) out.push({ kind: 'update', index: n0 - 1 });
  for (let i = n0; i < n1; i++) out.push({ kind: 'append', index: i });
  return out;
}
