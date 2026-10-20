import {
  anchorsInView,
  approxTextWidth,
  arrowHead,
  BODY_HIT,
  hitRotatedText,
  lineDistance,
  setLineStyle,
  TEXT_HIT,
  textFont,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingLineStyle } from '../types';
import { textAngle } from './trend-line';

const TEXT_GAP = 4;

type LineEnd = 'normal' | 'arrow';

export const ARROW_LINE_DEFAULTS = {
  lineColor: '#4f6bed',
  lineWidth: 2,
  lineStyle: 'solid' as DrawingLineStyle,
  leftEnd: 'normal' as LineEnd,
  rightEnd: 'arrow' as LineEnd,
  textColor: '#4f6bed',
  fontSize: 14,
  bold: false,
  italic: false,
};

/** Arrow head length for a line width. */
export function arrowSize(lineWidth: number): number {
  return 6 + lineWidth * 3;
}

/** Segment between two anchors with an arrow head at the end (start head optional). */
export const arrowLine = defineDrawingTool({
  type: 'arrow-line',
  name: 'Arrow',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  defaults: ARROW_LINE_DEFAULTS,
  text: { default: '', multiline: false },
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
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
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
  ],

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const size = arrowSize(s.lineWidth);
    if (s.rightEnd === 'arrow') arrowHead(ctx, a.x, a.y, b.x, b.y, size);
    if (s.leftEnd === 'arrow') arrowHead(ctx, b.x, b.y, a.x, a.y, size);
    const text = g.drawing.text;
    if (!text) return;
    ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2);
    ctx.rotate(textAngle(a, b));
    ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
    ctx.fillStyle = s.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, 0, -TEXT_GAP - s.lineWidth / 2);
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const text = g.drawing.text;
    if (text) {
      const off = TEXT_GAP + s.lineWidth / 2;
      const angle = textAngle(a, b);
      const cx = (a.x + b.x) / 2 + Math.sin(angle) * off;
      const cy = (a.y + b.y) / 2 - Math.cos(angle) * off;
      const w = approxTextWidth(text, s.fontSize, s.bold, s.italic);
      if (hitRotatedText(x, y, cx, cy, angle, w, s.fontSize * 1.2)) return TEXT_HIT;
    }
    return lineDistance(x, y, a.x, a.y, b.x, b.y) <= tol + s.lineWidth / 2 ? BODY_HIT : null;
  },

  isVisible(g) {
    return anchorsInView(g);
  },
});
