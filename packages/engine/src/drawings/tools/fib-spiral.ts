import { BODY_HIT, lineDistance, segmentInView, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { polylineDistance, strokePolyline } from '../shape-utils';
import type { DrawingGeometry, DrawingLineStyle, PixelPoint } from '../types';

/** Golden ratio: the spiral radius grows by PHI every quarter turn. */
export const PHI = (1 + Math.sqrt(5)) / 2;

export const FIB_SPIRAL_DEFAULTS = {
  lineColor: '#8e5cf6',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  counterclockwise: false,
  /** Radius segment anchor 1 -> 2. */
  showTrendLine: true,
};

type SpiralStyle = typeof FIB_SPIRAL_DEFAULTS;

/** Innermost sampled radius (px). */
const MIN_RADIUS = 1;
/** Hard cap on samples (bounded anyway by the step rule below). */
const MAX_SAMPLES = 4000;

/** Radius at turn angle `theta` (radians from anchor 2's direction): `r0 * PHI^(2 theta / pi)`. */
export function spiralRadius(r0: number, theta: number): number {
  return r0 * Math.pow(PHI, (2 * theta) / Math.PI);
}

/** Point pool and the view returned by `spiralPoints` (no per-frame allocation). */
const pool: PixelPoint[] = [];
const view: PixelPoint[] = [];
let used = 0;

function push(x: number, y: number): void {
  if (used === pool.length) pool.push({ x, y });
  else {
    pool[used]!.x = x;
    pool[used]!.y = y;
  }
  view.push(pool[used]!);
  used++;
}

/**
 * Sampled golden spiral (shared buffer; valid until the next call): centre
 * anchor 1, through anchor 2, from radius MIN_RADIUS outwards until it
 * leaves the pane for good (radius past the farthest pane corner).
 * Clockwise on screen by default. Empty for fewer than two anchors or
 * coincident anchors.
 */
export function spiralPoints(g: DrawingGeometry, s: SpiralStyle): readonly PixelPoint[] {
  used = 0;
  view.length = 0;
  const [c, p] = g.points;
  if (!c || !p) return view;
  const r0 = Math.hypot(p.x - c.x, p.y - c.y);
  if (!(r0 > 1e-6) || !Number.isFinite(r0)) return view;
  const a0 = Math.atan2(p.y - c.y, p.x - c.x);
  const dir = s.counterclockwise ? -1 : 1;
  const reach = Math.max(
    Math.hypot(c.x, c.y),
    Math.hypot(c.x - g.width, c.y),
    Math.hypot(c.x, c.y - g.height),
    Math.hypot(c.x - g.width, c.y - g.height),
  );
  const k = (2 * Math.log(PHI)) / Math.PI;
  const tMin = Math.log(MIN_RADIUS / r0) / k;
  const tMax = Math.log(Math.max(reach, r0) / r0) / k;
  let t = Math.min(tMin, 0);
  while (used < MAX_SAMPLES) {
    const r = spiralRadius(r0, t);
    const a = a0 + dir * t;
    push(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
    if (t >= tMax) break;
    // ~6 px chords, between 1 and 7.5 degrees.
    t = Math.min(tMax, t + Math.min(Math.PI / 24, Math.max(Math.PI / 180, 6 / r)));
  }
  return view;
}

/**
 * Fib spiral: golden spiral centred on anchor 1 through anchor 2 (radius
 * times PHI per quarter turn), sampled as a polyline in pixel space.
 */
export const fibSpiral = defineDrawingTool({
  type: 'fib-spiral',
  name: 'Fib spiral',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: FIB_SPIRAL_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'showTrendLine', label: 'Trend line' },
    { kind: 'bool', key: 'counterclockwise', label: 'Counterclockwise' },
  ],

  render({ ctx }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    const sp = spiralPoints(g, s);
    if (sp.length > 1) strokePolyline(ctx, sp);
    if (s.showTrendLine) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const t = tol + s.lineWidth / 2;
    if (s.showTrendLine && lineDistance(x, y, a.x, a.y, b.x, b.y) <= t) return BODY_HIT;
    const sp = spiralPoints(g, s);
    return sp.length > 1 && polylineDistance(sp, x, y) <= t ? BODY_HIT : null;
  },

  isVisible(g, s) {
    const sp = spiralPoints(g, s);
    for (let i = 1; i < sp.length; i++) {
      const p = sp[i - 1]!;
      const q = sp[i]!;
      if (segmentInView(p.x, p.y, q.x, q.y, false, false, g.width, g.height)) return true;
    }
    return false;
  },
});
