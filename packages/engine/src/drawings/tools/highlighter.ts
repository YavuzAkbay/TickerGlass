import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import {
  nearStroke,
  smoothPath,
  strokeHandles,
  strokeInView,
  stretchStroke,
  tracePath,
} from './brush';

/** Moving-average radius of the highlighter path (samples). */
const SMOOTHING = 5;

export const HIGHLIGHTER_DEFAULTS = {
  lineColor: 'rgba(242, 169, 59, 0.35)',
  lineWidth: 20,
};

/**
 * Freehand marker: the brush path drawn as one wide, translucent, round-capped
 * stroke (one path, so overlaps do not darken). Handles: first and last sample.
 */
export const highlighter = defineDrawingTool({
  type: 'highlighter',
  name: 'Highlighter',
  group: 'shapes',
  creation: { kind: 'freehand' },
  defaults: HIGHLIGHTER_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Color', inline: 'line' },
    { kind: 'number', key: 'lineWidth', label: 'Width', inline: 'line', min: 2, max: 60, step: 1 },
  ],

  render({ ctx }, g, s) {
    const n = smoothPath(g.points, SMOOTHING);
    if (n < 2) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, 'solid');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    tracePath(ctx, n);
    ctx.stroke();
  },

  hitTest(g, s, x, y, tol) {
    return nearStroke(g, SMOOTHING, x, y, tol + s.lineWidth / 2) ? BODY_HIT : null;
  },

  handles(g) {
    return strokeHandles(g);
  },

  moveHandle(args) {
    return stretchStroke(args);
  },

  priceAxisLabels() {
    return [];
  },

  timeAxisLabels() {
    return [];
  },

  isVisible(g) {
    return strokeInView(g);
  },
});
