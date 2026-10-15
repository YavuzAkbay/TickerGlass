import type { OhlcvSource } from '../chart-types';
import type { ChartTheme } from '../options';
import type { PaneSeries, SeriesRenderContext } from '../render/series';
import { PriceScale } from '../scale/price-scale';
import type { TimeScale } from '../scale/time-scale';
import { hitTestStudy, type StudyHitLayer } from './hit';
import { drawSpan, drawStudy, type StudyGeometry } from './render';
import { paletteColor, studyValueRange, type Study } from './study';
import type { StudyPlotMeta } from './types';

/** What a study series reads from its chart. */
export interface StudyHost {
  readonly store: OhlcvSource;
  readonly timeScale: TimeScale;
  readonly seriesRevision: number;
  readonly theme: ChartTheme;
  /** Symbol price decimals for `inherit` formats (additive; default 2). */
  readonly symbolDecimals?: number;
  /** Main pane base value at displayed bar i (compare overlays), or null. */
  compareReference(i: number): number | null;
}

/** Fraction of the pane used by studies with `priceScale: 'none'` (as the volume overlay). */
export const OWN_SCALE_HEIGHT = 0.2;

/** Last-value label of one plot. */
export interface StudyLastValue {
  outputId: string;
  /** In pane price units (compare overlays: rescaled). */
  price: number;
  /** The study's own value. */
  raw: number;
  /** Label position for own-scale ('own') studies; otherwise from `price`. */
  y?: number;
  color: string;
}

/** Cached compare factor (see compareFactor). */
interface CompareCache {
  from: number;
  to: number;
  revision: number;
  limit: number;
  version: number;
  outputId: string;
  /** Index used; -1 = none. */
  k: number;
  ov: number;
  ref: number;
  factor: number;
}

/**
 * Adapter that puts a Study into a pane's series list: auto-scale range,
 * drawing, magnet values and pixel hit testing.
 */
export class StudySeries implements PaneSeries {
  /** Implicit scale for priceScale 'none' and 'own'. */
  private readonly ownScale = new PriceScale();
  /** Scale and pane size of the last draw (for hit testing). */
  private drawn: {
    scale: Pick<PriceScale, 'priceToY'>;
    width: number;
    height: number;
  } | null = null;
  /** Bumped by the chart whenever the study's data changes (compare factor cache). */
  dataVersion = 0;
  private compareCache: CompareCache | null = null;
  /** Compare factor of the last priceRange/draw (magnet, last value, hit test). */
  private lastFactor = NaN;

  constructor(
    readonly study: Study,
    private readonly host: StudyHost,
  ) {}

  get id(): string {
    return this.study.id;
  }

  get title(): string {
    return this.study.spec.title;
  }

  get excludeFromAutoscale(): boolean {
    return this.study.spec.priceScale !== 'pane';
  }

  /** 'none' studies are background overlays (drawn and hit-tested last). */
  get behind(): boolean {
    return this.study.spec.priceScale === 'none';
  }

  /** Compare overlay rescaled onto the main pane's price scale. */
  get isCompare(): boolean {
    const spec = this.study.spec;
    return !!spec.compare && spec.priceScale === 'pane' && this.study.paneId === 'main';
  }

  /** The plot a compare factor is computed from: the first visible plot. */
  private compareOutput(): StudyPlotMeta | null {
    for (const o of this.study.spec.outputs) if (o.type === 'plot' && o.visible) return o;
    return null;
  }

  /**
   * Factor that maps the study's values onto the main series for the visible
   * bars [from, to]: ref(k) / ov[k] at the first bar k where both are finite;
   * NaN when there is none or either is not positive.
   */
  compareFactor(from: number, to: number): number {
    const o = this.compareOutput();
    if (!o) return (this.lastFactor = NaN);
    const vals = this.study.values[o.id];
    const host = this.host;
    const limit = this.limit;
    const revision = host.seriesRevision;
    const c = this.compareCache;
    if (
      c &&
      c.from === from &&
      c.to === to &&
      c.revision === revision &&
      c.limit === limit &&
      c.version === this.dataVersion &&
      c.outputId === o.id &&
      // The main series' last bar and a live-patched tail may change in place.
      (c.k < 0 || (vals?.[c.k] === c.ov && host.compareReference(c.k) === c.ref))
    )
      return (this.lastFactor = c.factor);
    let k = -1;
    let ov = NaN;
    let ref = NaN;
    if (vals) {
      const end = Math.min(to, limit - 1);
      for (let i = Math.max(from, 0); i <= end; i++) {
        const v = vals[i]!;
        if (!Number.isFinite(v)) continue;
        const r = host.compareReference(i);
        if (r === null || !Number.isFinite(r)) continue;
        k = i;
        ov = v;
        ref = r;
        break;
      }
    }
    const factor = k >= 0 && ov > 0 && ref > 0 ? ref / ov : NaN;
    this.compareCache = {
      from,
      to,
      revision,
      limit,
      version: this.dataVersion,
      outputId: o.id,
      k,
      ov,
      ref,
      factor,
    };
    return (this.lastFactor = factor);
  }

  /** Factor applied to values on the pane scale: 1, or the compare factor (may be NaN). */
  private currentFactor(): number {
    return this.isCompare ? this.lastFactor : 1;
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
    if (this.isCompare) {
      if (!this.active) return null;
      const f = this.compareFactor(from, to);
      if (!(f > 0)) return null;
      const { pFrom, pTo } = this.span(from, to);
      const r = studyValueRange(this.study, pFrom, pTo, this.limit);
      return r ? { min: r.min * f, max: r.max * f } : null;
    }
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

  /**
   * Last values of visible plots with showLastValue: pane-scale studies
   * (compare overlays rescaled by the last factor) and, after a draw,
   * 'own'-scale studies (with `y` on their own scale). None for 'none'.
   */
  lastValues(): StudyLastValue[] {
    const out: StudyLastValue[] = [];
    if (!this.active || this.behind) return out;
    const own = this.study.spec.priceScale === 'own';
    const ownScale = own ? this.drawn?.scale : undefined;
    if (own && !ownScale) return out;
    const f = this.currentFactor();
    if (!(f > 0)) return out;
    const j = this.limit - 1;
    if (j < 0) return out;
    for (const o of this.study.spec.outputs) {
      if (o.type !== 'plot' || !o.visible || !o.showLastValue) continue;
      const v = this.study.values[o.id]?.[j];
      if (v === undefined || !Number.isFinite(v)) continue;
      const lv: StudyLastValue = {
        outputId: o.id,
        price: v * f,
        raw: v,
        color: paletteColor(o.colors, this.study.colors[o.id], j) || (o.colors[0] ?? ''),
      };
      if (ownScale) lv.y = ownScale.priceToY(v);
      out.push(lv);
    }
    return out;
  }

  /** Magnet values in pane price units; none for own-scale studies. */
  valuesAt(i: number): number[] {
    const out: number[] = [];
    if (!this.active || this.excludeFromAutoscale) return out;
    const f = this.currentFactor();
    if (!(f > 0)) return out;
    const lim = this.limit;
    for (const o of this.study.spec.outputs) {
      if (o.type !== 'plot' || !o.visible) continue;
      const j = i - o.offset;
      const v = j >= 0 && j < lim ? this.study.values[o.id]?.[j] : undefined;
      if (v !== undefined && Number.isFinite(v)) out.push(v * f);
    }
    return out;
  }

  /** Price-based hit test is not used for studies (see hitTestPx). */
  hitTest(): boolean {
    return false;
  }

  private geometry(
    width: number,
    height: number,
    scale: Pick<PriceScale, 'priceToY'>,
  ): StudyGeometry {
    const ts = this.host.timeScale;
    const { pFrom, pTo } = drawSpan(ts, width);
    return {
      width,
      height,
      timeScale: ts,
      priceScale: scale,
      theme: this.host.theme,
      bars: this.host.store,
      symbolDecimals: this.host.symbolDecimals ?? 2,
      limit: this.limit,
      pFrom,
      pTo,
    };
  }

  draw(rc: SeriesRenderContext): void {
    this.drawn = null;
    if (!this.active) return;
    let scale: Pick<PriceScale, 'priceToY'> = rc.priceScale;
    if (this.excludeFromAutoscale) {
      const own = this.ownScale;
      // 'none': bottom band like the volume overlay; 'own': full height with
      // the default pane margins. Always linear and auto-scaled to the study.
      const band = this.study.spec.priceScale === 'none';
      own.marginTop = band ? 1 - OWN_SCALE_HEIGHT : 0.1;
      own.marginBottom = band ? 0 : 0.08;
      own.height = rc.height;
      const { pFrom, pTo } = this.span(rc.from, rc.to);
      const r = studyValueRange(this.study, pFrom, pTo, this.limit);
      if (!r) return;
      own.setAutoRange(r.min, r.max);
      scale = own;
    } else if (this.isCompare) {
      const f = this.compareFactor(rc.from, rc.to);
      if (!(f > 0)) return;
      const inner = rc.priceScale;
      scale = { priceToY: (p: number) => inner.priceToY(p * f) };
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
