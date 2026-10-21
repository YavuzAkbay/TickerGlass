import { approxTextWidth, BODY_HIT, setLineStyle, TEXT_HIT, textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingLineStyle } from '../types';

const TEXT_GAP = 4;
const TEXT_MARGIN = 8;

export const HORIZONTAL_RAY_DEFAULTS = {
  lineColor: '#6E9BD6',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  showPriceLabel: true,
  textColor: '#6E9BD6',
  fontSize: 12,
  bold: false,
  italic: false,
  textAlign: 'left' as 'left' | 'center' | 'right',
};

type HorizontalRayStyle = typeof HORIZONTAL_RAY_DEFAULTS;

/** Text anchor x for the alignment within [start, width]. */
function textX(start: number, width: number, s: HorizontalRayStyle): number {
  const l = Math.max(start, 0);
  return s.textAlign === 'left'
    ? l + TEXT_MARGIN
    : s.textAlign === 'center'
      ? (l + width) / 2
      : width - TEXT_MARGIN;
}

/** Horizontal line from its anchor to the right edge; price-axis label. */
export const horizontalRay = defineDrawingTool({
  type: 'horizontal-ray',
  name: 'Horizontal ray',
  group: 'lines',
  creation: { kind: 'click' },
  defaults: HORIZONTAL_RAY_DEFAULTS,
  text: { default: '', multiline: false },
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'showPriceLabel', label: 'Price label' },
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
    {
      kind: 'enum',
      key: 'textAlign',
      label: 'Alignment',
      tab: 'text',
      options: ['left', 'center', 'right'],
      labels: ['Left', 'Center', 'Right'],
    },
  ],

  render({ ctx, theme }, g, s) {
    const p = g.points[0];
    if (!p) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.beginPath();
    ctx.moveTo(Math.max(p.x, -10), p.y);
    ctx.lineTo(g.width, p.y);
    ctx.stroke();
    const text = g.drawing.text;
    if (!text) return;
    ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
    ctx.fillStyle = s.textColor;
    ctx.textAlign = s.textAlign;
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, textX(p.x, g.width, s), p.y - TEXT_GAP - s.lineWidth / 2);
  },

  hitTest(g, s, x, y, tol) {
    const p = g.points[0];
    if (!p) return null;
    const text = g.drawing.text;
    if (text) {
      const w = approxTextWidth(text, s.fontSize, s.bold, s.italic);
      const tx = textX(p.x, g.width, s);
      const x0 = s.textAlign === 'left' ? tx : s.textAlign === 'center' ? tx - w / 2 : tx - w;
      const bottom = p.y - TEXT_GAP - s.lineWidth / 2;
      if (x >= x0 && x <= x0 + w && y <= bottom && y >= bottom - s.fontSize * 1.2) return TEXT_HIT;
    }
    return x >= p.x - tol && Math.abs(y - p.y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  priceAxisLabels(d, s, state) {
    const p = d.points[0];
    return p && (s.showPriceLabel || state.selected)
      ? [{ value: p.price, color: s.lineColor }]
      : [];
  },

  isVisible(g) {
    const p = g.points[0];
    return !!p && p.x <= g.width + 20 && p.y >= -20 && p.y <= g.height + 20;
  },
});
