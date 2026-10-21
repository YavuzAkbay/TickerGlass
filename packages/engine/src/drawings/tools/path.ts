import { arrowHead, BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { polylineDistance, strokePolyline } from '../shape-utils';
import { arrowSize } from './arrow-line';
import { LINE_PROPERTIES, lineDefaults, pointsInView } from './shape-common';

type LineEnd = 'normal' | 'arrow';

export const PATH_DEFAULTS = {
  ...lineDefaults('#6E9BD6'),
  leftEnd: 'normal' as LineEnd,
  rightEnd: 'arrow' as LineEnd,
};

/** Open polyline of 2+ clicked anchors; arrow head at the end by default. */
export const path = defineDrawingTool({
  type: 'path',
  name: 'Path',
  group: 'shapes',
  creation: { kind: 'multi', min: 2 },
  defaults: PATH_DEFAULTS,
  properties: [
    ...LINE_PROPERTIES,
    {
      kind: 'enum',
      key: 'leftEnd',
      label: 'Line start',
      inline: 'ends',
      options: ['normal', 'arrow'],
      labels: ['Normal', 'Arrow'],
    },
    {
      kind: 'enum',
      key: 'rightEnd',
      label: 'Line end',
      inline: 'ends',
      options: ['normal', 'arrow'],
      labels: ['Normal', 'Arrow'],
    },
  ],

  render({ ctx }, g, s) {
    const pts = g.points;
    const n = pts.length;
    if (n < 2) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokePolyline(ctx, pts);
    const size = arrowSize(s.lineWidth);
    const a = pts[n - 2]!;
    const b = pts[n - 1]!;
    if (s.rightEnd === 'arrow') arrowHead(ctx, a.x, a.y, b.x, b.y, size);
    if (s.leftEnd === 'arrow') arrowHead(ctx, pts[1]!.x, pts[1]!.y, pts[0]!.x, pts[0]!.y, size);
  },

  hitTest(g, s, x, y, tol) {
    if (g.points.length < 2) return null;
    return polylineDistance(g.points, x, y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  isVisible(g) {
    return pointsInView(g, g.points);
  },
});
