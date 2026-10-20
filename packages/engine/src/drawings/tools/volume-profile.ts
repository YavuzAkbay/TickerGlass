// Volume profile binning (pure): rows, point of control and value area.
//
// Used by Fixed range / Anchored volume profile. Each bar's volume is spread
// evenly over its [low, high] range: a row receives volume * overlap / (high -
// low) (a bar with high === low puts all of it in the row holding that price).
// Volume counts as "up" when close >= open, else "down".
//
// Value area (Market Profile / CBOT convention):
// start with the POC row; while the accumulated volume is below `valueArea`%
// of the total, compare the sum of the next two rows above the area with the
// sum of the next two rows below it and add the larger pair (ties add the
// pair above; near the profile's edge a "pair" may be one row). This may
// overshoot the target by up to one pair.
//
// POC: the row with the largest total volume; ties go to the row nearest the
// middle of the profile, then to the lower row.
import type { DrawingBarData } from '../types';

/** Row count cap (both layouts). */
export const MAX_VP_ROWS = 1000;

export interface VolumeProfileOptions {
  /** 'count': `rows` rows over the range; 'size': rows of `rowSize` price units
   * aligned to multiples of `rowSize`. */
  rowsLayout: 'count' | 'size';
  rows: number;
  rowSize: number;
  /** Value area in percent of the total volume (0..100). */
  valueArea: number;
}

export interface VolumeProfile {
  /** First and last bar used. */
  from: number;
  to: number;
  /** Bottom price of row 0 and the row height (price units; 0 when all bars are flat at one price). */
  start: number;
  rowSize: number;
  rows: number;
  up: Float64Array;
  down: Float64Array;
  /** Lowest low / highest high of the bars used. */
  low: number;
  high: number;
  totalVolume: number;
  /** Largest row total. */
  maxRow: number;
  /** Row indices: point of control, value area low (bottom row) and high (top row). */
  poc: number;
  val: number;
  vah: number;
}

/** Total volume of row `i`. */
export function rowVolume(p: VolumeProfile, i: number): number {
  return p.up[i]! + p.down[i]!;
}

/** Bottom price of row `i` (`i = rows` gives the top of the profile). */
export function rowPrice(p: VolumeProfile, i: number): number {
  return p.start + i * p.rowSize;
}

/** Prices of the POC (row middle), VAH (top of the value area) and VAL (bottom). */
export function profileLevels(p: VolumeProfile): { poc: number; vah: number; val: number } {
  return {
    poc: p.start + (p.poc + 0.5) * p.rowSize,
    vah: rowPrice(p, p.vah + 1),
    val: rowPrice(p, p.val),
  };
}

const finite = (v: number) => v === v && v !== Infinity && v !== -Infinity;

/**
 * Profile of bars [from, to] (inclusive, clamped to the data, any order), or
 * null without a bar with finite prices and positive volume.
 */
export function computeVolumeProfile(
  bars: DrawingBarData,
  from: number,
  to: number,
  o: VolumeProfileOptions,
): VolumeProfile | null {
  if (!finite(from) || !finite(to)) return null;
  const lo = Math.max(0, Math.round(Math.min(from, to)));
  const hi = Math.min(bars.length - 1, Math.round(Math.max(from, to)));
  if (lo > hi) return null;
  let low = Infinity;
  let high = -Infinity;
  let any = false;
  for (let i = lo; i <= hi; i++) {
    const l = bars.low[i]!;
    const h = bars.high[i]!;
    const v = bars.volume[i]!;
    if (!finite(l) || !finite(h) || !finite(v) || v <= 0) continue;
    any = true;
    if (l < low) low = l;
    if (h > high) high = h;
  }
  if (!any) return null;

  let start = low;
  let size: number;
  let rows: number;
  const span = high - low;
  if (span <= 0) {
    rows = 1;
    size = 0;
  } else if (o.rowsLayout === 'size' && o.rowSize > 0) {
    size = o.rowSize;
    start = Math.floor(low / size + 1e-9) * size;
    rows = Math.max(1, Math.ceil((high - start) / size - 1e-9));
    if (rows > MAX_VP_ROWS) {
      rows = MAX_VP_ROWS;
      start = low;
      size = span / rows;
    }
  } else {
    rows = Math.min(MAX_VP_ROWS, Math.max(1, Math.round(o.rows) || 1));
    size = span / rows;
  }

  const up = new Float64Array(rows);
  const down = new Float64Array(rows);
  const rowOf = (price: number) =>
    size > 0 ? Math.min(rows - 1, Math.max(0, Math.floor((price - start) / size))) : 0;
  let total = 0;
  for (let i = lo; i <= hi; i++) {
    const l = bars.low[i]!;
    const h = bars.high[i]!;
    const v = bars.volume[i]!;
    if (!finite(l) || !finite(h) || !finite(v) || v <= 0) continue;
    const out = bars.close[i]! >= bars.open[i]! ? up : down;
    total += v;
    const r0 = rowOf(Math.min(l, h));
    const r1 = rowOf(Math.max(l, h));
    const range = Math.abs(h - l);
    if (range <= 0 || r0 === r1) {
      out[r0]! += v;
      continue;
    }
    for (let r = r0; r <= r1; r++) {
      const ov = Math.min(h, start + (r + 1) * size) - Math.max(l, start + r * size);
      if (ov > 0) out[r]! += (v * ov) / range;
    }
  }

  // Point of control: largest row, ties nearest the middle, then lower.
  const mid = (rows - 1) / 2;
  let poc = 0;
  let maxRow = -1;
  for (let r = 0; r < rows; r++) {
    const t = up[r]! + down[r]!;
    if (t > maxRow || (t === maxRow && Math.abs(r - mid) < Math.abs(poc - mid))) {
      maxRow = t;
      poc = r;
    }
  }

  // Value area: grow from the POC by the larger of the next two rows above/below.
  const target = (total * Math.min(100, Math.max(0, o.valueArea))) / 100;
  let val = poc;
  let vah = poc;
  let acc = maxRow;
  const vol = (r: number) => (r >= 0 && r < rows ? up[r]! + down[r]! : 0);
  while (acc < target && (val > 0 || vah < rows - 1)) {
    const nUp = Math.min(2, rows - 1 - vah);
    const nDown = Math.min(2, val);
    const above = vol(vah + 1) + (nUp > 1 ? vol(vah + 2) : 0);
    const below = vol(val - 1) + (nDown > 1 ? vol(val - 2) : 0);
    if (nUp > 0 && (nDown === 0 || above >= below)) {
      vah += nUp;
      acc += above;
    } else {
      val -= nDown;
      acc += below;
    }
  }

  return {
    from: lo,
    to: hi,
    start,
    rowSize: size,
    rows,
    up,
    down,
    low,
    high,
    totalVolume: total,
    maxRow,
    poc,
    val,
    vah,
  };
}

interface CacheEntry {
  volume: ArrayLike<number>;
  high: ArrayLike<number>;
  length: number;
  from: number;
  to: number;
  layout: string;
  rows: number;
  rowSize: number;
  valueArea: number;
  /** Last bar of the range (updates in place on realtime ticks). */
  last: [number, number, number, number, number];
  profile: VolumeProfile | null;
}

const CACHE_SIZE = 64;
const cache = new Map<string, CacheEntry>();

/**
 * `computeVolumeProfile` memoised per `key` (drawing id): recomputed only when
 * the bar arrays, their length, the range, the options or the range's last bar
 * change, so rendering and hit testing do not rebin every frame.
 */
export function cachedVolumeProfile(
  key: string,
  bars: DrawingBarData,
  from: number,
  to: number,
  o: VolumeProfileOptions,
): VolumeProfile | null {
  const f = Math.round(Math.min(from, to));
  const t = Math.round(Math.max(from, to));
  const li = Math.min(bars.length - 1, t);
  const last: CacheEntry['last'] =
    li >= 0
      ? [bars.open[li]!, bars.high[li]!, bars.low[li]!, bars.close[li]!, bars.volume[li]!]
      : [NaN, NaN, NaN, NaN, NaN];
  const e = cache.get(key);
  if (
    e &&
    e.volume === bars.volume &&
    e.high === bars.high &&
    e.length === bars.length &&
    e.from === f &&
    e.to === t &&
    e.layout === o.rowsLayout &&
    e.rows === o.rows &&
    e.rowSize === o.rowSize &&
    e.valueArea === o.valueArea &&
    e.last.every((v, i) => Object.is(v, last[i]))
  )
    return e.profile;
  const profile = computeVolumeProfile(bars, f, t, o);
  cache.delete(key);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(key, {
    volume: bars.volume,
    high: bars.high,
    length: bars.length,
    from: f,
    to: t,
    layout: o.rowsLayout,
    rows: o.rows,
    rowSize: o.rowSize,
    valueArea: o.valueArea,
    last,
    profile,
  });
  return profile;
}

/** Drop memoised profiles (tests). */
export function clearVolumeProfileCache(): void {
  cache.clear();
}
