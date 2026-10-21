import type { Change, IndicatorRuntime } from '../src/runtime';
import type { BarArrays, BarInput, IndicatorResult } from '../src/types';

export const DAY = 86_400;

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

/** Columns as Float64Arrays (writable). */
export type BarColumns = { [K in keyof BarArrays]: Float64Array };

export function sliceBars(cols: BarArrays, from: number, to: number): BarColumns {
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

/** UTC-day bars (time = day start) aggregated from `cols[0, to)`. */
export function dailyBars(cols: BarArrays, to = cols.time.length): BarInput[] {
  const out: BarInput[] = [];
  for (let i = 0; i < to; i++) {
    const b = barAt(cols, i);
    const day = Math.floor(b.time / DAY) * DAY;
    const last = out[out.length - 1];
    if (last && last.time === day) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else out.push({ ...b, time: day });
  }
  return out;
}

export function toColumns(bars: BarInput[]): BarColumns {
  const col = (k: keyof BarInput) => Float64Array.from(bars, (b) => b[k]);
  return {
    time: col('time'),
    open: col('open'),
    high: col('high'),
    low: col('low'),
    close: col('close'),
    volume: col('volume'),
  };
}

/** The intra-bar states a live bar goes through before it closes. */
export function ticks(b: BarInput): BarInput[] {
  const o = b.open;
  return [
    { ...b, high: o, low: o, close: o, volume: b.volume * 0.1 },
    { ...b, close: (o + b.close) / 2, volume: b.volume * 0.6 },
    b,
  ];
}

/**
 * Feed `cols` to `rt` as history up to `from`, then bar by bar as live ticks
 * (append + updates). With `tf`, the timeframe series is fed the same way,
 * aggregated into UTC days. `external` holds chart-aligned bars of external
 * symbols, fed the same way.
 */
export function feedLive(
  rt: IndicatorRuntime,
  cols: BarArrays,
  from: number,
  tf = '',
  external: Readonly<Record<string, BarArrays>> = {},
): void {
  rt.setBars(sliceBars(cols, 0, from));
  for (const [symbol, ext] of Object.entries(external))
    rt.setExternal(symbol, sliceBars(ext, 0, from));
  if (tf) rt.setTimeframeBars(tf, toColumns(dailyBars(cols, from)));
  const n = cols.time.length;
  for (let i = from; i < n; i++) {
    const partial = sliceBars(cols, 0, i + 1);
    // External bars first: the series may be ahead of the chart, never behind.
    for (const [symbol, ext] of Object.entries(external))
      rt.updateExternal(symbol, i, sliceBars(ext, i, i + 1));
    for (const t of ticks(barAt(cols, i))) {
      rt.updateBar(i, t);
      if (tf) {
        partial.high[i] = t.high;
        partial.low[i] = t.low;
        partial.close[i] = t.close;
        partial.volume[i] = t.volume;
        const days = dailyBars(partial);
        rt.updateTimeframeBar(tf, days[days.length - 1]!);
      }
    }
  }
}

/** Ticks that push the high/low far out and back (pivots created, cancelled, moved). */
export function swingTicks(b: BarInput): BarInput[] {
  const o = b.open;
  return [
    { ...b, high: o, low: o, close: o },
    { ...b, high: b.high * 1.04, close: b.high * 1.04 },
    { ...b, low: b.low * 0.96, close: b.low * 0.96 },
    { ...b, high: b.high * 1.08, low: b.low * 0.92 },
    b,
  ];
}

/**
 * Feed `cols` to `rt` as history up to `from`, then each bar as the live
 * ticks `ticksOf` gives. Returns the changes of every tick, in order.
 */
export function feedTicks(
  rt: IndicatorRuntime,
  cols: BarArrays,
  from: number,
  ticksOf: (b: BarInput) => BarInput[],
): Change[][] {
  rt.setBars(sliceBars(cols, 0, from));
  const all: Change[][] = [];
  for (let i = from; i < cols.time.length; i++)
    for (const t of ticksOf(barAt(cols, i))) all.push(rt.updateBar(i, t));
  return all;
}

/** Exact copy of a result's live range, for equality checks (NaN-safe via toEqual). */
export function snapshot(r: IndicatorResult): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(r.values)) out[k] = Array.from(v.subarray(0, r.length));
  for (const [k, c] of Object.entries(r.colors))
    out[`${k}.color`] = Array.from(c.subarray(0, r.length));
  return out;
}
