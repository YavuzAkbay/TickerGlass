import { BODY_HIT, setLineStyle, WEAK_BODY_HIT } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingLineStyle } from '../types';
import { cycleRange } from './cycle-lines';

export const CYCLE_ARCS_DEFAULTS = {
  lineColor: '#2962ff',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  fillBackground: true,
  backgroundColor: 'rgba(41, 98, 255, 0.1)',
};

type CycleArcsStyle = typeof CYCLE_ARCS_DEFAULTS;

/** Baseline (anchor 1) x/y, cycle width dx in px, arcs above (`up`) or below. */
const cyc = { x0: 0, y0: 0, dx: 0, up: true };

function cycles(g: DrawingGeometry): typeof cyc | null {
  const [a, b] = g.points;
  if (!a || !b || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
  cyc.x0 = a.x;
  cyc.y0 = a.y;
  cyc.dx = b.x - a.x;
  cyc.up = b.y <= a.y;
  return Math.abs(cyc.dx) < 1 ? null : cyc;
}

/** Cycles whose semicircle reaches into [lo, hi] px (k = cycle index). */
function visibleCycles(c: typeof cyc, lo: number, hi: number) {
  // Cycle k is centred on x0 + (k + 1/2) dx with radius |dx| / 2.
  const r = Math.abs(c.dx) / 2;
  return cycleRange(c.x0 + c.dx / 2, c.dx, lo - r, hi + r);
}

/**
 * Cycle arcs: semicircles of diameter anchor 1 -> anchor 2 (in px) repeated
 * along the horizontal through anchor 1, from anchor 1 in anchor 2's
 * direction to the pane edge; above the baseline when anchor 2 is above or
 * level with anchor 1, else below. Pixel space.
 */
export const cycleArcs = defineDrawingTool({
  type: 'cycle-arcs',
  name: 'Cycle arcs',
  group: 'patterns',
  creation: { kind: 'points', count: 2 },
  defaults: CYCLE_ARCS_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Lines', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
  ],

  render({ ctx }, g, s: CycleArcsStyle) {
    const c = cycles(g);
    const range = c && visibleCycles(c, 0, g.width);
    if (!c || !range) return;
    const r = Math.abs(c.dx) / 2;
    // ctx.arc runs clockwise on screen: pi -> 2pi passes through the top.
    const start = c.up ? Math.PI : 0;
    const end = c.up ? 2 * Math.PI : Math.PI;
    ctx.beginPath();
    for (let k = range.from; k <= range.to; k++) {
      const cx = c.x0 + (k + 0.5) * c.dx;
      ctx.moveTo(cx + (c.up ? -r : r), c.y0);
      ctx.arc(cx, c.y0, r, start, end);
    }
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fill();
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const c = cycles(g);
    if (!c) return null;
    const k = Math.floor((x - c.x0) / c.dx);
    if (k < 0) return null;
    const r = Math.abs(c.dx) / 2;
    const cx = c.x0 + (k + 0.5) * c.dx;
    const t = tol + s.lineWidth / 2;
    // Signed height above the baseline on the arcs' side.
    const h = c.up ? c.y0 - y : y - c.y0;
    if (h < -t) return null;
    const d = Math.hypot(x - cx, y - c.y0);
    if (Math.abs(d - r) <= t) return BODY_HIT;
    return s.fillBackground && h >= 0 && d <= r ? WEAK_BODY_HIT : null;
  },

  isVisible(g) {
    const c = cycles(g);
    if (!c) return false;
    const r = Math.abs(c.dx) / 2;
    const top = c.up ? c.y0 - r : c.y0;
    const bottom = c.up ? c.y0 : c.y0 + r;
    if (bottom < -50 || top > g.height + 50) return false;
    return !!visibleCycles(c, -50, g.width + 50);
  },
});
