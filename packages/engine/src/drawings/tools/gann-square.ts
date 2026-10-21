import { defineDrawingTool } from '../registry';
import {
  boxCornerHandles,
  boxInView,
  GANN_SQUARE_DEFAULTS,
  GANN_SQUARE_PROPERTIES,
  hitGannSquare,
  moveBoxCorner,
  renderGannSquare,
} from './gann-common';

/**
 * Gann square: a free box anchor 1 (origin corner) - anchor 2 with the level
 * grid, fan rays from anchor 1 (1x1 = the box diagonal) and quarter arcs
 * around anchor 1. Pixel space. Handles: the anchors and the two other corners.
 */
export const gannSquare = defineDrawingTool({
  type: 'gann-square',
  name: 'Gann square',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: GANN_SQUARE_DEFAULTS,
  properties: GANN_SQUARE_PROPERTIES,

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (a && b) renderGannSquare(ctx, theme, a, b, s);
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    return a && b ? hitGannSquare(a, b, s, x, y, tol) : null;
  },

  handles(g) {
    const [a, b] = g.points;
    return a && b ? boxCornerHandles(a, b) : [];
  },

  moveHandle({ start, handle, target }) {
    return moveBoxCorner(start, handle, target);
  },

  isVisible(g) {
    const [a, b] = g.points;
    return !!a && !!b && boxInView(a, b, g.width, g.height);
  },
});
