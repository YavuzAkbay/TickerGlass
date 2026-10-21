import { textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingLineStyle } from '../types';
import { fanInView, hitFan, renderFan } from './fan-common';
import { defaultGannFanLevels, gannFanRays, gannRatioText, positiveLevels } from './gann-common';

export const GANN_FAN_DEFAULTS = {
  /** Handle colour. */
  lineColor: '#A39E8F',
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  /** Slope multipliers of the 1x1 ray (anchor 1 -> anchor 2): 1x8 = 1/8 .. 8x1 = 8. */
  levels: defaultGannFanLevels(),
  showLabels: true,
  fontSize: 12,
  fillBackground: true,
  backgroundTransparency: 80,
};

const LABEL_GAP = 4;

/**
 * Gann fan: rays from anchor 1 with slopes v times the 1x1 slope of anchor 1
 * -> anchor 2 (1x8, 1x4, 1x3, 1x2, 1x1, 2x1, 3x1, 4x1, 8x1), to the pane
 * edge, bands filled, ratio labels where the rays leave the box anchor 1 -
 * anchor 2. Pixel space.
 */
export const gannFan = defineDrawingTool({
  type: 'gann-fan',
  name: 'Gann fan',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: GANN_FAN_DEFAULTS,
  properties: [
    { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Lines', inline: 'levelsLine' },
    { kind: 'lineStyle', key: 'levelsLineStyle', label: 'Style', inline: 'levelsLine' },
    { kind: 'levels', key: 'levels', label: 'Levels', group: 'Levels' },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    {
      kind: 'number',
      key: 'backgroundTransparency',
      label: 'Transparency',
      inline: 'bg',
      min: 0,
      max: 100,
      step: 1,
    },
    { kind: 'bool', key: 'showLabels', label: 'Labels', group: 'Labels' },
    { kind: 'fontSize', key: 'fontSize', label: 'Font size', group: 'Labels' },
  ],

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    const rays = gannFanRays(a, b, s.levels);
    renderFan(ctx, g, a, rays, s);
    if (!s.showLabels) return;
    ctx.font = textFont(theme, s.fontSize);
    const fans = positiveLevels(s.levels);
    const right = b.x >= a.x;
    const down = b.y >= a.y;
    for (let i = 0; i < fans.length; i++) {
      const r = rays[i]!;
      const v = fans[i]!.value;
      if (!Number.isFinite(r.tx) || !Number.isFinite(r.ty)) continue;
      ctx.fillStyle = r.color;
      // Past the box's far vertical edge (v <= 1) or far horizontal edge.
      if (v <= 1) {
        ctx.textAlign = right ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(gannRatioText(v), r.tx + (right ? LABEL_GAP : -LABEL_GAP), r.ty);
      } else {
        ctx.textAlign = 'center';
        ctx.textBaseline = down ? 'top' : 'bottom';
        ctx.fillText(gannRatioText(v), r.tx, r.ty + (down ? LABEL_GAP : -LABEL_GAP));
      }
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    return hitFan(g, a, gannFanRays(a, b, s.levels), s, x, y, tol);
  },

  isVisible(g, s) {
    const [a, b] = g.points;
    if (!a || !b) return false;
    return fanInView(g, a, gannFanRays(a, b, s.levels), s);
  },
});
