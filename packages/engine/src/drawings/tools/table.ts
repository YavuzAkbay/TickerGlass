import {
  approxTextWidth,
  BODY_HIT,
  setLineStyle,
  splitLines,
  TEXT_HIT,
  textFont,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry } from '../types';
import { hitBox, PAD, rectInView, type Rect } from './annotation-common';

export const TABLE_DEFAULTS = {
  textColor: '#131722',
  fontSize: 13,
  bold: false,
  italic: false,
  fillBackground: true,
  backgroundColor: 'rgba(255, 255, 255, 0.9)',
  showBorder: true,
  borderColor: '#A39E8F',
  headerRow: true,
  headerColor: 'rgba(110, 155, 214, 0.3)',
};

type TableStyle = typeof TABLE_DEFAULTS;

/** Shown (dimmed) while the text is empty. */
export const TABLE_PLACEHOLDER = 'Column 1 | Column 2\nCell | Cell';
const MIN_COL = 40;

/** Rows split by newline, cells by tab or `|` (trimmed). At least one row/cell. */
export function parseTable(text: string): string[][] {
  const rows = splitLines(text).map((r) => r.split(/\t|\|/).map((c) => c.trim()));
  const cols = Math.max(1, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < cols) r.push('');
  return rows;
}

export interface TableLayout extends Rect {
  rows: string[][];
  /** Column widths and the (uniform) row height. */
  cols: number[];
  rowH: number;
}

/** Table with its top-left corner at the anchor. */
export function tableLayout(g: DrawingGeometry, s: TableStyle): TableLayout | null {
  const p = g.points[0];
  if (!p) return null;
  const rows = parseTable(g.drawing.text || TABLE_PLACEHOLDER);
  const cols: number[] = [];
  rows.forEach((r, ri) =>
    r.forEach((c, ci) => {
      const bold = s.bold || (s.headerRow && ri === 0);
      const w = approxTextWidth(c, s.fontSize, bold, s.italic) + PAD * 2;
      cols[ci] = Math.max(cols[ci] ?? MIN_COL, w);
    }),
  );
  const rowH = s.fontSize * 1.2 + PAD * 2;
  const w = cols.reduce((a, b) => a + b, 0);
  return { x: p.x, y: p.y, w, h: rowH * rows.length, rows, cols, rowH };
}

/** Text grid at one anchor (top-left): rows by newline, cells by tab or `|`. */
export const table = defineDrawingTool({
  type: 'table',
  name: 'Table',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: TABLE_DEFAULTS,
  text: { default: TABLE_PLACEHOLDER, multiline: true },
  properties: [
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'headerRow', label: 'Header row', tab: 'text', inline: 'header' },
    { kind: 'color', key: 'headerColor', label: 'Color', tab: 'text', inline: 'header' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', tab: 'text', inline: 'bg' },
    { kind: 'color', key: 'backgroundColor', label: 'Color', tab: 'text', inline: 'bg' },
    { kind: 'bool', key: 'showBorder', label: 'Borders', tab: 'text', inline: 'border' },
    { kind: 'color', key: 'borderColor', label: 'Color', tab: 'text', inline: 'border' },
  ],

  render({ ctx, theme }, g, s) {
    const l = tableLayout(g, s);
    if (!l) return;
    if (!g.drawing.text) ctx.globalAlpha = 0.5;
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fillRect(l.x, l.y, l.w, l.h);
    }
    if (s.headerRow) {
      ctx.fillStyle = s.headerColor;
      ctx.fillRect(l.x, l.y, l.w, l.rowH);
    }
    if (s.showBorder) {
      setLineStyle(ctx, s.borderColor, 1, 'solid');
      ctx.beginPath();
      ctx.rect(l.x, l.y, l.w, l.h);
      let cx = l.x;
      for (let c = 0; c < l.cols.length - 1; c++) {
        cx += l.cols[c]!;
        ctx.moveTo(cx, l.y);
        ctx.lineTo(cx, l.y + l.h);
      }
      for (let r = 1; r < l.rows.length; r++) {
        ctx.moveTo(l.x, l.y + r * l.rowH);
        ctx.lineTo(l.x + l.w, l.y + r * l.rowH);
      }
      ctx.stroke();
    }
    ctx.fillStyle = s.textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let r = 0; r < l.rows.length; r++) {
      ctx.font = textFont(theme, s.fontSize, s.bold || (s.headerRow && r === 0), s.italic);
      let cx = l.x;
      for (let c = 0; c < l.cols.length; c++) {
        const cell = l.rows[r]![c]!;
        if (cell) ctx.fillText(cell, cx + PAD, l.y + r * l.rowH + PAD + s.fontSize * 0.1);
        cx += l.cols[c]!;
      }
    }
  },

  hitTest(g, s, x, y, tol) {
    const l = tableLayout(g, s);
    if (!l) return null;
    return hitBox(l, x, y, tol) ? (g.drawing.text ? TEXT_HIT : BODY_HIT) : null;
  },

  isVisible(g, s) {
    const l = tableLayout(g, s);
    return !!l && rectInView(g, l);
  },
});
