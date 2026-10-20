import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingLineStyle } from '../types';

export const CYCLE_LINES_DEFAULTS = {
  lineColor: '#4f6bed',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
};

/** Cycles drawn at most per frame (closer than 1 px would be a solid fill anyway). */
const MAX_CYCLES = 2000;

/**
 * Cycle index range [from, to] (k >= 0) of the cycle points x0 + k * dx that
 * lie within [lo, hi] px; null when none. dx ~ 0: only k = 0.
 */
export function cycleRange(
  x0: number,
  dx: number,
  lo: number,
  hi: number,
): { from: number; to: number } | null {
  if (!Number.isFinite(x0) || !Number.isFinite(dx)) return null;
  if (Math.abs(dx) < 1e-9) return x0 >= lo && x0 <= hi ? { from: 0, to: 0 } : null;
  const k0 = (lo - x0) / dx;
  const k1 = (hi - x0) / dx;
  const from = Math.max(0, Math.ceil(Math.min(k0, k1) - 1e-9));
  const to = Math.floor(Math.max(k0, k1) + 1e-9);
  return from <= to ? { from, to: Math.min(to, from + MAX_CYCLES) } : null;
}

/** Anchor 1 x and cycle length in px, or null. */
function cycle(g: DrawingGeometry): { x0: number; dx: number } | null {
  const [a, b] = g.points;
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return null;
  return { x0: a.x, dx: b.x - a.x };
}

/**
 * Cycle lines: full-height vertical lines at anchor 1 + k * (anchor 2 -
 * anchor 1) for k = 0, 1, 2, ..., repeating from anchor 1 in anchor 2's
 * direction to the pane edge. Pixel x (linear in bars).
 */
export const cycleLines = defineDrawingTool({
  type: 'cycle-lines',
  name: 'Cycle lines',
  group: 'patterns',
  creation: { kind: 'points', count: 2 },
  defaults: CYCLE_LINES_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Lines', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
  ],

  render({ ctx }, g, s) {
    const c = cycle(g);
    const r = c && cycleRange(c.x0, c.dx, -s.lineWidth, g.width + s.lineWidth);
    if (!c || !r) return;
    // Sub-pixel cycles: only the anchor lines.
    const to = Math.abs(c.dx) < 1 ? Math.min(r.to, 1) : r.to;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.beginPath();
    for (let k = r.from; k <= to; k++) {
      const x = c.x0 + k * c.dx;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, g.height);
    }
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    const c = cycle(g);
    if (!c || y < -tol || y > g.height + tol) return null;
    const t = tol + s.lineWidth / 2;
    const k = Math.abs(c.dx) < 1e-9 ? 0 : Math.max(0, Math.round((x - c.x0) / c.dx));
    return Math.abs(x - (c.x0 + k * c.dx)) <= t ? BODY_HIT : null;
  },

  isVisible(g) {
    const c = cycle(g);
    return !!c && !!cycleRange(c.x0, c.dx, -50, g.width + 50);
  },
});
