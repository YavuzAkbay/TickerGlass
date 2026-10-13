import { intervalSeconds } from '../feed/intervals';
import type { PriceScale } from '../scale/price-scale';
import type { TimeScale } from '../scale/time-scale';
import { logicalToTime, timeToLogical, type AnchorTimeline } from './mapping';
import type {
  Drawing,
  DrawingBarData,
  DrawingFormat,
  DrawingGeometry,
  DrawingPoint,
  PixelPoint,
} from './types';

const NO_BARS: DrawingBarData = {
  length: 0,
  time: [],
  open: [],
  high: [],
  low: [],
  close: [],
  volume: [],
};

/** What drawings need from a pane. `Pane` satisfies it. */
export interface DrawingPane {
  readonly id: string;
  readonly priceScale: PriceScale;
  /** CSS px; 0 when hidden (maximized sibling). */
  readonly height: number;
  /** Offset from the chart root top (CSS px). */
  readonly top: number;
}

/** Shared view state for one geometry update. */
export interface GeometryView {
  timeline: AnchorTimeline;
  timeScale: TimeScale;
  /** Pane width (CSS px). */
  width: number;
  /** Displayed bars (default: none). */
  bars?: DrawingBarData;
}

/**
 * Reusable `DrawingGeometry`: one instance per drawing, refreshed in place on
 * every render/hit test, so steady-state frames do not allocate.
 */
export class Geometry implements DrawingGeometry {
  drawing!: Readonly<Drawing>;
  readonly points: PixelPoint[] = [];
  readonly logical: number[] = [];
  width = 0;
  height = 0;
  barSpacing = 1;
  intervalSeconds = 0;
  format!: DrawingFormat;
  bars: DrawingBarData = NO_BARS;
  private ts!: TimeScale;
  private ps!: PriceScale;
  private tl!: AnchorTimeline;

  /** Map `drawing` into `pane`. Returns false when there are no bars to anchor to. */
  update(
    drawing: Readonly<Drawing>,
    pane: DrawingPane,
    view: GeometryView,
    format: DrawingFormat,
  ): boolean {
    this.drawing = drawing;
    this.ts = view.timeScale;
    this.ps = pane.priceScale;
    this.tl = view.timeline;
    this.width = view.width;
    this.height = pane.height;
    this.barSpacing = view.timeScale.barSpacing;
    this.intervalSeconds = intervalSeconds(view.timeline.interval);
    this.format = format;
    this.bars = view.bars ?? NO_BARS;
    const pts = drawing.points;
    const n = pts.length;
    while (this.points.length < n) this.points.push({ x: NaN, y: NaN });
    this.points.length = n;
    this.logical.length = n;
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      const l = timeToLogical(this.tl, p);
      this.logical[i] = l;
      const px = this.points[i]!;
      px.x = this.ts.indexToX(l);
      px.y = this.ps.priceToY(p.price);
    }
    return view.timeline.length > 0;
  }

  toPixel(p: DrawingPoint): PixelPoint {
    return { x: this.ts.indexToX(timeToLogical(this.tl, p)), y: this.ps.priceToY(p.price) };
  }

  toPoint(x: number, y: number): DrawingPoint {
    return pointAt(this.tl, this.ts, this.ps, x, y);
  }

  priceToY(price: number): number {
    return this.ps.priceToY(price);
  }

  yToPrice(y: number): number {
    return this.ps.yToPrice(y);
  }

  logicalToX(logical: number): number {
    return this.ts.indexToX(logical);
  }

  xToLogical(x: number): number {
    return this.ts.xToLogical(x);
  }
}

/** Anchor at pane-local pixel (x, y), x rounded to a bar slot; time NaN without bars. */
export function pointAt(
  tl: AnchorTimeline,
  ts: TimeScale,
  ps: PriceScale,
  x: number,
  y: number,
): DrawingPoint {
  const t = logicalToTime(tl, ts.xToLogical(x));
  const price = ps.yToPrice(y);
  if (!t) return { time: NaN, price };
  return t.brick ? { time: t.time, price, brick: t.brick } : { time: t.time, price };
}

/** Anchor `p` with its price replaced (time and brick kept). */
export function withPrice(p: DrawingPoint, price: number): DrawingPoint {
  return p.brick ? { time: p.time, price, brick: p.brick } : { time: p.time, price };
}

/** Anchor with the time (and brick) of `t` and the price of `p`. */
export function withTime(p: DrawingPoint, t: Pick<DrawingPoint, 'time' | 'brick'>): DrawingPoint {
  return t.brick
    ? { time: t.time, price: p.price, brick: t.brick }
    : { time: t.time, price: p.price };
}
