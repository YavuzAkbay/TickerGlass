import { BODY_HIT, lineDistance, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { pointInPolygon } from '../shape-utils';
import type { PixelPoint } from '../types';
import { rectInView } from './annotation-common';

export const FLAG_DEFAULTS = {
  flagColor: '#DE6A4F',
  size: 30,
};

type FlagStyle = typeof FLAG_DEFAULTS;

/** Pennant polygon at the top of the pole (pole foot at (x, y)). */
function pennant(x: number, y: number, size: number): PixelPoint[] {
  const top = y - size;
  const h = size * 0.5;
  return [
    { x, y: top },
    { x: x + size * 0.7, y: top + h / 2 },
    { x, y: top + h },
  ];
}

/** Small flag planted on the anchor. */
export const flag = defineDrawingTool({
  type: 'flag',
  name: 'Flag',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: FLAG_DEFAULTS,
  properties: [
    { kind: 'color', key: 'flagColor', label: 'Color' },
    { kind: 'number', key: 'size', label: 'Size', min: 10, max: 200, step: 2 },
  ],

  render({ ctx }, g, s: FlagStyle) {
    const p = g.points[0];
    if (!p) return;
    setLineStyle(ctx, s.flagColor, 2, 'solid');
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y - s.size);
    ctx.stroke();
    const f = pennant(p.x, p.y, s.size);
    ctx.beginPath();
    ctx.moveTo(f[0]!.x, f[0]!.y);
    ctx.lineTo(f[1]!.x, f[1]!.y);
    ctx.lineTo(f[2]!.x, f[2]!.y);
    ctx.closePath();
    ctx.fillStyle = s.flagColor;
    ctx.fill();
  },

  hitTest(g, s, x, y, tol) {
    const p = g.points[0];
    if (!p) return null;
    if (lineDistance(x, y, p.x, p.y, p.x, p.y - s.size) <= tol + 1) return BODY_HIT;
    return pointInPolygon(pennant(p.x, p.y, s.size), x, y) ? BODY_HIT : null;
  },

  isVisible(g, s) {
    const p = g.points[0];
    return !!p && rectInView(g, { x: p.x, y: p.y - s.size, w: s.size * 0.7, h: s.size });
  },
});
