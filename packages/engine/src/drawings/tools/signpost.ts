import { BODY_HIT, lineDistance, setLineStyle, TEXT_HIT } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { pointInPolygon } from '../shape-utils';
import type { PixelPoint } from '../types';
import {
  ANNOTATION_PLACEHOLDER,
  ANNOTATION_PROPERTIES,
  annotationDefaults,
  PAD,
  rectInView,
  renderTextLines,
  textBlock,
  WRAP_PROPERTY,
  type Rect,
} from './annotation-common';

export const SIGNPOST_DEFAULTS = {
  ...annotationDefaults('#ffffff', '#089981'),
  borderColor: '#089981',
  poleHeight: 60,
  wrapWidth: 140,
};

type SignpostStyle = typeof SIGNPOST_DEFAULTS;

const ARROW = 8;

/** Pole from the anchor (its foot) up `poleHeight`, plate on top pointing right. */
export function signpostLayout(
  g: { points: readonly PixelPoint[]; drawing: { text: string } },
  s: SignpostStyle,
) {
  const p = g.points[0];
  if (!p) return null;
  const block = textBlock(g.drawing.text || ANNOTATION_PLACEHOLDER, s, s.wrapWidth);
  const box: Rect = { x: p.x, y: p.y - s.poleHeight - block.h, w: block.w, h: block.h };
  const plate: PixelPoint[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x + box.w + ARROW, y: box.y + box.h / 2 },
    { x: box.x + box.w, y: box.y + box.h },
    { x: box.x, y: box.y + box.h },
  ];
  return { block, box, plate, p };
}

/** A pole standing on the anchor with a text plate on top. */
export const signpost = defineDrawingTool({
  type: 'signpost',
  name: 'Signpost',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: SIGNPOST_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [
    ...ANNOTATION_PROPERTIES,
    WRAP_PROPERTY,
    { kind: 'number', key: 'poleHeight', label: 'Pole height', min: 10, max: 400, step: 5 },
  ],

  render(rc, g, s) {
    const l = signpostLayout(g, s);
    if (!l) return;
    const { ctx, theme } = rc;
    setLineStyle(ctx, s.borderColor, 2, 'solid');
    ctx.beginPath();
    ctx.moveTo(l.p.x, l.p.y);
    ctx.lineTo(l.p.x, l.box.y + l.box.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(l.p.x, l.p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = s.borderColor;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(l.plate[0]!.x, l.plate[0]!.y);
    for (let i = 1; i < l.plate.length; i++) ctx.lineTo(l.plate[i]!.x, l.plate[i]!.y);
    ctx.closePath();
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fill();
    }
    if (s.showBorder) {
      setLineStyle(ctx, s.borderColor, 1, 'solid');
      ctx.stroke();
    }
    renderTextLines(ctx, theme, l.block.lines, s, l.box.x + PAD, l.box.y + PAD, !g.drawing.text);
  },

  hitTest(g, s, x, y, tol) {
    const l = signpostLayout(g, s);
    if (!l) return null;
    if (pointInPolygon(l.plate, x, y)) return TEXT_HIT;
    return lineDistance(x, y, l.p.x, l.p.y, l.p.x, l.box.y + l.box.h) <= tol + 1 ? BODY_HIT : null;
  },

  isVisible(g, s) {
    const l = signpostLayout(g, s);
    return (
      !!l &&
      rectInView(g, { x: l.box.x, y: l.box.y, w: l.box.w + ARROW, h: s.poleHeight + l.box.h })
    );
  },
});
