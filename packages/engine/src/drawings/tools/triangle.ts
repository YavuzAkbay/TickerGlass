import { defineDrawingTool } from '../registry';
import {
  hitPolygon,
  pointsInView,
  renderPolygon,
  SHAPE_PROPERTIES,
  shapeDefaults,
} from './shape-common';

export const TRIANGLE_DEFAULTS = shapeDefaults('#7FB069', 'rgba(127, 176, 105, 0.2)');

/** Triangle through three anchors; filled interior is grabbable. */
export const triangle = defineDrawingTool({
  type: 'triangle',
  name: 'Triangle',
  group: 'shapes',
  creation: { kind: 'points', count: 3 },
  defaults: TRIANGLE_DEFAULTS,
  properties: SHAPE_PROPERTIES,

  render({ ctx }, g, s) {
    renderPolygon(ctx, g.points, s);
  },

  hitTest(g, s, x, y, tol) {
    return hitPolygon(g.points, s, x, y, tol);
  },

  isVisible(g) {
    return pointsInView(g, g.points);
  },
});
