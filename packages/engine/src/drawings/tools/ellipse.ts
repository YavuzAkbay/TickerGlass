import { BODY_HIT, setLineStyle } from '../draw-utils';
import { withPrice, withTime } from '../geometry';
import { defineDrawingTool } from '../registry';
import { ellipseDistance } from '../shape-utils';
import type { DrawingGeometry } from '../types';
import {
  hitCenteredText,
  renderCenteredText,
  SHAPE_PROPERTIES,
  shapeDefaults,
  TEXT_PROPERTIES,
  textDefaults,
} from './shape-common';

export const ELLIPSE_DEFAULTS = {
  ...shapeDefaults('#f23645', 'rgba(242, 54, 69, 0.2)'),
  ...textDefaults('#f23645'),
};

const ell = { cx: 0, cy: 0, rx: 0, ry: 0 };

/** Ellipse inscribed in the box of anchors 0 and 1 (shared buffer), or null. */
export function ellipseOf(g: DrawingGeometry): typeof ell | null {
  const [a, b] = g.points;
  if (!a || !b) return null;
  ell.cx = (a.x + b.x) / 2;
  ell.cy = (a.y + b.y) / 2;
  ell.rx = Math.abs(b.x - a.x) / 2;
  ell.ry = Math.abs(b.y - a.y) / 2;
  return Number.isFinite(ell.rx + ell.ry + ell.cx + ell.cy) ? ell : null;
}

/**
 * Axis-aligned ellipse inscribed in the box spanned by two corner anchors.
 * Handles: the four box edge midpoints on the ellipse (0 x of anchor 0,
 * 1 x of anchor 1, 2 y of anchor 0, 3 y of anchor 1).
 */
export const ellipse = defineDrawingTool({
  type: 'ellipse',
  name: 'Ellipse',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: ELLIPSE_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [...SHAPE_PROPERTIES, ...TEXT_PROPERTIES],

  render(rc, g, s) {
    const e = ellipseOf(g);
    if (!e) return;
    const { ctx } = rc;
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, 2 * Math.PI);
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fill();
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.stroke();
    if (g.drawing.text) renderCenteredText(rc, g.drawing.text, s, e.cx, e.cy);
  },

  hitTest(g, s, x, y, tol) {
    const e = ellipseOf(g);
    if (!e) return null;
    if (g.drawing.text) {
      const hit = hitCenteredText(g.drawing.text, s, e.cx, e.cy, x, y);
      if (hit) return hit;
    }
    if (ellipseDistance(e.cx, e.cy, e.rx, e.ry, x, y) <= tol + s.lineWidth / 2) return BODY_HIT;
    if (!s.fillBackground || e.rx === 0 || e.ry === 0) return null;
    const u = (x - e.cx) / e.rx;
    const v = (y - e.cy) / e.ry;
    return u * u + v * v <= 1 ? BODY_HIT : null;
  },

  handles(g) {
    const [a, b] = g.points;
    if (!a || !b) return a ? [{ x: a.x, y: a.y }] : [];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    return [
      { x: a.x, y: my, cursor: 'ew-resize' },
      { x: b.x, y: my, cursor: 'ew-resize' },
      { x: mx, y: a.y, cursor: 'ns-resize' },
      { x: mx, y: b.y, cursor: 'ns-resize' },
    ];
  },

  moveHandle({ start, handle, target }) {
    const p0 = start[0];
    const p1 = start[1];
    if (!p0 || !p1) return start.map((p, i) => (i === handle ? target : { ...p }));
    switch (handle) {
      case 0:
        return [withTime(p0, target), { ...p1 }];
      case 1:
        return [{ ...p0 }, withTime(p1, target)];
      case 2:
        return [withPrice(p0, target.price), { ...p1 }];
      case 3:
        return [{ ...p0 }, withPrice(p1, target.price)];
      default:
        return [{ ...p0 }, { ...p1 }];
    }
  },
});
