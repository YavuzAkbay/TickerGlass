import { withPrice } from '../geometry';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingPoint } from '../types';
import {
  boxInView,
  GANN_SQUARE_DEFAULTS,
  GANN_SQUARE_PROPERTIES,
  hitGannSquare,
  renderGannSquare,
} from './gann-common';

/**
 * Anchor 2 on the square through anchor 1: keeps anchor 2's bar and sets its
 * price so the box is square on screen (height = width in px), on anchor 2's
 * side of anchor 1 (above when level).
 */
export function squareOnScreen(
  points: readonly DrawingPoint[],
  g: DrawingGeometry,
): DrawingPoint[] {
  const [p0, p1] = points;
  const [a, b] = g.points;
  if (!p0 || !p1 || !a || !b) return points.map((p) => ({ ...p }));
  const w = Math.abs(b.x - a.x);
  const price = g.yToPrice(a.y + (b.y > a.y ? w : -w));
  if (!(w > 0) || !Number.isFinite(price)) return [{ ...p0 }, { ...p1 }];
  return [{ ...p0 }, withPrice(p1, price)];
}

/** Price units per bar of the box p0-p1 (|Δprice| / |Δbars|), NaN when degenerate. */
export function priceBarRatio(
  p0: DrawingPoint,
  p1: DrawingPoint,
  g: Pick<DrawingGeometry, 'toPixel' | 'xToLogical'>,
): number {
  const bars = Math.abs(g.xToLogical(g.toPixel(p1).x) - g.xToLogical(g.toPixel(p0).x));
  const r = Math.abs(p1.price - p0.price) / bars;
  return bars > 1e-9 && Number.isFinite(r) ? r : NaN;
}

/**
 * Gann grid: the Gann square with a fixed price/bar ratio. On creation
 * the box is made square on screen (anchor 2's price is derived); the ratio is
 * then kept by the anchors themselves (|Δprice| / |Δbars|): dragging either
 * anchor only resizes the square (bar distance from the pointer, price from
 * the ratio, side from the pointer). Body drags move it as usual.
 */
export const gannGrid = defineDrawingTool({
  type: 'gann-grid',
  name: 'Gann grid',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: GANN_SQUARE_DEFAULTS,
  properties: GANN_SQUARE_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (a && b) renderGannSquare(ctx, theme, a, b, s);
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    return a && b ? hitGannSquare(a, b, s, x, y, tol) : null;
  },

  completePoints(points, g) {
    return squareOnScreen(points, g);
  },

  moveHandle({ start, handle, target, x, y, geometry: g }) {
    const p0 = start[0];
    const p1 = start[1];
    if (!p0 || !p1 || handle > 1) return start.map((p) => ({ ...p }));
    const fixed = handle === 0 ? p1 : p0;
    const ratio = priceBarRatio(p0, p1, g);
    const f = g.toPixel(fixed);
    const bars = Math.abs(g.xToLogical(x) - g.xToLogical(f.x));
    let moved: DrawingPoint;
    if (Number.isFinite(ratio)) {
      const dp = ratio * bars;
      moved = withPrice(target, fixed.price + (y > f.y ? -dp : dp));
    } else {
      // Degenerate box: square on screen again.
      const w = Math.abs(x - f.x);
      moved = withPrice(target, g.yToPrice(f.y + (y > f.y ? w : -w)));
    }
    return handle === 0 ? [moved, { ...p1 }] : [{ ...p0 }, moved];
  },

  isVisible(g) {
    const [a, b] = g.points;
    return !!a && !!b && boxInView(a, b, g.width, g.height);
  },
});
