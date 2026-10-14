import { anchorsInView, BODY_HIT, lineDistance } from '../draw-utils';
import { withPrice, withTime } from '../geometry';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingHandle } from '../types';
import {
  hitTwoLines,
  renderFirstLine,
  renderTwoLines,
  TWO_LINE_CHANNEL_DEFAULTS,
  TWO_LINE_CHANNEL_PROPERTIES,
  twoLinesInView,
  twoLineTimeLabels,
  type TwoLines,
} from './disjoint-channel';

const lines: TwoLines = [0, 0, 0, 0, 0, 0];

/** Trend line 0-1 and the flat line at anchor 2's price over the same bars, or null. */
function flatLines(g: DrawingGeometry): TwoLines | null {
  const [a, b, c] = g.points;
  if (!a || !b || !c) return null;
  lines[0] = a.x;
  lines[1] = a.y;
  lines[2] = b.x;
  lines[3] = b.y;
  lines[4] = c.y;
  lines[5] = c.y;
  return lines;
}

/**
 * Flat top/bottom: a trend line (anchors 0-1) and a horizontal line at anchor
 * 2's price over the same bars, filled between. Anchor 2 takes anchor 0's time.
 */
export const flatTopBottom = defineDrawingTool({
  type: 'flat-top-bottom',
  name: 'Flat top/bottom',
  group: 'lines',
  creation: { kind: 'points', count: 3 },
  defaults: TWO_LINE_CHANNEL_DEFAULTS,
  properties: TWO_LINE_CHANNEL_PROPERTIES,

  render({ ctx }, g, s) {
    const l = flatLines(g);
    if (l) renderTwoLines(ctx, g, s, l);
    else renderFirstLine(ctx, g, s);
  },

  hitTest(g, s, x, y, tol) {
    const l = flatLines(g);
    if (l) return hitTwoLines(g, s, l, x, y, tol);
    const [a, b] = g.points;
    if (!a || !b) return null;
    return lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  completePoints(points) {
    const [p0, p1, p2] = points;
    if (!p0 || !p1 || !p2) return [...points];
    return [p0, p1, withTime(p2, p0)];
  },

  /** 0/1: trend ends; 2/3: flat line ends (at anchors 0/1's x). */
  handles(g) {
    const [a, b, c] = g.points;
    if (!a || !b) return g.points.map((p) => ({ x: p.x, y: p.y }));
    const hs: DrawingHandle[] = [{ ...a }, { ...b }];
    if (c) hs.push({ x: a.x, y: c.y }, { x: b.x, y: c.y });
    return hs;
  },

  /** 0/1 move the trend ends; 2/3 set the flat price and move anchor 0/1's time. */
  moveHandle({ start, handle, target }) {
    const pts = start.map((p) => ({ ...p }));
    const [p0, p1, p2] = pts;
    if (handle < 2) {
      if (handle < pts.length) pts[handle] = target;
      if (handle === 0 && p2) pts[2] = withTime(p2, target);
      return pts;
    }
    if (!p0 || !p1 || !p2) return pts;
    if (handle === 2)
      return [withTime(p0, target), p1, withPrice(withTime(p2, target), target.price)];
    return [p0, withTime(p1, target), withPrice(p2, target.price)];
  },

  timeAxisLabels: twoLineTimeLabels,

  isVisible(g, s) {
    const l = flatLines(g);
    return l ? twoLinesInView(g, s, l) : anchorsInView(g);
  },
});
