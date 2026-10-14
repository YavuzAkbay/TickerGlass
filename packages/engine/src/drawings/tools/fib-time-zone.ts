import { BODY_HIT, lineDistance, segmentInView, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import {
  defaultTimeZoneLevels,
  FIB_TIME_DEFAULTS,
  FIB_TIME_PROPERTIES,
  hitTimeLevels,
  renderTimeLevels,
  timeLevelsInView,
  type FibTimeStyle,
} from './fib-common';

export const FIB_TIME_ZONE_DEFAULTS: FibTimeStyle = {
  ...FIB_TIME_DEFAULTS,
  levels: defaultTimeZoneLevels(),
};

/**
 * Fib time zone: vertical lines at bar `anchor1 + n * (anchor2 - anchor1)` for
 * the Fibonacci numbers n (levels 0, 1, 2, 3, 5, 8, ...). Bar distances are
 * fractional logical indices, so future zones follow the extrapolated timeline.
 */
export const fibTimeZone = defineDrawingTool({
  type: 'fib-time-zone',
  name: 'Fib time zone',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: FIB_TIME_ZONE_DEFAULTS,
  properties: FIB_TIME_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    const [l0, l1] = g.logical;
    if (!a || !b || l0 === undefined || l1 === undefined) return;
    renderTimeLevels(ctx, theme, g, s, l0, l1 - l0);
    if (s.showTrendLine) {
      setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    const [l0, l1] = g.logical;
    if (!a || !b || l0 === undefined || l1 === undefined) return null;
    if (s.showTrendLine && lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2)
      return BODY_HIT;
    return hitTimeLevels(g, s, l0, l1 - l0, x, y, tol);
  },

  isVisible(g, s) {
    const [a, b] = g.points;
    const [l0, l1] = g.logical;
    if (!a || !b || l0 === undefined || l1 === undefined) return false;
    if (s.showTrendLine && segmentInView(a.x, a.y, b.x, b.y, false, false, g.width, g.height))
      return true;
    return timeLevelsInView(g, s, l0, l1 - l0);
  },
});
