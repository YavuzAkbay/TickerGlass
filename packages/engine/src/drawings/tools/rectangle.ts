import {
  anchorsInView,
  approxTextWidth,
  BODY_HIT,
  boxEdgeDistance,
  inBox,
  setLineStyle,
  splitLines,
  TEXT_HIT,
  textFont,
} from '../draw-utils';
import { withPrice, withTime } from '../geometry';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingHandle, DrawingLineStyle } from '../types';

const TEXT_PAD = 6;

export const RECTANGLE_DEFAULTS = {
  lineColor: '#8e5cf6',
  lineWidth: 1,
  lineStyle: 'solid' as DrawingLineStyle,
  fillBackground: true,
  backgroundColor: 'rgba(142, 92, 246, 0.2)',
  extendLeft: false,
  extendRight: false,
  showMiddleLine: false,
  middleLineColor: '#8e5cf6',
  middleLineWidth: 1,
  middleLineStyle: 'dashed' as DrawingLineStyle,
  textColor: '#8e5cf6',
  fontSize: 14,
  bold: false,
  italic: false,
  textHAlign: 'center' as 'left' | 'center' | 'right',
  textVAlign: 'middle' as 'top' | 'middle' | 'bottom',
};

type RectangleStyle = typeof RECTANGLE_DEFAULTS;

/** Box in px: left, top, right, bottom (extends applied to l/r). */
const box = { l: 0, t: 0, r: 0, b: 0 };

function computeBox(g: DrawingGeometry, s: RectangleStyle): typeof box | null {
  const [a, b] = g.points;
  if (!a || !b) return null;
  box.l = s.extendLeft ? 0 : Math.min(a.x, b.x);
  box.r = s.extendRight ? g.width : Math.max(a.x, b.x);
  box.t = Math.min(a.y, b.y);
  box.b = Math.max(a.y, b.y);
  return box;
}

/** Text block origin (x for the alignment, y of the first line's top). */
const tpos = { x: 0, y: 0, w: 0, h: 0 };

function textBlock(s: RectangleStyle, lines: readonly string[], bx: typeof box): typeof tpos {
  const lineH = s.fontSize * 1.2;
  let w = 0;
  for (const l of lines) w = Math.max(w, approxTextWidth(l, s.fontSize, s.bold, s.italic));
  tpos.w = w;
  tpos.h = lines.length * lineH;
  tpos.x =
    s.textHAlign === 'left'
      ? bx.l + TEXT_PAD
      : s.textHAlign === 'right'
        ? bx.r - TEXT_PAD
        : (bx.l + bx.r) / 2;
  tpos.y =
    s.textVAlign === 'top'
      ? bx.t + TEXT_PAD
      : s.textVAlign === 'bottom'
        ? bx.b - TEXT_PAD - tpos.h
        : (bx.t + bx.b - tpos.h) / 2;
  return tpos;
}

/**
 * Rectangle between two corner anchors. Handles: 0/1 the anchors, 2 (x0, y1),
 * 3 (x1, y0), then edge midpoints 4 left(x0), 5 right(x1), 6 at y0, 7 at y1.
 */
export const rectangle = defineDrawingTool({
  type: 'rectangle',
  name: 'Rectangle',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: RECTANGLE_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Border', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    { kind: 'color', key: 'backgroundColor', label: 'Color', inline: 'bg' },
    { kind: 'bool', key: 'showMiddleLine', label: 'Middle line', inline: 'middle' },
    { kind: 'color', key: 'middleLineColor', label: 'Color', inline: 'middle' },
    { kind: 'lineWidth', key: 'middleLineWidth', label: 'Width', inline: 'middle' },
    { kind: 'lineStyle', key: 'middleLineStyle', label: 'Style', inline: 'middle' },
    { kind: 'bool', key: 'extendLeft', label: 'Extend left' },
    { kind: 'bool', key: 'extendRight', label: 'Extend right' },
    { kind: 'color', key: 'textColor', label: 'Color', tab: 'text', inline: 'font' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'bold', label: 'Bold', tab: 'text', inline: 'font' },
    { kind: 'bool', key: 'italic', label: 'Italic', tab: 'text', inline: 'font' },
    {
      kind: 'enum',
      key: 'textHAlign',
      label: 'Horizontal',
      tab: 'text',
      inline: 'align',
      options: ['left', 'center', 'right'],
      labels: ['Left', 'Center', 'Right'],
    },
    {
      kind: 'enum',
      key: 'textVAlign',
      label: 'Vertical',
      tab: 'text',
      inline: 'align',
      options: ['top', 'middle', 'bottom'],
      labels: ['Top', 'Middle', 'Bottom'],
    },
  ],

  render({ ctx, theme }, g, s) {
    const bx = computeBox(g, s);
    if (!bx) return;
    const w = bx.r - bx.l;
    const h = bx.b - bx.t;
    if (s.fillBackground) {
      ctx.fillStyle = s.backgroundColor;
      ctx.fillRect(bx.l, bx.t, w, h);
    }
    if (s.showMiddleLine) {
      setLineStyle(ctx, s.middleLineColor, s.middleLineWidth, s.middleLineStyle);
      ctx.beginPath();
      ctx.moveTo(bx.l, (bx.t + bx.b) / 2);
      ctx.lineTo(bx.r, (bx.t + bx.b) / 2);
      ctx.stroke();
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    ctx.strokeRect(bx.l, bx.t, w, h);
    const text = g.drawing.text;
    if (!text) return;
    const lines = splitLines(text);
    const tp = textBlock(s, lines, bx);
    ctx.font = textFont(theme, s.fontSize, s.bold, s.italic);
    ctx.fillStyle = s.textColor;
    ctx.textAlign = s.textHAlign;
    ctx.textBaseline = 'top';
    const lineH = s.fontSize * 1.2;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i]!, tp.x, tp.y + i * lineH);
  },

  hitTest(g, s, x, y, tol) {
    const bx = computeBox(g, s);
    if (!bx) return null;
    const text = g.drawing.text;
    if (text) {
      const tp = textBlock(s, splitLines(text), bx);
      const x0 =
        s.textHAlign === 'left' ? tp.x : s.textHAlign === 'right' ? tp.x - tp.w : tp.x - tp.w / 2;
      if (x >= x0 && x <= x0 + tp.w && y >= tp.y && y <= tp.y + tp.h) return TEXT_HIT;
    }
    if (boxEdgeDistance(x, y, bx.l, bx.t, bx.r, bx.b) <= tol + s.lineWidth / 2) return BODY_HIT;
    // The interior is grabbable (strong) when filled,.
    return s.fillBackground && inBox(x, y, bx.l, bx.t, bx.r, bx.b) ? BODY_HIT : null;
  },

  handles(g) {
    const [a, b] = g.points;
    if (!a || !b) return [];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const diag = (b.x - a.x) * (b.y - a.y) >= 0 ? 'nwse-resize' : 'nesw-resize';
    const anti = diag === 'nwse-resize' ? 'nesw-resize' : 'nwse-resize';
    const hs: DrawingHandle[] = [
      { x: a.x, y: a.y, cursor: diag },
      { x: b.x, y: b.y, cursor: diag },
      { x: a.x, y: b.y, cursor: anti },
      { x: b.x, y: a.y, cursor: anti },
      { x: a.x, y: my, cursor: 'ew-resize' },
      { x: b.x, y: my, cursor: 'ew-resize' },
      { x: mx, y: a.y, cursor: 'ns-resize' },
      { x: mx, y: b.y, cursor: 'ns-resize' },
    ];
    return hs;
  },

  moveHandle({ start, handle, target }) {
    const p0 = start[0];
    const p1 = start[1];
    if (!p0 || !p1) return start.map((p) => ({ ...p }));
    switch (handle) {
      case 0:
        return [target, { ...p1 }];
      case 1:
        return [{ ...p0 }, target];
      case 2:
        return [withTime(p0, target), withPrice(p1, target.price)];
      case 3:
        return [withPrice(p0, target.price), withTime(p1, target)];
      case 4:
        return [withTime(p0, target), { ...p1 }];
      case 5:
        return [{ ...p0 }, withTime(p1, target)];
      case 6:
        return [withPrice(p0, target.price), { ...p1 }];
      case 7:
        return [{ ...p0 }, withPrice(p1, target.price)];
      default:
        return [{ ...p0 }, { ...p1 }];
    }
  },

  isVisible(g, s) {
    return s.extendLeft || s.extendRight || anchorsInView(g);
  },
});
