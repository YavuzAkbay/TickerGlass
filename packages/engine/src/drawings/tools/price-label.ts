import { defineDrawingTool } from '../registry';
import {
  ANNOTATION_PROPERTIES,
  annotationDefaults,
  bubbleBounds,
  hitBubble,
  rectInView,
  renderBubble,
  textBlock,
  type Rect,
} from './annotation-common';

export const PRICE_LABEL_DEFAULTS = annotationDefaults('#ffffff', '#2962ff');

type PriceLabelStyle = typeof PRICE_LABEL_DEFAULTS;

const GAP = 10;

/** Label right of the anchor showing the anchor price, pointer at the anchor. */
export function priceLabelLayout(
  g: {
    points: readonly { x: number; y: number }[];
    drawing: { points: readonly { price: number }[] };
    format: { price(v: number): string };
  },
  s: PriceLabelStyle,
) {
  const p = g.points[0];
  const price = g.drawing.points[0]?.price;
  if (!p || price === undefined) return null;
  const block = textBlock(g.format.price(price), s, 1000);
  const box: Rect = { x: p.x + GAP, y: p.y - block.h / 2, w: block.w, h: block.h };
  return { block, box, tip: p };
}

/** Single click: a label with the price at the anchor, pointing to it. */
export const priceLabel = defineDrawingTool({
  type: 'price-label',
  name: 'Price label',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: PRICE_LABEL_DEFAULTS,
  properties: ANNOTATION_PROPERTIES,

  render(rc, g, s) {
    const l = priceLabelLayout(g, s);
    if (l) renderBubble(rc, l.box, l.tip, l.block, s);
  },

  hitTest(g, s, x, y, tol) {
    const l = priceLabelLayout(g, s);
    const hit = l ? hitBubble(l.box, l.tip, x, y, tol) : null;
    return hit ? { kind: 'body' } : null;
  },

  isVisible(g, s) {
    const l = priceLabelLayout(g, s);
    return !!l && rectInView(g, bubbleBounds(l.box, l.tip));
  },
});
