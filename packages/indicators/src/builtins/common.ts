import type { StepContext, Streaming, Ta, WeightedStreaming } from '../types';

/** Default colours shared by the built-ins (mirrors the engine's PALETTE). */
export const COLOR = {
  blue: '#6E9BD6',
  orange: '#E0A93B',
  purple: '#8e5cf6',
  red: '#DE6A4F',
  pink: '#e8618c',
  green: '#8bc34a',
  brightRed: '#DE6A4F',
  yellow: '#E0A93B',
  level: '#A39E8F',
  levelMiddle: 'rgba(154, 164, 178, 0.5)',
  blueFill: 'rgba(110, 155, 214, 0.1)',
  blueFillLight: 'rgba(110, 155, 214, 0.05)',
  purpleFill: 'rgba(142, 92, 246, 0.1)',
} as const;

/** Moving-average choices offered by inputs (conventional names). */
export const MA_TYPES = ['SMA', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'] as const;
export type MaType = (typeof MA_TYPES)[number];

/**
 * Moving average selected by an enum input. Must be called in `setup`.
 * `update(x, volume)`: the volume is only used by VWMA.
 */
export function movingAverage(ta: Ta, type: MaType, length: number): WeightedStreaming {
  if (type === 'VWMA') return ta.vwma(length);
  const ma: Streaming =
    type === 'EMA'
      ? ta.ema(length)
      : type === 'SMMA (RMA)'
        ? ta.rma(length)
        : type === 'WMA'
          ? ta.wma(length)
          : ta.sma(length);
  return { update: (x) => ma.update(x) };
}

type Ohlc = Pick<StepContext, 'i' | 'high' | 'low' | 'close'>;

/**
 * True range of bar `c.i`. On the first bar (no previous close) it is NaN, or
 * high - low with `handleNa` (used by `ta.atr`).
 */
export function trueRange(c: Ohlc, handleNa: boolean): number {
  const h = c.high[c.i]!;
  const l = c.low[c.i]!;
  if (c.i === 0) return handleNa ? h - l : NaN;
  const pc = c.close[c.i - 1]!;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

/** `x - x[1]` for bar `c.i` of `arr` (NaN on the first bar). */
export function change(arr: Float64Array, i: number): number {
  return i > 0 ? arr[i]! - arr[i - 1]! : NaN;
}

/**
 * Wilder RSI: rma of gains / losses seeded with their SMA. Feed
 * the bar-to-bar change of the source. Must be called in `setup`.
 */
export function rsiOf(ta: Ta, length: number): Streaming {
  const up = ta.rma(length);
  const down = ta.rma(length);
  return {
    update(ch: number): number {
      const u = up.update(Math.max(ch, 0));
      const d = down.update(-Math.min(ch, 0));
      return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
    },
  };
}

/** Stochastic position of x in [lo, hi] in percent (NaN for an empty range). */
export function stochValue(x: number, hi: number, lo: number): number {
  const range = hi - lo;
  return range === 0 ? NaN : (100 * (x - lo)) / range;
}
