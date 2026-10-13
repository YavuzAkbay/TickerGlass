import { approxTextWidth, setLineStyle, splitLines, TEXT_HIT, textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';

const PAD = 4;
/** Shown (dimmed) while the text is empty, so a fresh drawing is visible and grabbable. */
export const TEXT_PLACEHOLDER = 'Text';

export const TEXT_DEFAULTS = {
  textColor: '#2962ff',
  fontSize: 14,
  bold: false,
  italic: false,
  fillBackground: false,
  backgroundColor: 'rgba(41, 98, 255, 0.2)',
  showBorder: false,
  borderColor: '#2962ff',
};

type TextStyle = typeof TEXT_DEFAULTS;

/** Box (top-left at the anchor) around the text incl. padding. */
const box = { x: 0, y: 0, w: 0, h: 0 };

function textBox(g: DrawingGeometry, s: TextStyle, lines: readonly string[]): typeof box | null {
  const p = g.points[0];
  if (!p) return null;
  let w = 0;
  for (const l of lines) w = Math.max(w, approxTextWidth(l, s.fontSize, s.bold, s.italic));
  box.x = p.x;
  box.y = p.y;
  box.w = w + PAD * 2;
  box.h = lines.length * s.fontSize * 1.2 + PAD * 2;
  return box;
}

/** Free text at one anchor (top-left). Text is edited by the app (Text tab / inline editor). */
export const text = defineDrawingTool({
  type: 'text',
  name: 'Text',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: TEXT_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', tab: 'text', inline: 'bg' },
    { kind: 'color', key: 'backgroundColor', label: 'Color', tab: 'text', inline: 'bg' },
    { kind: 'bool', key: 'showBorder', label: 'Border', tab: 'text', inline: 'border' },
    { kind: 'color', key: 'borderColor', label: 'Color', tab: 'text', inline: 'border' },
  ],

  render({ ctx, theme }, g, s) {
    const lines = splitLines(g.drawing.text || TEXT_PLACEHOLDER);
    const b = textBox(g, s, lines);
    if (!b) return;
    ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
    // Measured width for drawing (the hit box uses the approximation).
    let w = 0;
    for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
    w += PAD * 2;
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fillRect(b.x, b.y, w, b.h);
    }
    if (s.showBorder) {
      setLineStyle(ctx, s.borderColor, 1, 'solid');
      ctx.strokeRect(b.x, b.y, w, b.h);
    }
    if (!g.drawing.text) ctx.globalAlpha = 0.5;
    ctx.fillStyle = s.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lineH = s.fontSize * 1.2;
    for (let i = 0; i < lines.length; i++)
      ctx.fillText(lines[i]!, b.x + PAD, b.y + PAD + i * lineH + s.fontSize * 0.1);
  },

  hitTest(g, s, x, y, tol) {
    const b = textBox(g, s, splitLines(g.drawing.text || TEXT_PLACEHOLDER));
    if (!b) return null;
    return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol
      ? TEXT_HIT
      : null;
  },

  isVisible(g, s) {
    const p = g.points[0];
    if (!p) return false;
    const b = textBox(g, s, splitLines(g.drawing.text || TEXT_PLACEHOLDER));
    return !!b && p.x + b.w >= 0 && p.x <= g.width && p.y + b.h >= 0 && p.y <= g.height;
  },
});
