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

export const FIB_SPEED_ARCS_DEFAULTS: FibArcStyle & { fullCircles: boolean } = {
  ...FIB_ARC_DEFAULTS,
  levels: defaultArcLevels(1),
  fullCircles: false,
};

type SpeedArcsStyle = typeof FIB_SPEED_ARCS_DEFAULTS;

const spec: ArcLevelsSpec = {
  cx: 0,
  cy: 0,
  unit: 0,
  start: 0,
  end: Math.PI,
  anticlockwise: false,
  full: false,
  labelAngle: Math.PI / 2,
};

/**
 * Arcs around anchor 1 with radius level * |a-b|: the half circle on anchor
 * 2's side of the horizontal through anchor 1 (upper when b is above or level
 * with a), or full circles.
 */
export function speedArcsSpec(g: DrawingGeometry, s: SpeedArcsStyle): ArcLevelsSpec | null {
  const [a, b] = g.points;
  if (!a || !b) return null;
  const up = b.y <= a.y;
  spec.cx = a.x;
  spec.cy = a.y;
  spec.unit = Math.hypot(b.x - a.x, b.y - a.y);
  spec.full = !!s.fullCircles;
  // ctx.arc runs clockwise on screen: pi -> 2pi passes through the top.
  spec.start = up ? Math.PI : 0;
  spec.end = up ? 2 * Math.PI : Math.PI;
  spec.labelAngle = up ? -Math.PI / 2 : Math.PI / 2;
  return spec;
}

/**
 * Fib speed resistance arcs: half circles centred on anchor 1 with radius
 * level * |anchor 1 - anchor 2| (level 1 through anchor 2). Pixel space.
 */
export const fibSpeedArcs = defineDrawingTool({
  type: 'fib-speed-arcs',
  name: 'Fib speed resistance arcs',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: FIB_SPEED_ARCS_DEFAULTS,
  properties: [...FIB_ARC_PROPERTIES, { kind: 'bool', key: 'fullCircles', label: 'Full circles' }],

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    const c = speedArcsSpec(g, s);
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
    const c = speedArcsSpec(g, s);
    if (!a || !b || !c) return null;
    if (s.showTrendLine && lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2)
      return BODY_HIT;
    return hitArcLevels(s, c, x, y, tol);
  },

  isVisible(g, s) {
    const c = speedArcsSpec(g, s);
    return !!c && arcLevelsInView(g, s, c);
  },
});
