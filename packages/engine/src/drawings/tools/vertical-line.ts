import { approxTextWidth, BODY_HIT, setLineStyle, TEXT_HIT, textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingLineStyle } from '../types';

const TEXT_GAP = 4;
const TEXT_MARGIN = 8;

export const VERTICAL_LINE_DEFAULTS = {
  lineColor: '#4f6bed',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  showTimeLabel: true,
  textColor: '#4f6bed',
  fontSize: 12,
  bold: false,
  italic: false,
  textOrientation: 'vertical' as 'vertical' | 'horizontal',
  textVAlign: 'top' as 'top' | 'middle' | 'bottom',
};

type VerticalLineStyle = typeof VERTICAL_LINE_DEFAULTS;

/** Text box (unrotated layout) for the alignment: start y along the line. */
function textY(height: number, s: VerticalLineStyle, len: number): number {
  // Vertical text runs bottom-to-top; `len` is its length along the line.
  if (s.textOrientation === 'vertical') {
    return s.textVAlign === 'top'
      ? TEXT_MARGIN + len
      : s.textVAlign === 'middle'
        ? (height + len) / 2
        : height - TEXT_MARGIN;
  }
  return s.textVAlign === 'top'
    ? TEXT_MARGIN
    : s.textVAlign === 'middle'
      ? (height - len) / 2
      : height - TEXT_MARGIN - len;
}

/** Infinite vertical line at one time; single click; time-axis label. */
export const verticalLine = defineDrawingTool({
  type: 'vertical-line',
  name: 'Vertical line',
  group: 'lines',
  creation: { kind: 'click' },
  axes: 'time',
  defaults: VERTICAL_LINE_DEFAULTS,
  text: { default: '', multiline: false },
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'showTimeLabel', label: 'Time label' },
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
    {
      kind: 'enum',
      key: 'textOrientation',
      label: 'Orientation',
      tab: 'text',
      options: ['vertical', 'horizontal'],
      labels: ['Vertical', 'Horizontal'],
    },
    {
      kind: 'enum',
      key: 'textVAlign',
      label: 'Position',
      tab: 'text',
      options: ['top', 'middle', 'bottom'],
      labels: ['Top', 'Middle', 'Bottom'],
    },
  ],

  render({ ctx, theme }, g, s) {
    const p = g.points[0];
    if (!p) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.beginPath();
    ctx.moveTo(p.x, 0);
    ctx.lineTo(p.x, g.height);
    ctx.stroke();
    const text = g.drawing.text;
    if (!text) return;
    ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
    ctx.fillStyle = s.textColor;
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    if (s.textOrientation === 'vertical') {
      const len = ctx.measureText(text).width;
      ctx.translate(p.x - TEXT_GAP - s.lineWidth / 2, textY(g.height, s, len));
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(text, 0, 0);
    } else {
      ctx.textBaseline = 'top';
      ctx.fillText(text, p.x + TEXT_GAP + s.lineWidth / 2, textY(g.height, s, s.fontSize * 1.2));
    }
  },

  hitTest(g, s, x, y, tol) {
    const p = g.points[0];
    if (!p) return null;
    const text = g.drawing.text;
    if (text) {
      const w = approxTextWidth(text, s.fontSize, s.bold, s.italic);
      const h = s.fontSize * 1.2;
      const off = TEXT_GAP + s.lineWidth / 2;
      if (s.textOrientation === 'vertical') {
        const bottom = textY(g.height, s, w);
        if (x <= p.x - off && x >= p.x - off - h && y <= bottom && y >= bottom - w) return TEXT_HIT;
      } else {
        const top = textY(g.height, s, h);
        if (x >= p.x + off && x <= p.x + off + w && y >= top && y <= top + h) return TEXT_HIT;
      }
    }
    return Math.abs(x - p.x) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  handles(g) {
    const p = g.points[0];
    return p ? [{ x: p.x, y: g.height / 2, cursor: 'ew-resize' }] : [];
  },

  priceAxisLabels() {
    return [];
  },

  timeAxisLabels(d, s, state) {
    const p = d.points[0];
    return p && (s.showTimeLabel || state.selected) ? [{ value: p.time, color: s.lineColor }] : [];
  },

  isVisible(g) {
    const p = g.points[0];
    return !!p && p.x >= -20 && p.x <= g.width + 20;
  },
});
