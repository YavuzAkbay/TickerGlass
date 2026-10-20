import { BODY_HIT, lineDistance, setLineStyle, TEXT_HIT } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import {
  ANNOTATION_PROPERTIES,
  annotationDefaults,
  hitBox,
  PAD,
  rectInView,
  renderTextLines,
  textBlock,
  WRAP_PROPERTY,
  type Rect,
} from './annotation-common';

export const PRICE_TAG_DEFAULTS = {
  ...annotationDefaults('#131722', 'rgba(255, 235, 150, 0.95)'),
  borderColor: '#f5a623',
  wrapWidth: 180,
};

type PriceTagStyle = typeof PRICE_TAG_DEFAULTS;

/** Label centred on anchor 2: the price of anchor 1, then the user's text. */
export function priceTagLayout(
  g: {
    points: readonly { x: number; y: number }[];
    drawing: { text: string; points: readonly { price: number }[] };
    format: { price(v: number): string };
  },
  s: PriceTagStyle,
) {
  const [a, b] = g.points;
  const price = g.drawing.points[0]?.price;
  if (!a || !b || price === undefined) return null;
  const block = textBlock(
    g.drawing.text ? `${g.format.price(price)}\n${g.drawing.text}` : g.format.price(price),
    s,
    s.wrapWidth,
  );
  const box: Rect = { x: b.x - block.w / 2, y: b.y - block.h / 2, w: block.w, h: block.h };
  // Connector ends where it meets the box (anchor 1 clamped into it).
  const ex = Math.min(Math.max(a.x, box.x), box.x + box.w);
  const ey = Math.min(Math.max(a.y, box.y), box.y + box.h);
  return { block, box, a, ex, ey };
}

/** Anchor 1 marks a price; the label (anchor 2) shows that price and a note. */
export const priceTag = defineDrawingTool({
  type: 'price-tag',
  name: 'Price tag',
  group: 'annotation',
  creation: { kind: 'points', count: 2 },
  defaults: PRICE_TAG_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [...ANNOTATION_PROPERTIES, WRAP_PROPERTY],

  render(rc, g, s) {
    const l = priceTagLayout(g, s);
    if (!l) return;
    const { ctx, theme } = rc;
    setLineStyle(ctx, s.borderColor, 1, 'solid');
    ctx.beginPath();
    ctx.moveTo(l.a.x, l.a.y);
    ctx.lineTo(l.ex, l.ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(l.a.x, l.a.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = s.borderColor;
    ctx.fill();
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fillRect(l.box.x, l.box.y, l.box.w, l.box.h);
    }
    if (s.showBorder) {
      setLineStyle(ctx, s.borderColor, 1, 'solid');
      ctx.strokeRect(l.box.x, l.box.y, l.box.w, l.box.h);
    }
    renderTextLines(ctx, theme, l.block.lines, s, l.box.x + PAD, l.box.y + PAD);
  },

  hitTest(g, s, x, y, tol) {
    const l = priceTagLayout(g, s);
    if (!l) return null;
    if (hitBox(l.box, x, y, tol)) return TEXT_HIT;
    return lineDistance(x, y, l.a.x, l.a.y, l.ex, l.ey) <= tol ||
      Math.hypot(x - l.a.x, y - l.a.y) <= tol + 3
      ? BODY_HIT
      : null;
  },

  isVisible(g, s) {
    const l = priceTagLayout(g, s);
    if (!l) return false;
    return rectInView(g, l.box) || rectInView(g, { x: l.a.x - 3, y: l.a.y - 3, w: 6, h: 6 });
  },
});
