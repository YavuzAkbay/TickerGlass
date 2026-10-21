import {
  anchorsInView,
  BODY_HIT,
  extendSegment,
  lineDistance,
  segmentInView,
  setLineStyle,
  textFont,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { pointInPolygon } from '../shape-utils';
import type { DrawingGeometry, PixelPoint } from '../types';
import {
  defaultFibLevels,
  FIB_COMMON_DEFAULTS,
  FIB_COMMON_PROPERTIES,
  fillAlpha,
  levelValueText,
  visibleLevels,
  type FibCommonStyle,
} from './fib-common';
import { channelOffsetPx } from './parallel-channel';

export const FIB_CHANNEL_DEFAULTS: FibCommonStyle = {
  ...FIB_COMMON_DEFAULTS,
  showPrices: false,
  levels: defaultFibLevels(),
};

/** Keys without meaning for a slanted channel (no trend line, no single price per level). */
const HIDDEN = new Set(['showTrendLine', 'lineColor', 'lineWidth', 'lineStyle', 'showPrices']);

const LABEL_GAP = 4;

/** Channel base (level 0) a-b and the per-level vertical pixel offset (level 1 through anchor 3). */
const ch = { ax: 0, ay: 0, bx: 0, by: 0, dy: 0 };

function channel(g: DrawingGeometry): typeof ch | null {
  const [a, b, c] = g.points;
  if (!a || !b || !c) return null;
  ch.ax = a.x;
  ch.ay = a.y;
  ch.bx = b.x;
  ch.by = b.y;
  ch.dy = channelOffsetPx(g, g.drawing.points);
  return [ch.ax, ch.ay, ch.bx, ch.by, ch.dy].every(Number.isFinite) ? ch : null;
}

/** Level line `v` (base shifted by v * dy), extended per the style, into `out`. */
function levelSeg(
  g: DrawingGeometry,
  s: FibCommonStyle,
  c: typeof ch,
  v: number,
  out: number[],
): number[] {
  const o = v * c.dy;
  // Extend towards the side of smaller / larger x regardless of the anchor order.
  const flip = c.bx < c.ax;
  const el = flip ? s.extendRight : s.extendLeft;
  const er = flip ? s.extendLeft : s.extendRight;
  return extendSegment(c.ax, c.ay + o, c.bx, c.by + o, el, er, g.width, g.height, out);
}

const segA = [0, 0, 0, 0];
const segB = [0, 0, 0, 0];
const quad: PixelPoint[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

function setQuad(a: readonly number[], b: readonly number[]): PixelPoint[] {
  quad[0]!.x = a[0]!;
  quad[0]!.y = a[1]!;
  quad[1]!.x = a[2]!;
  quad[1]!.y = a[3]!;
  quad[2]!.x = b[2]!;
  quad[2]!.y = b[3]!;
  quad[3]!.x = b[0]!;
  quad[3]!.y = b[1]!;
  return quad;
}

/**
 * Fib channel: the base line anchors 1-2 (level 0) and parallel lines at
 * level multiples of the channel width (level 1 through anchor 3). The width
 * is anchor 3's vertical pixel offset from the base line, like the parallel
 * channel, so the lines stay parallel on screen on every price scale.
 */
export const fibChannel = defineDrawingTool({
  type: 'fib-channel',
  name: 'Fib channel',
  group: 'fib',
  creation: { kind: 'points', count: 3 },
  defaults: FIB_CHANNEL_DEFAULTS,
  properties: FIB_COMMON_PROPERTIES.filter((p) => !HIDDEN.has(p.key)),

  render({ ctx, theme }, g, s) {
    const [a, b] = g.points;
    if (!a || !b) return;
    const c = channel(g);
    if (!c) {
      // Draft: the base line only.
      setLineStyle(ctx, s.lineColor, s.levelsLineWidth, s.levelsLineStyle);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      return;
    }
    const levels = visibleLevels(s);
    if (s.fillBackground && s.backgroundTransparency < 100) {
      ctx.globalAlpha = fillAlpha(s.backgroundTransparency);
      for (let i = 1; i < levels.length; i++) {
        levelSeg(g, s, c, levels[i - 1]!.value, segA);
        levelSeg(g, s, c, levels[i]!.value, segB);
        ctx.fillStyle = levels[i]!.color;
        ctx.beginPath();
        ctx.moveTo(segA[0]!, segA[1]!);
        ctx.lineTo(segA[2]!, segA[3]!);
        ctx.lineTo(segB[2]!, segB[3]!);
        ctx.lineTo(segB[0]!, segB[1]!);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    for (const lv of levels) {
      levelSeg(g, s, c, lv.value, segA);
      setLineStyle(ctx, lv.color, s.levelsLineWidth, s.levelsLineStyle);
      ctx.beginPath();
      ctx.moveTo(segA[0]!, segA[1]!);
      ctx.lineTo(segA[2]!, segA[3]!);
      ctx.stroke();
    }
    if (!s.showLevels) return;
    ctx.font = textFont(theme, s.fontSize);
    ctx.textBaseline =
      s.labelsVAlign === 'top' ? 'bottom' : s.labelsVAlign === 'bottom' ? 'top' : 'middle';
    ctx.textAlign =
      s.labelsPosition === 'left' ? 'right' : s.labelsPosition === 'right' ? 'left' : 'center';
    const dy = s.labelsVAlign === 'top' ? -2 : s.labelsVAlign === 'bottom' ? 2 : 0;
    for (const lv of levels) {
      levelSeg(g, s, c, lv.value, segA);
      // segA runs from the smaller-x end when the anchors do.
      const lx = segA[0]! <= segA[2]! ? 0 : 2;
      const rx = 2 - lx;
      let tx: number;
      let ty: number;
      if (s.labelsPosition === 'left') {
        tx = segA[lx]! - LABEL_GAP;
        ty = segA[lx + 1]!;
      } else if (s.labelsPosition === 'right') {
        tx = segA[rx]! + LABEL_GAP;
        ty = segA[rx + 1]!;
      } else {
        tx = (segA[0]! + segA[2]!) / 2;
        ty = (segA[1]! + segA[3]!) / 2;
      }
      ctx.fillStyle = lv.color;
      ctx.fillText(levelValueText(lv.value, s.levelsFormat), tx, ty + dy);
    }
  },

  hitTest(g, s, x, y, tol) {
    const [a, b] = g.points;
    if (!a || !b) return null;
    const t = tol + s.levelsLineWidth / 2;
    const c = channel(g);
    if (!c) return lineDistance(x, y, a.x, a.y, b.x, b.y) <= t ? BODY_HIT : null;
    const levels = visibleLevels(s);
    for (const lv of levels) {
      levelSeg(g, s, c, lv.value, segA);
      if (lineDistance(x, y, segA[0]!, segA[1]!, segA[2]!, segA[3]!) <= t) return BODY_HIT;
    }
    if (!s.fillBackground || levels.length < 2) return null;
    levelSeg(g, s, c, levels[0]!.value, segA);
    levelSeg(g, s, c, levels[levels.length - 1]!.value, segB);
    return pointInPolygon(setQuad(segA, segB), x, y) ? WEAK_BODY_HIT : null;
  },

  isVisible(g, s) {
    const c = channel(g);
    if (!c) return anchorsInView(g);
    const levels = visibleLevels(s);
    for (const lv of levels) {
      levelSeg(g, s, c, lv.value, segA);
      if (segmentInView(segA[0]!, segA[1]!, segA[2]!, segA[3]!, false, false, g.width, g.height))
        return true;
    }
    if (!s.fillBackground || levels.length < 2) return false;
    levelSeg(g, s, c, levels[0]!.value, segA);
    levelSeg(g, s, c, levels[levels.length - 1]!.value, segB);
    return pointInPolygon(setQuad(segA, segB), g.width / 2, g.height / 2);
  },
});
