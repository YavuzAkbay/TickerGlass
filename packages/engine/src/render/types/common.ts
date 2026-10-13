import type { OhlcvSource, PriceSource } from '../../chart-types';

/** Price value for a line-like source at bar i. */
export function sourceValue(data: OhlcvSource, i: number, source: PriceSource): number {
  switch (source) {
    case 'open':
      return data.open[i]!;
    case 'high':
      return data.high[i]!;
    case 'low':
      return data.low[i]!;
    case 'close':
      return data.close[i]!;
    case 'hl2':
      return (data.high[i]! + data.low[i]!) / 2;
    case 'hlc3':
      return (data.high[i]! + data.low[i]! + data.close[i]!) / 3;
    case 'ohlc4':
      return (data.open[i]! + data.high[i]! + data.low[i]! + data.close[i]!) / 4;
  }
}

/** Body width in device px for a ratio of the bar spacing; odd (>= 3) so a 1px wick centres. */
export function bodyWidth(spacingDev: number, ratio: number): number {
  let w = Math.floor(spacingDev * ratio);
  if (w >= 3 && w % 2 === 0) w -= 1;
  return w;
}

/** Thin line width in device px: one css pixel, rounded down, never below 1. */
export function thinWidth(dpr: number): number {
  return Math.max(1, Math.floor(dpr));
}

/**
 * Up/down classification. `byPrev` compares close with the previous close (falling
 * back to the bar's open for the first bar), otherwise close with open.
 */
export function isUp(data: OhlcvSource, i: number, byPrev: boolean): boolean {
  const c = data.close[i]!;
  if (byPrev && i > 0) return c >= data.close[i - 1]!;
  return c >= data.open[i]!;
}

/** Offset that puts a stroke of `width` device px on whole pixels. */
export function strokeAlign(width: number): number {
  return Math.round(width) % 2 === 1 ? 0.5 : 0;
}
