import { BODY_HIT, lineDistance, segmentInView, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import {
  defaultTrendTimeLevels,
  FIB_TIME_DEFAULTS,
  FIB_TIME_PROPERTIES,
  hitTimeLevels,
  renderTimeLevels,
  timeLevelsInView,
  type FibTimeStyle,
} from './fib-common';

export const FIB_TIME_EXTENSION_DEFAULTS: FibTimeStyle = {
  ...FIB_TIME_DEFAULTS,
  fillBackground: true,
  levels: defaultTrendTimeLevels(),
};

/**
 * Fib time extension: the bar distance anchor 1 -> 2 projected from anchor 3,
 * vertical lines at bar `anchor3 + level * (anchor2 - anchor1)` (the time
 * analogue of the fib extension).
 */
export const fibTimeExtension = defineDrawingTool({
  type: 'fib-time-extension',
  name: 'Fib time extension',
  group: 'fib',
  creation: { kind: 'points', count: 3 },
  defaults: FIB_TIME_EXTENSION_DEFAULTS,
  properties: FIB_TIME_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b, c] = g.points;
    if (!a || !b) return;
    const [l0 = 0, l1 = 0, l2 = 0] = g.logical;
    if (c) renderTimeLevels(ctx, theme, g, s, l2, l1 - l0);
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
    const [l0 = 0, l1 = 0, l2 = 0] = g.logical;
    return hitTimeLevels(g, s, l2, l1 - l0, x, y, tol);
  },

  isVisible(g, s) {
    const [a, b, c] = g.points;
    if (!a || !b) return false;
    const W = g.width;
    const H = g.height;
    if (segmentInView(a.x, a.y, b.x, b.y, false, false, W, H)) return true;
    if (!c) return false;
    if (segmentInView(b.x, b.y, c.x, c.y, false, false, W, H)) return true;
    const [l0 = 0, l1 = 0, l2 = 0] = g.logical;
    return timeLevelsInView(g, s, l2, l1 - l0);
  },
});
