import { anchorsInView, BODY_HIT, splitLines } from '../draw-utils';
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

/** Head length (px, at most the arrow length), head and shaft half widths. */
const HEAD_LEN = 20;
const HEAD_HALF = 10;
const SHAFT_HALF = 4;
const TEXT_GAP = 4;

export const ARROW_MARKER_DEFAULTS = {
  arrowColor: '#2962ff',
  ...textDefaults('#2962ff'),
};

const poly: PixelPoint[] = Array.from({ length: 7 }, () => ({ x: 0, y: 0 }));

/**
 * Outline of the thick arrow from tail `a` to tip `b` (shared buffer), or null
 * for a zero-length arrow. Order: tail, neck, barb, tip, barb, neck, tail.
 */
export function arrowMarkerPolygon(a: PixelPoint, b: PixelPoint): PixelPoint[] | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return null;
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const hl = Math.min(len, HEAD_LEN);
  const local: [number, number][] = [
    [0, -SHAFT_HALF],
    [len - hl, -SHAFT_HALF],
    [len - hl, -HEAD_HALF],
    [len, 0],
    [len - hl, HEAD_HALF],
    [len - hl, SHAFT_HALF],
    [0, SHAFT_HALF],
  ];
  for (let i = 0; i < 7; i++) {
    const [u, v] = local[i]!;
    poly[i]!.x = a.x + ux * u - uy * v;
    poly[i]!.y = a.y + uy * u + ux * v;
  }
  return poly;
}

const tc = { x: 0, y: 0 };

/** Centre of the text block, past the tail opposite to the arrow direction. */
function textCentre(a: PixelPoint, b: PixelPoint, w: number, h: number): typeof tc {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = len > 0 ? (b.x - a.x) / len : 0;
  const uy = len > 0 ? (b.y - a.y) / len : 1;
  const off = TEXT_GAP + SHAFT_HALF + Math.abs(ux) * (w / 2) + Math.abs(uy) * (h / 2);
  tc.x = a.x - ux * off;
  tc.y = a.y - uy * off;
  return tc;
}

/** Thick filled arrow from anchor 0 (tail) to anchor 1 (tip); text past the tail. */
export const arrowMarker = defineDrawingTool({
  type: 'arrow-marker',
  name: 'Arrow marker',
  group: 'shapes',
  creation: { kind: 'points', count: 2 },
  defaults: ARROW_MARKER_DEFAULTS,
  text: { default: '', multiline: true },
  properties: [{ kind: 'color', key: 'arrowColor', label: 'Color' }, ...TEXT_PROPERTIES],

  render(rc, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    const pts = arrowMarkerPolygon(a, b);
    if (pts) {
      const { ctx } = rc;
      ctx.fillStyle = s.arrowColor;
      ctx.beginPath();
      tracePolyline(ctx, pts, true);
      ctx.fill();
    }
    const text = g.drawing.text;
    if (!text) return;
    const box = centeredTextBox(splitLines(text), s, 0, 0);
    const c = textCentre(a, b, box.w, box.h);
    renderCenteredText(rc, text, s, c.x, c.y);
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const text = g.drawing.text;
    if (text) {
      const box = centeredTextBox(splitLines(text), s, 0, 0);
      const c = textCentre(a, b, box.w, box.h);
      const hit = hitCenteredText(text, s, c.x, c.y, x, y);
      if (hit) return hit;
    }
    const pts = arrowMarkerPolygon(a, b);
    if (!pts) return null;
    return pointInPolygon(pts, x, y) || polylineDistance(pts, x, y, true) <= tol ? BODY_HIT : null;
  },

  isVisible(g) {
    return anchorsInView(g);
  },
});
