import {
  BODY_HIT,
  inBox,
  lineDistance,
  setLineStyle,
  textFont,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingLineStyle } from '../types';
import { hitBoxGrid, renderBoxGrid } from './fan-common';
import { levelsOf, levelValueText, visibleLevels } from './fib-common';
import {
  boxCornerHandles,
  boxInView,
  defaultGannLevels,
  moveBoxCorner,
  renderBoxBands,
} from './gann-common';

export const GANN_BOX_DEFAULTS = {
  /** Angle (diagonal) lines; also the handle colour. */
  lineColor: '#787b86',
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  /** Price levels: horizontal lines at fractions of the box height (0 at anchor 1). */
  levels: defaultGannLevels(),
  /** Time levels: vertical lines at fractions of the box width (0 at anchor 1). */
  timeLevels: defaultGannLevels(),
  useOneColor: false,
  oneColor: '#2962ff',
  fillBackground: true,
  backgroundTransparency: 85,
  showAngles: false,
  anglesLineWidth: 1,
  anglesLineStyle: 'solid' as DrawingLineStyle,
  showLeftLabels: true,
  showRightLabels: true,
  showTopLabels: true,
  showBottomLabels: true,
  fontSize: 12,
};

const LABEL_GAP = 4;

/**
 * Gann box: the box anchor 1 - anchor 2 divided by price levels (horizontal)
 * and time levels (vertical), bands filled with level colours, optional
 * angle lines (both diagonals) and level labels on each side. Pixel space.
 * Handles: the anchors and the two other corners.
 */
export const gannBox = defineDrawingTool({
  type: 'gann-box',
  name: 'Gann box',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  shiftConstraint: 'none',
  defaults: GANN_BOX_DEFAULTS,
  properties: [
    { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Levels line', inline: 'levelsLine' },
    { kind: 'lineStyle', key: 'levelsLineStyle', label: 'Style', inline: 'levelsLine' },
    { kind: 'levels', key: 'levels', label: 'Price levels', group: 'Price levels' },
    { kind: 'levels', key: 'timeLevels', label: 'Time levels', group: 'Time levels' },
    { kind: 'bool', key: 'useOneColor', label: 'Use one color', inline: 'one' },
    { kind: 'color', key: 'oneColor', label: 'Color', inline: 'one' },
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
    { kind: 'bool', key: 'showAngles', label: 'Angles', inline: 'angles' },
    { kind: 'color', key: 'lineColor', label: 'Color', inline: 'angles' },
    { kind: 'lineWidth', key: 'anglesLineWidth', label: 'Width', inline: 'angles' },
    { kind: 'lineStyle', key: 'anglesLineStyle', label: 'Style', inline: 'angles' },
    { kind: 'bool', key: 'showLeftLabels', label: 'Left', group: 'Labels', inline: 'lr' },
    { kind: 'bool', key: 'showRightLabels', label: 'Right', group: 'Labels', inline: 'lr' },
    { kind: 'bool', key: 'showTopLabels', label: 'Top', group: 'Labels', inline: 'tb' },
    { kind: 'bool', key: 'showBottomLabels', label: 'Bottom', group: 'Labels', inline: 'tb' },
    { kind: 'fontSize', key: 'fontSize', label: 'Font size', group: 'Labels' },
  ],

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (!a || !b || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) return;
    const one = s.useOneColor ? s.oneColor : undefined;
    if (s.fillBackground)
      renderBoxBands(ctx, a, b, s.timeLevels, s.levels, s.backgroundTransparency, one);
    const price = levelsOf(s);
    const time = levelsOf({ levels: s.timeLevels });
    renderBoxGrid(ctx, a, b, time, price, s.levelsLineWidth, s.levelsLineStyle, one);
    if (s.showAngles) {
      setLineStyle(ctx, s.lineColor, s.anglesLineWidth, s.anglesLineStyle);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.moveTo(a.x, b.y);
      ctx.lineTo(b.x, a.y);
      ctx.stroke();
    }
    ctx.font = textFont(theme, s.fontSize);
    const l = Math.min(a.x, b.x);
    const r = Math.max(a.x, b.x);
    const t = Math.min(a.y, b.y);
    const bt = Math.max(a.y, b.y);
    if (s.showLeftLabels || s.showRightLabels) {
      ctx.textBaseline = 'middle';
      for (const lv of visibleLevels(s)) {
        const y = a.y + lv.value * (b.y - a.y);
        const txt = levelValueText(lv.value);
        ctx.fillStyle = one ?? lv.color;
        if (s.showLeftLabels) {
          ctx.textAlign = 'right';
          ctx.fillText(txt, l - LABEL_GAP, y);
        }
        if (s.showRightLabels) {
          ctx.textAlign = 'left';
          ctx.fillText(txt, r + LABEL_GAP, y);
        }
      }
    }
    if (s.showTopLabels || s.showBottomLabels) {
      ctx.textAlign = 'center';
      for (const lv of visibleLevels({ levels: s.timeLevels })) {
        const x = a.x + lv.value * (b.x - a.x);
        const txt = levelValueText(lv.value);
        ctx.fillStyle = one ?? lv.color;
        if (s.showTopLabels) {
          ctx.textBaseline = 'bottom';
          ctx.fillText(txt, x, t - LABEL_GAP);
        }
        if (s.showBottomLabels) {
          ctx.textBaseline = 'top';
          ctx.fillText(txt, x, bt + LABEL_GAP);
        }
      }
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b || ![a.x, a.y, b.x, b.y].every(Number.isFinite)) return null;
    const time = levelsOf({ levels: s.timeLevels });
    if (hitBoxGrid(a, b, time, levelsOf(s), s.levelsLineWidth, x, y, tol)) return BODY_HIT;
    if (s.showAngles) {
      const t = tol + s.anglesLineWidth / 2;
      if (
        lineDistance(x, y, a.x, a.y, b.x, b.y) <= t ||
        lineDistance(x, y, a.x, b.y, b.x, a.y) <= t
      )
        return BODY_HIT;
    }
    return s.fillBackground && inBox(x, y, a.x, a.y, b.x, b.y) ? WEAK_BODY_HIT : null;
  },

  handles(g) {
    const [a, b] = g.points;
    return a && b ? boxCornerHandles(a, b) : [];
  },

  moveHandle({ start, handle, target }) {
    return moveBoxCorner(start, handle, target);
  },

  isVisible(g) {
    const [a, b] = g.points;
    return !!a && !!b && boxInView(a, b, g.width, g.height);
  },
});
