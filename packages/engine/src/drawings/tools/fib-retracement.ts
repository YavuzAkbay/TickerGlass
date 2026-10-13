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

export const FIB_RETRACEMENT_DEFAULTS: FibCommonStyle & { reverse: boolean } = {
  ...FIB_COMMON_DEFAULTS,
  levels: defaultFibLevels(),
  reverse: false,
};

type FibRetracementStyle = typeof FIB_RETRACEMENT_DEFAULTS;

/** Price of level 0 (`base`) and the per-level step (`delta`): level 0 at anchor 2, 1 at anchor 1. */
const coef = { base: 0, delta: 0 };

function coefficients(g: DrawingGeometry, s: FibRetracementStyle): typeof coef | null {
  const [p0, p1] = g.drawing.points;
  if (!p0 || !p1) return null;
  const from = p0.price;
  const to = p1.price;
  coef.base = s.reverse ? from : to;
  coef.delta = s.reverse ? to - from : from - to;
  return coef;
}

/** Fib retracement: levels between two anchors (level 0 at anchor 2, 1 at anchor 1; `reverse` swaps). */
export const fibRetracement = defineDrawingTool({
  type: 'fib-retracement',
  name: 'Fib retracement',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: FIB_RETRACEMENT_DEFAULTS,
  properties: [...FIB_COMMON_PROPERTIES, { kind: 'bool', key: 'reverse', label: 'Reverse' }],

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    const c = coefficients(g, s);
    if (!a || !b || !c) return;
    renderFibLevels(ctx, theme, g, s, a.x, b.x, c.base, c.delta);
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
    const c = coefficients(g, s);
    if (!a || !b || !c) return null;
    if (s.showTrendLine && lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2)
      return BODY_HIT;
    return hitFibLevels(g, s, a.x, b.x, c.base, c.delta, x, y, tol);
  },

  isVisible(g, s) {
    return s.extendLeft || s.extendRight || anchorsInView(g);
  },
});
