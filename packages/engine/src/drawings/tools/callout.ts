import { defineDrawingTool } from '../registry';
import {
  ANNOTATION_PLACEHOLDER,
  ANNOTATION_PROPERTIES,
  annotationDefaults,
  bubbleBounds,
  hitBubble,
  rectInView,
  renderBubble,
  textBlock,
  WRAP_PROPERTY,
  type Rect,
} from './annotation-common';

export const CALLOUT_DEFAULTS = {
  ...annotationDefaults('#2962ff', 'rgba(41, 98, 255, 0.2)'),
  wrapWidth: 180,
};

type CalloutStyle = typeof CALLOUT_DEFAULTS;

/** Bubble centred on anchor 2, pointing to anchor 1 (the target). */
export function calloutLayout(
  g: { points: readonly { x: number; y: number }[]; drawing: { text: string } },
  s: CalloutStyle,
) {
  const [target, at] = g.points;
  if (!target || !at) return null;
  const block = textBlock(g.drawing.text || ANNOTATION_PLACEHOLDER, s, s.wrapWidth);
  const box: Rect = { x: at.x - block.w / 2, y: at.y - block.h / 2, w: block.w, h: block.h };
  return { block, box, tip: target };
}

/** Text bubble (anchor 2) with a pointer to the target (anchor 1). */
export const callout = defineDrawingTool({
  type: 'callout',
  name: 'Callout',
  group: 'annotation',
  creation: { kind: 'points', count: 2 },
  defaults: CALLOUT_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [...ANNOTATION_PROPERTIES, WRAP_PROPERTY],

  render(rc, g, s) {
    const l = calloutLayout(g, s);
    if (l) renderBubble(rc, l.box, l.tip, l.block, s, !g.drawing.text);
  },

  hitTest(g, s, x, y, tol) {
    const l = calloutLayout(g, s);
    return l ? hitBubble(l.box, l.tip, x, y, tol) : null;
  },

  isVisible(g, s) {
    const l = calloutLayout(g, s);
    return !!l && rectInView(g, bubbleBounds(l.box, l.tip));
  },
});
