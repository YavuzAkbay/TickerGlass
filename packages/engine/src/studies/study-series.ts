import type { OhlcvSource } from '../chart-types';
import type { ChartTheme } from '../options';
import type { PaneSeries, SeriesRenderContext } from '../render/series';
import { PriceScale } from '../scale/price-scale';
import type { TimeScale } from '../scale/time-scale';
import { hitTestStudy, type StudyHitLayer } from './hit';
import { drawSpan, drawStudy, type StudyGeometry } from './render';
import { paletteColor, studyValueRange, type Study } from './study';

/** What a study series reads from its chart. */
export interface StudyHost {
  readonly store: OhlcvSource;
  readonly timeScale: TimeScale;
  readonly seriesRevision: number;
  readonly theme: ChartTheme;
}

/** Fraction of the pane used by studies with `priceScale: 'none'` (as the volume overlay). */
export const OWN_SCALE_HEIGHT = 0.2;

/** Last-value label of one plot. */
export interface StudyLastValue {
  outputId: string;
  price: number;
  color: string;
}

/**
 * Adapter that puts a Study into a pane's series list: auto-scale range,
 * drawing, magnet values and pixel hit testing.
 */
export class StudySeries implements PaneSeries {
  /** Implicit scale for priceScale 'none'. */
  private readonly ownScale = new PriceScale();
  /** Scale and pane size of the last draw (for hit testing). */
  private drawn: { scale: PriceScale; width: number; height: number } | null = null;

  constructor(
    readonly study: Study,
    private readonly host: StudyHost,
  ) {
    this.ownScale.marginTop = 1 - OWN_SCALE_HEIGHT;
    this.ownScale.marginBottom = 0;
  }

  get id(): string {
    return this.study.id;
  }

  get title(): string {
    return this.study.spec.title;
  }

  get excludeFromAutoscale(): boolean {
    return this.study.spec.priceScale === 'none';
  }

  /** Visible and computed on the current displayed series. */
  get active(): boolean {
    return this.study.spec.visible && this.study.isCurrent(this.host.seriesRevision);
  }

  /** Readable data indices. */
  get limit(): number {
    return Math.min(this.study.length, this.host.store.length);
  }

  /** Positions to cover for [from, to] plus the empty space right of the last bar. */
  private span(from: number, to: number): { pFrom: number; pTo: number } {
    const ts = this.host.timeScale;
    const right = Math.ceil(ts.xToLogical(ts.width));
    return { pFrom: from, pTo: Math.max(to, right) };
  }

  priceRange(from: number, to: number): { min: number; max: number } | null {
    if (!this.study.spec.visible || this.excludeFromAutoscale) return null;
    // A fixed range holds even before (re)computed data arrives.
    const fixed = this.study.spec.scaleRange;
    if (fixed) return { min: fixed.min, max: fixed.max };
    if (!this.active) return null;
    const { pFrom, pTo } = this.span(from, to);
    return studyValueRange(this.study, pFrom, pTo, this.limit);
  }

  baseValue(from: number): number | null {
    if (!this.active || this.excludeFromAutoscale) return null;
    for (const o of this.study.spec.outputs) {
      if (o.type !== 'plot' || !o.visible) continue;
      const v = this.study.values[o.id]?.[from - o.offset];
      if (v !== undefined && Number.isFinite(v)) return v;
    }
    return null;
  }

  /** Study last values are drawn by the chart (see lastValues). */
  lastValue(): null {
    return null;
  }

  /** Last values of visible plots with showLastValue (pane-scale studies only). */
  lastValues(): StudyLastValue[] {
    const out: StudyLastValue[] = [];
    if (!this.active || this.excludeFromAutoscale) return out;
    const j = this.limit - 1;
    if (j < 0) return out;
    for (const o of this.study.spec.outputs) {
      if (o.type !== 'plot' || !o.visible || !o.showLastValue) continue;
      const v = this.study.values[o.id]?.[j];
      if (v === undefined || !Number.isFinite(v)) continue;
      out.push({
        outputId: o.id,
        price: v,
        color: paletteColor(o.colors, this.study.colors[o.id], j),
      });
    }
    return out;
  }

  valuesAt(i: number): number[] {
    const out: number[] = [];
    if (!this.active || this.excludeFromAutoscale) return out;
    const lim = this.limit;
    for (const o of this.study.spec.outputs) {
      if (o.type !== 'plot' || !o.visible) continue;
      const j = i - o.offset;
      const v = j >= 0 && j < lim ? this.study.values[o.id]?.[j] : undefined;
      if (v !== undefined && Number.isFinite(v)) out.push(v);
    }
    return out;
  }

  /** Price-based hit test is not used for studies (see hitTestPx). */
  hitTest(): boolean {
    return false;
  }

  private geometry(width: number, height: number, scale: PriceScale): StudyGeometry {
    const ts = this.host.timeScale;
    const { pFrom, pTo } = drawSpan(ts, width);
    return {
      width,
      height,
      timeScale: ts,
      priceScale: scale,
      theme: this.host.theme,
      bars: this.host.store,
      limit: this.limit,
      pFrom,
      pTo,
    };
  }

  draw(rc: SeriesRenderContext): void {
    this.drawn = null;
    if (!this.active) return;
    let scale = rc.priceScale;
    if (this.excludeFromAutoscale) {
      const own = this.ownScale;
      own.height = rc.height;
      const { pFrom, pTo } = this.span(rc.from, rc.to);
      const r = studyValueRange(this.study, pFrom, pTo, this.limit);
      if (!r) return;
      own.setAutoRange(r.min, r.max);
      scale = own;
    }
    this.drawn = { scale, width: rc.width, height: rc.height };
    const g = this.geometry(rc.width, rc.height, scale);
    drawStudy({ ...g, ctx: rc.ctx, dpr: rc.dpr }, this.study);
  }

  /** Output under CSS point (x, y) of the pane, from the last draw. */
  hitTestPx(x: number, y: number, layer: StudyHitLayer = 'all'): string | null {
    const d = this.drawn;
    if (!d || !this.active) return null;
    return hitTestStudy(this.geometry(d.width, d.height, d.scale), this.study, x, y, 4, layer);
  }
}
