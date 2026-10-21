import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { polylineDistance, strokePolyline } from '../shape-utils';
import type { DrawingGeometry, DrawingLineStyle, PixelPoint } from '../types';

export const SINE_WAVE_DEFAULTS = {
  lineColor: '#6E9BD6',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
};

/** Sample spacing in px. */
const STEP = 2;

/**
 * Price of the sine through peak/trough anchors at logical `l`: anchor 1
 * (l0, p0) and anchor 2 (l1, p1) are half a period apart:
 * mid + amp * cos(pi * (l - l0) / (l1 - l0)), mid = (p0 + p1) / 2, amp = (p0 - p1) / 2.
 */
export function sinePrice(l0: number, p0: number, l1: number, p1: number, l: number): number {
  return (p0 + p1) / 2 + ((p0 - p1) / 2) * Math.cos((Math.PI * (l - l0)) / (l1 - l0));
}

const samples: PixelPoint[] = [];

/** The sine sampled every STEP px across the pane (shared buffer), or null. */
export function sineSamples(g: DrawingGeometry): readonly PixelPoint[] | null {
  const [p0, p1] = g.drawing.points;
  const [l0, l1] = g.logical;
  if (!p0 || !p1 || l0 === undefined || l1 === undefined) return null;
  if (!Number.isFinite(l0) || !Number.isFinite(l1) || Math.abs(l1 - l0) < 1e-9) return null;
  const n = Math.ceil(g.width / STEP) + 3;
  while (samples.length < n) samples.push({ x: 0, y: 0 });
  samples.length = n;
  for (let i = 0; i < n; i++) {
    const x = (i - 1) * STEP;
    const q = samples[i]!;
    q.x = x;
    q.y = g.priceToY(sinePrice(l0, p0.price, l1, p1.price, g.xToLogical(x)));
  }
  return samples;
}

/**
 * Sine wave: anchors are a peak and the next trough (half a period); the wave
 * continues across the whole pane both ways. Price space (y via the price
 * scale), x by fractional bars.
 */
export const sineWave = defineDrawingTool({
  type: 'sine-wave',
  name: 'Sine wave',
  group: 'patterns',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: SINE_WAVE_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
  ],

  render({ ctx }, g, s) {
    const pts = sineSamples(g);
    if (!pts) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    strokePolyline(ctx, pts);
  },

  hitTest(g, s, x, y, tol) {
    const pts = sineSamples(g);
    if (!pts) return null;
    return polylineDistance(pts, x, y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  isVisible(g) {
    const [a, b] = g.points;
    if (!a || !b || !Number.isFinite(a.y) || !Number.isFinite(b.y)) return false;
    if (!(Math.abs(b.x - a.x) > 1e-9)) return false;
    // The wave spans the pane width: visible when its price band crosses the pane.
    return Math.max(a.y, b.y) >= -50 && Math.min(a.y, b.y) <= g.height + 50;
  },
});
