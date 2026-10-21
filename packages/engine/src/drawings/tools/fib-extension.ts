import { anchorsInView, BODY_HIT, lineDistance, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import {
  defaultFibLevels,
  FIB_COMMON_DEFAULTS,
  FIB_COMMON_PROPERTIES,
  hitFibLevels,
  renderFibLevels,
  type FibCommonStyle,
} from './fib-common';

export const FIB_EXTENSION_DEFAULTS: FibCommonStyle = {
  ...FIB_COMMON_DEFAULTS,
  levels: defaultFibLevels(),
};

/** Minimum level span (px) when anchors 2 and 3 share a bar. */
const MIN_SPAN = 30;
const xs = { l: 0, r: 0 };

/** Level span: between anchors 2 and 3 (at least MIN_SPAN px to the right). */
function levelSpan(g: DrawingGeometry): typeof xs | null {
  const b = g.points[1];
  const c = g.points[2];
  if (!b || !c) return null;
  xs.l = Math.min(b.x, c.x);
  xs.r = Math.max(b.x, c.x, xs.l + MIN_SPAN);
  return xs;
}

/** Fib extension: the move anchor 1 -> 2 projected from anchor 3 (`c + (b - a) * level`). */
export const fibExtension = defineDrawingTool({
  type: 'fib-extension',
  name: 'Fib extension',
  group: 'fib',
  creation: { kind: 'points', count: 3 },
  defaults: FIB_EXTENSION_DEFAULTS,
  properties: FIB_COMMON_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b, c] = g.points;
    if (!a || !b) return;
    const [p0, p1, p2] = g.drawing.points;
    const sp = levelSpan(g);
    if (c && p0 && p1 && p2 && sp)
      renderFibLevels(ctx, theme, g, s, sp.l, sp.r, p2.price, p1.price - p0.price);
    // The trend line (a-b-c) is always drawn while only two anchors exist.
    if (s.showTrendLine || !c) {
      setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      if (c) ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b, c] = g.points;
    if (!a || !b) return null;
    const t = tol + s.lineWidth / 2;
    if ((s.showTrendLine || !c) && lineDistance(x, y, a.x, a.y, b.x, b.y) <= t) return BODY_HIT;
    if (!c) return null;
    if (s.showTrendLine && lineDistance(x, y, b.x, b.y, c.x, c.y) <= t) return BODY_HIT;
    const [p0, p1, p2] = g.drawing.points;
    const sp = levelSpan(g);
    if (!p0 || !p1 || !p2 || !sp) return null;
    return hitFibLevels(g, s, sp.l, sp.r, p2.price, p1.price - p0.price, x, y, tol);
  },

  isVisible(g, s) {
    if (s.extendLeft || s.extendRight || anchorsInView(g)) return true;
    const sp = levelSpan(g);
    return !!sp && sp.r >= 0 && sp.l <= g.width;
  },
});
