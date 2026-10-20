import { defineDrawingTool } from '../registry';
import {
  ANNOTATION_PLACEHOLDER,
  ANNOTATION_PROPERTIES,
  annotationDefaults,
  BUBBLE_RADIUS,
  bubbleBounds,
  hitBubble,
  rectInView,
  renderBubble,
  textBlock,
  WRAP_PROPERTY,
  type Rect,
} from './annotation-common';

export const COMMENT_DEFAULTS = {
  ...annotationDefaults('#ffffff', '#4f6bed'),
  borderColor: '#4f6bed',
  wrapWidth: 160,
};

type CommentStyle = typeof COMMENT_DEFAULTS;

const RISE = 12;
const MIN_WIDTH = 56;

/** Speech bubble above the anchor with its pointer at the anchor (lower-left). */
export function commentLayout(
  g: { points: readonly { x: number; y: number }[]; drawing: { text: string } },
  s: CommentStyle,
) {
  const p = g.points[0];
  if (!p) return null;
  const block = textBlock(g.drawing.text || ANNOTATION_PLACEHOLDER, s, s.wrapWidth);
  const w = Math.max(block.w, MIN_WIDTH);
  const box: Rect = { x: p.x - (BUBBLE_RADIUS + 8), y: p.y - RISE - block.h, w, h: block.h };
  return { block, box, tip: p };
}

/** Speech-bubble comment anchored at one point. */
export const comment = defineDrawingTool({
  type: 'comment',
  name: 'Comment',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: COMMENT_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [...ANNOTATION_PROPERTIES, WRAP_PROPERTY],

  render(rc, g, s) {
    const l = commentLayout(g, s);
    if (l) renderBubble(rc, l.box, l.tip, l.block, s, !g.drawing.text);
  },

  hitTest(g, s, x, y, tol) {
    const l = commentLayout(g, s);
    return l ? hitBubble(l.box, l.tip, x, y, tol) : null;
  },

  isVisible(g, s) {
    const l = commentLayout(g, s);
    return !!l && rectInView(g, bubbleBounds(l.box, l.tip));
  },
});
