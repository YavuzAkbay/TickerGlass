import { linearTicks, logTicks } from './price-ticks';

export type PriceScaleMode = 'linear' | 'log' | 'percent' | 'indexed';

export interface PriceTick {
  /** Value in the scale's display units (price, or % / index for those modes). */
  value: number;
  y: number;
}

const MIN_LOG_PRICE = 1e-12;

/**
 * Vertical scale. Internally works in "internal" coordinates: price for linear,
 * log10(price) for log, percent change / index value relative to `base` for
 * percent / indexed modes. `range` is in internal coordinates.
 */
export class PriceScale {
  height = 0;
  mode: PriceScaleMode = 'linear';
  autoScale = true;
  invert = false;
  marginTop = 0.1;
  marginBottom = 0.08;
  /** Reference price for percent/indexed modes (first visible close). */
  base = 1;
  min = 0;
  max = 1;

  toInternal(price: number): number {
    switch (this.mode) {
      case 'log':
        return Math.log10(Math.max(price, MIN_LOG_PRICE));
      case 'percent':
        return (price / this.base - 1) * 100;
      case 'indexed':
        return (price / this.base) * 100;
      default:
        return price;
    }
  }

  fromInternal(v: number): number {
    switch (this.mode) {
      case 'log':
        return 10 ** v;
      case 'percent':
        return (v / 100 + 1) * this.base;
      case 'indexed':
        return (v / 100) * this.base;
      default:
        return v;
    }
  }

  /** Internal value -> display value shown on the axis. */
  toDisplay(price: number): number {
    return this.mode === 'percent' || this.mode === 'indexed' ? this.toInternal(price) : price;
  }

  private get innerTop(): number {
    return this.height * this.marginTop;
  }

  private get innerHeight(): number {
    return Math.max(1, this.height * (1 - this.marginTop - this.marginBottom));
  }

  internalToY(v: number): number {
    const span = this.max - this.min || 1;
    const t = (this.max - v) / span;
    const y = this.innerTop + t * this.innerHeight;
    return this.invert ? this.height - y : y;
  }

  yToInternal(y: number): number {
    const yy = this.invert ? this.height - y : y;
    const span = this.max - this.min || 1;
    return this.max - ((yy - this.innerTop) / this.innerHeight) * span;
  }

  priceToY(price: number): number {
    return this.internalToY(this.toInternal(price));
  }

  yToPrice(y: number): number {
    return this.fromInternal(this.yToInternal(y));
  }

  /** Apply an auto-scale range given in price units. */
  setAutoRange(minPrice: number, maxPrice: number): void {
    if (!this.autoScale || !Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return;
    let lo = this.toInternal(minPrice);
    let hi = this.toInternal(maxPrice);
    if (hi - lo < 1e-12) {
      const pad = Math.abs(hi) * 0.01 || 1;
      lo -= pad;
      hi += pad;
    }
    this.min = lo;
    this.max = hi;
  }

  /**
   * Fix the scale (auto-scale off) so that [minPrice, maxPrice] fills the area
   * between the margins. Ignored unless both are finite and minPrice < maxPrice.
   */
  setManualRange(minPrice: number, maxPrice: number): void {
    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || !(minPrice < maxPrice)) return;
    const lo = this.toInternal(minPrice);
    const hi = this.toInternal(maxPrice);
    if (!(hi - lo > 1e-12)) return;
    this.autoScale = false;
    this.min = lo;
    this.max = hi;
  }

  /** Stretch around the centre; factor > 1 expands the visible range. */
  scaleBy(factor: number): void {
    this.autoScale = false;
    const mid = (this.min + this.max) / 2;
    const half = ((this.max - this.min) / 2) * factor;
    this.min = mid - half;
    this.max = mid + half;
  }

  panBy(dyPx: number): void {
    this.autoScale = false;
    const perPx = (this.max - this.min) / this.innerHeight;
    const d = dyPx * perPx * (this.invert ? -1 : 1);
    this.min += d;
    this.max += d;
  }

  ticks(minSpacingPx = 30): PriceTick[] {
    const target = Math.max(2, Math.floor(this.height / minSpacingPx));
    const lo = Math.min(this.yToInternal(this.height), this.yToInternal(0));
    const hi = Math.max(this.yToInternal(this.height), this.yToInternal(0));
    if (this.mode === 'log') {
      const pLo = 10 ** lo;
      const pHi = 10 ** hi;
      return logTicks(pLo, pHi, target).map((p) => ({ value: p, y: this.priceToY(p) }));
    }
    // Linear, percent and indexed: nice steps in display units.
    return linearTicks(lo, hi, target).map((v) => ({ value: v, y: this.internalToY(v) }));
  }
}
