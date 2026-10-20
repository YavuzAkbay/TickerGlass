import type { SeriesStore } from '../model/series-store';
import type { ChartTheme } from '../options';
import type { PriceScale } from '../scale/price-scale';
import type { TimeScale } from '../scale/time-scale';

export interface SeriesRenderContext {
  ctx: CanvasRenderingContext2D; // device-pixel transform
  dpr: number;
  width: number; // css px
  height: number; // css px
  timeScale: TimeScale;
  priceScale: PriceScale;
  theme: ChartTheme;
  from: number;
  to: number;
}

export interface LegendValue {
  label: string;
  value: string;
  color: string;
}

/** Anything drawn inside a pane against its price scale. */
export interface PaneSeries {
  readonly id: string;
  readonly title: string;
  /** Drawn on its own implicit scale; ignored by the pane's auto-scale. */
  readonly excludeFromAutoscale?: boolean;
  /** Drawn behind the other series and hit-tested after them (e.g. the volume overlay). */
  readonly behind?: boolean;
  /** Price range (price units) over bar indices [from, to], or null if empty. */
  priceRange(from: number, to: number): { min: number; max: number } | null;
  /** Price used as base for percent/indexed modes. */
  baseValue(from: number): number | null;
  draw(rc: SeriesRenderContext): void;
  /** Latest value + colour for the axis label, or null. */
  lastValue(theme: ChartTheme): { price: number; color: string } | null;
  /** Value at bar index for crosshair snapping (magnet) and hit testing. */
  valuesAt(i: number): number[];
  hitTest(i: number, priceAtY: number, tolerancePrice: number): boolean;
}

/** Main OHLC candles drawn from the chart's SeriesStore. */
export class CandleSeries implements PaneSeries {
  readonly id = 'main';
  title = '';

  constructor(private readonly store: SeriesStore) {}

  priceRange(from: number, to: number): { min: number; max: number } | null {
    const s = this.store;
    let min = Infinity;
    let max = -Infinity;
    for (let i = Math.max(0, from); i <= to && i < s.length; i++) {
      if (s.low[i]! < min) min = s.low[i]!;
      if (s.high[i]! > max) max = s.high[i]!;
    }
    return min <= max ? { min, max } : null;
  }

  baseValue(from: number): number | null {
    const i = Math.max(0, Math.min(from, this.store.length - 1));
    return this.store.length ? this.store.close[i]! : null;
  }

  lastValue(theme: ChartTheme): { price: number; color: string } | null {
    const s = this.store;
    const n = s.length;
    if (!n) return null;
    const close = s.close[n - 1]!;
    const up = close >= s.open[n - 1]!;
    return { price: close, color: up ? theme.up : theme.down };
  }

  valuesAt(i: number): number[] {
    const s = this.store;
    if (i < 0 || i >= s.length) return [];
    return [s.open[i]!, s.high[i]!, s.low[i]!, s.close[i]!];
  }

  hitTest(i: number, price: number, tol: number): boolean {
    const s = this.store;
    if (i < 0 || i >= s.length) return false;
    return price >= s.low[i]! - tol && price <= s.high[i]! + tol;
  }

  draw(rc: SeriesRenderContext): void {
    const { ctx, dpr, timeScale: ts, priceScale: ps, theme, from, to } = rc;
    const s = this.store;
    const spacingDev = ts.barSpacing * dpr;
    // Body width in device px: odd so the wick centres exactly.
    let body = Math.floor(spacingDev * 0.75);
    if (body >= 3 && body % 2 === 0) body -= 1;
    const wick = Math.max(1, Math.floor(dpr));
    const bodiesVisible = body >= 3;

    for (const up of [true, false]) {
      ctx.fillStyle = up ? theme.wickUp : theme.wickDown;
      // Wicks (or whole bars when too narrow for bodies).
      for (let i = from; i <= to; i++) {
        const o = s.open[i]!;
        const c = s.close[i]!;
        if (c >= o !== up) continue;
        const xc = Math.round(ts.indexToX(i) * dpr);
        const yh = Math.round(ps.priceToY(s.high[i]!) * dpr);
        const yl = Math.round(ps.priceToY(s.low[i]!) * dpr);
        const top = Math.min(yh, yl);
        ctx.fillRect(xc - (wick >> 1), top, wick, Math.max(1, Math.abs(yl - yh)));
      }
      if (!bodiesVisible) continue;
      ctx.fillStyle = up ? theme.up : theme.down;
      const half = body >> 1;
      for (let i = from; i <= to; i++) {
        const o = s.open[i]!;
        const c = s.close[i]!;
        if (c >= o !== up) continue;
        const xc = Math.round(ts.indexToX(i) * dpr);
        const yo = Math.round(ps.priceToY(o) * dpr);
        const yc = Math.round(ps.priceToY(c) * dpr);
        const top = Math.min(yo, yc);
        ctx.fillRect(xc - half, top, body, Math.max(1, Math.abs(yc - yo)));
      }
    }
  }
}

/** Simple line over values aligned to the main series indices. */
export class LineSeries implements PaneSeries {
  constructor(
    readonly id: string,
    readonly title: string,
    private readonly values: () => Float64Array,
    private readonly length: () => number,
    public color = '#4f6bed',
    public lineWidth = 1.5,
  ) {}

  priceRange(from: number, to: number): { min: number; max: number } | null {
    const v = this.values();
    let min = Infinity;
    let max = -Infinity;
    for (let i = Math.max(0, from); i <= to && i < this.length(); i++) {
      const x = v[i]!;
      if (Number.isNaN(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    return min <= max ? { min, max } : null;
  }

  baseValue(from: number): number | null {
    const v = this.values();
    for (let i = Math.max(0, from); i < this.length(); i++) if (!Number.isNaN(v[i]!)) return v[i]!;
    return null;
  }

  lastValue(): { price: number; color: string } | null {
    const n = this.length();
    const v = this.values()[n - 1];
    return n && v !== undefined && !Number.isNaN(v) ? { price: v, color: this.color } : null;
  }

  valuesAt(i: number): number[] {
    const v = this.values()[i];
    return v === undefined || Number.isNaN(v) ? [] : [v];
  }

  hitTest(i: number, price: number, tol: number): boolean {
    const v = this.values()[i];
    return v !== undefined && Math.abs(v - price) <= tol;
  }

  draw(rc: SeriesRenderContext): void {
    const { ctx, dpr, timeScale: ts, priceScale: ps, from, to } = rc;
    const v = this.values();
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth * dpr;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (let i = Math.max(0, from - 1); i <= Math.min(to + 1, this.length() - 1); i++) {
      const val = v[i]!;
      if (Number.isNaN(val)) {
        pen = false;
        continue;
      }
      const x = ts.indexToX(i) * dpr;
      const y = ps.priceToY(val) * dpr;
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
}
