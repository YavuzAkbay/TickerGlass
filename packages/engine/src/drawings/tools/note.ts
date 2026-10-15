import { BODY_HIT, setLineStyle } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingCoords } from '../types';
import {
  ANNOTATION_PLACEHOLDER,
  ANNOTATION_PROPERTIES,
  annotationDefaults,
  bubbleBounds,
  hitBox,
  rectInView,
  renderBubble,
  textBlock,
  WRAP_PROPERTY,
  type Rect,
} from './annotation-common';

export const NOTE_DEFAULTS = {
  ...annotationDefaults('#131722', 'rgba(255, 235, 150, 0.95)'),
  borderColor: '#f5a623',
  pinColor: '#f5a623',
  wrapWidth: 200,
};

type NoteStyle = typeof NOTE_DEFAULTS;

const HEAD_R = 8;
const HEAD_RISE = 16;
const TIP_GAP = 10;

/** Pin hit/cull rectangle (tip at the anchor, head above). */
function pinRect(x: number, y: number): Rect {
  return { x: x - HEAD_R, y: y - HEAD_RISE - HEAD_R, w: HEAD_R * 2, h: HEAD_RISE + HEAD_R };
}

/** Tooltip box right of the pin head and the pointer tip at the head. */
function tooltip(x: number, y: number, s: NoteStyle, text: string) {
  const block = textBlock(text, s, s.wrapWidth);
  const box: Rect = {
    x: x + HEAD_R + TIP_GAP,
    y: y - HEAD_RISE - block.h / 2,
    w: block.w,
    h: block.h,
  };
  return { block, box, tip: { x: x + HEAD_R, y: y - HEAD_RISE } };
}

function makeNote(type: string, name: string, coords: DrawingCoords) {
  return defineDrawingTool({
    type,
    name,
    group: 'annotation',
    creation: { kind: 'click' },
    coords,
    defaults: NOTE_DEFAULTS,
    text: { default: '', multiline: true },
    properties: [
      { kind: 'color', key: 'pinColor', label: 'Pin' },
      ...ANNOTATION_PROPERTIES,
      WRAP_PROPERTY,
    ],

    render(rc, g, s, state) {
      const p = g.points[0];
      if (!p) return;
      const { ctx } = rc;
      // Teardrop pin: tip at the anchor, round head above.
      ctx.beginPath();
      ctx.arc(p.x, p.y - HEAD_RISE, HEAD_R, Math.PI * 0.8, Math.PI * 0.2);
      ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.fillStyle = s.pinColor;
      ctx.fill();
      setLineStyle(ctx, '#ffffff', 1, 'solid');
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y - HEAD_RISE, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      // The text shows as a tooltip on hover (or while selected / being edited).
      if (g.drawing.text && (state.hovered || state.selected || state.editing)) {
        const t = tooltip(p.x, p.y, s, g.drawing.text);
        renderBubble(rc, t.box, t.tip, t.block, s);
      }
    },

    hitTest(g, _s, x, y, tol) {
      const p = g.points[0];
      return p && hitBox(pinRect(p.x, p.y), x, y, tol) ? BODY_HIT : null;
    },

    isVisible(g, s) {
      const p = g.points[0];
      if (!p) return false;
      const t = tooltip(p.x, p.y, s, g.drawing.text || ANNOTATION_PLACEHOLDER);
      const pin = pinRect(p.x, p.y);
      return rectInView(g, pin) || rectInView(g, bubbleBounds(t.box, t.tip));
    },
  });
}

/** Pin marker at the anchor; the note text is a tooltip shown on hover. */
export const note = makeNote('note', 'Note', 'chart');
/** Same as `note`, pinned to the pane. */
export const anchoredNote = makeNote('anchored-note', 'Anchored note', 'pane');
