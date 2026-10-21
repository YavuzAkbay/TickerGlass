import { BODY_HIT, textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';

export const ICON_DEFAULTS = {
  glyph: '★',
  size: 32,
};

/** Glyph (emoji, sticker or icon character) centred on a single anchor. The toolbar
 * presets `style.glyph` per sticker via `setActiveTool('icon', { style })`. */
export const icon = defineDrawingTool({
  type: 'icon',
  name: 'Icon',
  group: 'annotation',
  creation: { kind: 'click' },
  defaults: ICON_DEFAULTS,
  properties: [
    { kind: 'string', key: 'glyph', label: 'Glyph', maxLength: 8 },
    { kind: 'number', key: 'size', label: 'Size', min: 8, max: 200, step: 1 },
  ],

  render({ ctx, theme }, g, s) {
    const p = g.points[0];
    if (!p || !s.glyph) return;
    ctx.font = textFont(theme, s.size);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.glyph, p.x, p.y);
  },

  hitTest(g, s, x, y, tol) {
    const p = g.points[0];
    if (!p) return null;
    const r = s.size / 2 + tol;
    return Math.abs(x - p.x) <= r && Math.abs(y - p.y) <= r ? BODY_HIT : null;
  },

  isVisible(g, s) {
    const p = g.points[0];
    if (!p) return false;
    const r = s.size / 2;
    return p.x + r >= 0 && p.x - r <= g.width && p.y + r >= 0 && p.y - r <= g.height;
  },
});
