import { BODY_HIT, splitLines } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { pointInPolygon, polylineDistance, tracePolyline } from '../shape-utils';
import type { PixelPoint } from '../types';
import {
  centeredTextBox,
  hitCenteredText,
  renderCenteredText,
  TEXT_PROPERTIES,
  textDefaults,
} from './shape-common';

/** Glyph size in px: total height, head height, head and shaft half widths. */
export const MARK_HEIGHT = 20;
const HEAD_H = 9;
const HEAD_HALF = 9;
const SHAFT_HALF = 3.5;
const TEXT_GAP = 4;

const poly: PixelPoint[] = Array.from({ length: 7 }, () => ({ x: 0, y: 0 }));

/** Arrow glyph with its tip at (x, y), pointing up (`dir` -1) or down (+1). Shared buffer. */
export function arrowMarkPolygon(x: number, y: number, dir: 1 | -1): PixelPoint[] {
  // Up arrow: the body hangs below the tip (dir -1 -> +y).
  const s = -dir;
  const local: [number, number][] = [
    [0, 0],
    [HEAD_HALF, HEAD_H],
    [SHAFT_HALF, HEAD_H],
    [SHAFT_HALF, MARK_HEIGHT],
    [-SHAFT_HALF, MARK_HEIGHT],
    [-SHAFT_HALF, HEAD_H],
    [-HEAD_HALF, HEAD_H],
  ];
  for (let i = 0; i < 7; i++) {
    poly[i]!.x = x + local[i]![0];
    poly[i]!.y = y + s * local[i]![1];
  }
  return poly;
}

/** Centre y of the text block beyond the glyph's tail. */
function textCentreY(y: number, dir: 1 | -1, h: number): number {
  return y - dir * (MARK_HEIGHT + TEXT_GAP + h / 2);
}

/** Single-click arrow glyph whose tip marks the anchor; text past its tail. */
export function makeArrowMark(type: string, name: string, dir: 1 | -1, color: string) {
  return defineDrawingTool({
    type,
    name,
    group: 'shapes',
    creation: { kind: 'click' },
    defaults: { arrowColor: color, ...textDefaults(color) },
    text: { default: '', multiline: true },
    properties: [{ kind: 'color', key: 'arrowColor', label: 'Color' }, ...TEXT_PROPERTIES],

    render(rc, g, s) {
      const a = g.points[0];
      if (!a) return;
      const { ctx } = rc;
      ctx.fillStyle = s.arrowColor;
      ctx.beginPath();
      tracePolyline(ctx, arrowMarkPolygon(a.x, a.y, dir), true);
      ctx.fill();
      const text = g.drawing.text;
      if (!text) return;
      const box = centeredTextBox(splitLines(text), s, 0, 0);
      renderCenteredText(rc, text, s, a.x, textCentreY(a.y, dir, box.h));
    },

    hitTest(g, s, x, y, tol) {
      const a = g.points[0];
      if (!a) return null;
      const text = g.drawing.text;
      if (text) {
        const box = centeredTextBox(splitLines(text), s, 0, 0);
        const hit = hitCenteredText(text, s, a.x, textCentreY(a.y, dir, box.h), x, y);
        if (hit) return hit;
      }
      const pts = arrowMarkPolygon(a.x, a.y, dir);
      return pointInPolygon(pts, x, y) || polylineDistance(pts, x, y, true) <= tol
        ? BODY_HIT
        : null;
    },
  });
}

export const arrowMarkUp = makeArrowMark('arrow-mark-up', 'Arrow mark up', -1, '#089981');
