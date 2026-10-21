import { BODY_HIT, lineDistance, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import {
  arcLevelsInView,
  defaultArcLevels,
  FIB_ARC_DEFAULTS,
  FIB_ARC_PROPERTIES,
  hitArcLevels,
  renderArcLevels,
  type ArcLevelsSpec,
  type FibArcStyle,
} from './fib-common';

export const FIB_CIRCLES_DEFAULTS: FibArcStyle = {
  ...FIB_ARC_DEFAULTS,
  levels: defaultArcLevels(),
};

const spec: ArcLevelsSpec = {
  cx: 0,
  cy: 0,
  unit: 0,
  start: 0,
  end: 2 * Math.PI,
  anticlockwise: false,
  full: true,
  labelAngle: -Math.PI / 2,
};

/** Circles: centre at the midpoint of anchors 1-2, level 1 through both (diameter). */
export function fibCirclesSpec(g: DrawingGeometry): ArcLevelsSpec | null {
  const [a, b] = g.points;
  if (!a || !b) return null;
  spec.cx = (a.x + b.x) / 2;
  spec.cy = (a.y + b.y) / 2;
  spec.unit = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  return spec;
}

/**
 * Fib circles: concentric circles around the midpoint of anchors 1-2 with
 * radius level * |a-b| / 2 (level 1 passes through both anchors). Pixel
 * space: circles stay round, their size follows the anchors on zoom.
 */
export const fibCircles = defineDrawingTool({
  type: 'fib-circles',
  name: 'Fib circles',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: FIB_CIRCLES_DEFAULTS,
  properties: FIB_ARC_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    const c = fibCirclesSpec(g);
    if (!a || !b || !c) return;
    renderArcLevels(ctx, theme, s, c);
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
    const c = fibCirclesSpec(g);
    if (!a || !b || !c) return null;
    if (s.showTrendLine && lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2)
      return BODY_HIT;
    return hitArcLevels(s, c, x, y, tol);
  },

  isVisible(g, s) {
    const c = fibCirclesSpec(g);
    return !!c && arcLevelsInView(g, s, c);
  },
});
