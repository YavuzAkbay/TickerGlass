import { BODY_HIT, segmentInView, textFont } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import type { DrawingGeometry, DrawingLevel, DrawingLineStyle } from '../types';
import { levelsOf, levelValueText } from './fib-common';
import {
  fanInView,
  fanRayBuffer,
  hitBoxGrid,
  hitFan,
  renderBoxGrid,
  renderFan,
  type FanRay,
} from './fan-common';

/** reference default speed resistance fan levels (shared by price and time). */
const TV_LEVELS: readonly (readonly [number, string])[] = [
  [0, '#787b86'],
  [0.25, '#f23645'],
  [0.382, '#ff9800'],
  [0.5, '#4caf50'],
  [0.618, '#089981'],
  [0.75, '#00bcd4'],
  [1, '#787b86'],
];

/** Fresh copy of the reference speed fan levels. */
export function defaultSpeedFanLevels(): DrawingLevel[] {
  return TV_LEVELS.map(([value, color]) => ({ value, color, visible: true }));
}

export const FIB_SPEED_FAN_DEFAULTS = {
  /** Handle colour. */
  lineColor: '#787b86',
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  /** Price levels: rays through the box's far vertical edge. */
  levels: defaultSpeedFanLevels(),
  /** Time levels: rays through the box's far horizontal edge. */
  timeLevels: defaultSpeedFanLevels(),
  showGrid: true,
  gridColor: 'rgba(120, 123, 134, 0.5)',
  gridLineWidth: 1,
  gridLineStyle: 'solid' as DrawingLineStyle,
  showLabels: true,
  fontSize: 12,
  fillBackground: true,
  backgroundTransparency: 80,
};

type SpeedFanStyle = typeof FIB_SPEED_FAN_DEFAULTS;

const LABEL_GAP = 4;

/**
 * Fan rays of the box anchor 1 (origin) - anchor 2: price level v through
 * (b.x, a.y + v * (b.y - a.y)), ascending (from the horizontal towards the
 * diagonal); then time level v through (a.x + v * (b.x - a.x), b.y),
 * descending (from the diagonal towards the vertical). Bands are filled
 * with the larger level's colour; no band joins the two families.
 */
export function speedFanRays(g: DrawingGeometry, s: SpeedFanStyle): readonly FanRay[] {
  const [a, b] = g.points;
  const price = sortedVisible(levelsOf(s), priceBuf);
  const time = sortedVisible(levelsOf({ levels: s.timeLevels }), timeBuf);
  if (!a || !b) return fanRayBuffer(0);
  const rays = fanRayBuffer(price.length + time.length);
  let i = 0;
  for (const lv of price) {
    const r = rays[i]!;
    r.tx = b.x;
    r.ty = a.y + lv.value * (b.y - a.y);
    r.color = lv.color;
    r.fill = i > 0 ? lv.color : '';
    i++;
  }
  for (let k = time.length - 1; k >= 0; k--) {
    const lv = time[k]!;
    const r = rays[i]!;
    r.tx = a.x + lv.value * (b.x - a.x);
    r.ty = b.y;
    r.color = lv.color;
    r.fill = k < time.length - 1 ? time[k + 1]!.color : '';
    i++;
  }
  return rays;
}

const priceBuf: DrawingLevel[] = [];
const timeBuf: DrawingLevel[] = [];

function sortedVisible(levels: readonly DrawingLevel[], out: DrawingLevel[]): DrawingLevel[] {
  out.length = 0;
  for (const lv of levels) if (lv.visible && Number.isFinite(lv.value)) out.push(lv);
  out.sort((x, y) => x.value - y.value);
  return out;
}

/**
 * Fib speed resistance fan: rays from anchor 1 through the price and time
 * levels of the box anchor 1 - anchor 2, with the level grid inside the box.
 * Pixel space: levels divide the box on screen.
 */
export const fibSpeedFan = defineDrawingTool({
  type: 'fib-speed-fan',
  name: 'Fib speed resistance fan',
  group: 'fib',
  creation: { kind: 'points', count: 2 },
  defaults: FIB_SPEED_FAN_DEFAULTS,
  properties: [
    { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Levels line', inline: 'levelsLine' },
    { kind: 'lineStyle', key: 'levelsLineStyle', label: 'Style', inline: 'levelsLine' },
    { kind: 'levels', key: 'levels', label: 'Price levels', group: 'Price levels' },
    { kind: 'levels', key: 'timeLevels', label: 'Time levels', group: 'Time levels' },
    { kind: 'bool', key: 'showGrid', label: 'Grid', inline: 'grid' },
    { kind: 'color', key: 'gridColor', label: 'Color', inline: 'grid' },
    { kind: 'lineWidth', key: 'gridLineWidth', label: 'Width', inline: 'grid' },
    { kind: 'lineStyle', key: 'gridLineStyle', label: 'Style', inline: 'grid' },
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
    const time = levelsOf({ levels: s.timeLevels });
    if (s.showGrid)
      renderBoxGrid(ctx, a, b, time, levelsOf(s), s.gridLineWidth, s.gridLineStyle, s.gridColor);
    renderFan(ctx, g, a, speedFanRays(g, s), s);
    if (!s.showLabels) return;
    ctx.font = textFont(theme, s.fontSize);
    // Price labels past the box's far vertical edge, time labels past its far horizontal edge.
    const right = b.x >= a.x;
    const down = b.y >= a.y;
    ctx.textAlign = right ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    for (const lv of sortedVisible(levelsOf(s), priceBuf)) {
      ctx.fillStyle = lv.color;
      ctx.fillText(
        levelValueText(lv.value),
        b.x + (right ? LABEL_GAP : -LABEL_GAP),
        a.y + lv.value * (b.y - a.y),
      );
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = down ? 'top' : 'bottom';
    for (const lv of sortedVisible(time, timeBuf)) {
      ctx.fillStyle = lv.color;
      ctx.fillText(
        levelValueText(lv.value),
        a.x + lv.value * (b.x - a.x),
        b.y + (down ? LABEL_GAP : -LABEL_GAP),
      );
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    if (
      s.showGrid &&
      hitBoxGrid(a, b, levelsOf({ levels: s.timeLevels }), levelsOf(s), s.gridLineWidth, x, y, tol)
    )
      return BODY_HIT;
    return hitFan(g, a, speedFanRays(g, s), s, x, y, tol);
  },

  isVisible(g, s) {
    const [a, b] = g.points;
    if (!a || !b) return false;
    if (s.showGrid && segmentInView(a.x, a.y, b.x, b.y, false, false, g.width, g.height))
      return true;
    return fanInView(g, a, speedFanRays(g, s), s);
  },
});
