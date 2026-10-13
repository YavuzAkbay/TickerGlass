import type { ChartStyle, ChartType, OhlcvSource, TransformExtra } from '../chart-types';
import type { ChartTheme } from '../options';
import type { PaneSeries, SeriesRenderContext } from './series';
import { drawMainSeries, magnetValuesFor, priceRangeFor, sourceValue } from './types';

const LINE_TYPES: ReadonlySet<ChartType> = new Set([
  'line',
  'lineMarkers',
  'stepLine',
  'area',
  'baseline',
  'columns',
]);

/** What the main series needs from its chart, read on every draw. */
export interface MainSeriesHost {
  readonly view: OhlcvSource;
  readonly chartType: ChartType;
  readonly chartStyle: ChartStyle;
  readonly transformExtra: TransformExtra;
}

/** The symbol's price series, drawn with the active chart type. */
export class MainSeries implements PaneSeries {
  readonly id = 'main';
  title = '';

  constructor(private readonly host: MainSeriesHost) {}

  private get source() {
    const t = this.host.chartType;
    const st = this.host.chartStyle[t] as { source?: string };
    return LINE_TYPES.has(t) && typeof st.source === 'string'
      ? (st.source as Parameters<typeof sourceValue>[2])
      : null;
  }

  priceRange(from: number, to: number): { min: number; max: number } | null {
    const h = this.host;
    return priceRangeFor(
      h.chartType,
      h.view,
      h.chartStyle,
      Math.max(0, from),
      Math.min(to, h.view.length - 1),
      h.transformExtra,
    );
  }

  baseValue(from: number): number | null {
    const v = this.host.view;
    if (!v.length) return null;
    const i = Math.max(0, Math.min(from, v.length - 1));
    const src = this.source;
    return src ? sourceValue(v, i, src) : v.close[i]!;
  }

  lastValue(theme: ChartTheme): { price: number; color: string } | null {
    const v = this.host.view;
    const n = v.length;
    if (!n) return null;
    const src = this.source;
    if (src) {
      const st = this.host.chartStyle[this.host.chartType] as { color?: string };
      const price = sourceValue(v, n - 1, src);
      const prev = n > 1 ? sourceValue(v, n - 2, src) : price;
      return { price, color: st.color ?? (price >= prev ? theme.up : theme.down) };
    }
    const close = v.close[n - 1]!;
    return { price: close, color: close >= v.open[n - 1]! ? theme.up : theme.down };
  }

  valuesAt(i: number): number[] {
    const h = this.host;
    if (i < 0 || i >= h.view.length) return [];
    return magnetValuesFor(h.chartType, h.view, h.chartStyle, i);
  }

  hitTest(i: number, price: number, tol: number): boolean {
    const v = this.host.view;
    if (i < 0 || i >= v.length) return false;
    return price >= v.low[i]! - tol && price <= v.high[i]! + tol;
  }

  draw(rc: SeriesRenderContext): void {
    const h = this.host;
    if (!h.view.length) return;
    drawMainSeries({
      rc,
      data: h.view,
      type: h.chartType,
      style: h.chartStyle,
      extra: h.transformExtra,
    });
  }
}

export type VolumeMode = 'overlay' | 'pane' | 'hidden';

/**
 * Volume histogram. In overlay mode it lives in the bottom of the main pane on
 * its own implicit scale and never affects the price auto-scale.
 */
export class VolumeSeries implements PaneSeries {
  readonly title = 'Volume';
  /** Fraction of the pane height used in overlay mode. */
  overlayHeight = 0.2;

  constructor(
    readonly id: string,
    private readonly host: { readonly view: OhlcvSource },
    public overlay: boolean,
  ) {}

  get excludeFromAutoscale(): boolean {
    return this.overlay;
  }

  priceRange(from: number, to: number): { min: number; max: number } | null {
    if (this.overlay) return null;
    const max = this.maxVolume(from, to);
    return max > 0 ? { min: 0, max } : null;
  }

  baseValue(): number | null {
    return null;
  }

  lastValue(theme: ChartTheme): { price: number; color: string } | null {
    if (this.overlay) return null;
    const v = this.host.view;
    const n = v.length;
    if (!n) return null;
    return {
      price: v.volume[n - 1]!,
      color: v.close[n - 1]! >= v.open[n - 1]! ? theme.up : theme.down,
    };
  }

  valuesAt(i: number): number[] {
    const v = this.host.view;
    return i >= 0 && i < v.length && !this.overlay ? [v.volume[i]!] : [];
  }

  hitTest(): boolean {
    return false;
  }

  private maxVolume(from: number, to: number): number {
    const v = this.host.view;
    let max = 0;
    for (let i = Math.max(0, from); i <= to && i < v.length; i++)
      if (v.volume[i]! > max) max = v.volume[i]!;
    return max;
  }

  draw(rc: SeriesRenderContext): void {
    const { ctx, dpr, timeScale: ts, priceScale: ps, theme, from, to, height } = rc;
    const v = this.host.view;
    const max = this.maxVolume(from, to);
    if (max <= 0) return;
    const bottom = Math.round(height * dpr);
    const yOf = this.overlay
      ? (vol: number) => Math.round((height - (vol / max) * height * this.overlayHeight) * dpr)
      : (vol: number) => Math.round(ps.priceToY(vol) * dpr);
    const spacing = ts.barSpacing * dpr;
    let w = Math.max(1, Math.floor(spacing * 0.8));
    if (w > 2 && w % 2 === 0) w -= 1;
    const half = w >> 1;
    for (const up of [true, false]) {
      ctx.fillStyle = (up ? theme.up : theme.down) + '80';
      for (let i = from; i <= to; i++) {
        if (v.close[i]! >= v.open[i]! !== up) continue;
        const x = Math.round(ts.indexToX(i) * dpr);
        const y = yOf(v.volume[i]!);
        ctx.fillRect(x - half, y, w, Math.max(1, bottom - y));
      }
    }
  }
}
