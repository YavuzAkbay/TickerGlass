import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import {
  hitCenteredText,
  renderCenteredText,
  SHAPE_PROPERTIES,
  shapeDefaults,
  TEXT_PROPERTIES,
  textDefaults,
} from './shape-common';

export const CIRCLE_DEFAULTS = {
  ...shapeDefaults('#E0A93B', 'rgba(224, 169, 59, 0.2)'),
  ...textDefaults('#E0A93B'),
};

/** Centre (anchor 0) and radius in px (distance to anchor 1), or null. */
export function circleOf(g: DrawingGeometry): { x: number; y: number; r: number } | null {
  const [c, e] = g.points;
  if (!c || !e) return null;
  const r = Math.hypot(e.x - c.x, e.y - c.y);
  return Number.isFinite(r) ? { x: c.x, y: c.y, r } : null;
}

/** Circle: anchor 0 the centre, anchor 1 on the circle (radius in screen px). */
export const circle = defineDrawingTool({
  type: 'circle',
  name: 'Circle',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: CIRCLE_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [...SHAPE_PROPERTIES, ...TEXT_PROPERTIES],

  render(rc, g, s) {
    const c = circleOf(g);
    if (!c) return;
    const { ctx } = rc;
    ctx.beginPath();
    ctx.arc(c.x, c.y, c.r, 0, 2 * Math.PI);
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fill();
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.stroke();
    if (g.drawing.text) renderCenteredText(rc, g.drawing.text, s, c.x, c.y);
  },

  hitTest(g, s, x, y, tol) {
    const c = circleOf(g);
    if (!c) return null;
    if (g.drawing.text) {
      const hit = hitCenteredText(g.drawing.text, s, c.x, c.y, x, y);
      if (hit) return hit;
    }
    const d = Math.hypot(x - c.x, y - c.y);
    if (Math.abs(d - c.r) <= tol + s.lineWidth / 2) return BODY_HIT;
    return s.fillBackground && d <= c.r ? BODY_HIT : null;
  },

  isVisible(g) {
    const c = circleOf(g);
    if (!c) return false;
    return (
      c.x + c.r >= -20 &&
      c.x - c.r <= g.width + 20 &&
      c.y + c.r >= -20 &&
      c.y - c.r <= g.height + 20
    );
  },
});
