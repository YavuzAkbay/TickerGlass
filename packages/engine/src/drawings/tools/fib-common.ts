// Shared level rendering/hit testing for the fib tools (retracement, trend-based extension).
import type { ChartTheme } from '../../options';
import { BODY_HIT, setLineStyle, textFont, WEAK_BODY_HIT } from '../draw-utils';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingLevel,
  DrawingLineStyle,
  DrawingProperty,
} from '../types';

const LABEL_GAP = 4;

/** reference default fib levels: [value, colour, visible]. */
const TV_LEVELS: readonly (readonly [number, string, boolean])[] = [
  [0, '#787b86', true],
  [0.236, '#f23645', true],
  [0.382, '#ff9800', true],
  [0.5, '#4caf50', true],
  [0.618, '#089981', true],
  [0.786, '#00bcd4', true],
  [1, '#787b86', true],
  [1.272, '#ff9800', false],
  [1.414, '#f23645', false],
  [1.618, '#2962ff', true],
  [2, '#089981', false],
  [2.272, '#ff9800', false],
  [2.414, '#4caf50', false],
  [2.618, '#f23645', true],
  [3, '#00bcd4', false],
  [3.618, '#9c27b0', true],
  [4, '#787b86', false],
  [4.236, '#e91e63', true],
  [4.618, '#ff9800', false],
];

/** Fresh copy of the reference default levels (sorted by value). */
export function defaultFibLevels(): DrawingLevel[] {
  return TV_LEVELS.map(([value, color, visible]) => ({ value, color, visible }));
}

/** Style keys shared by the fib tools. */
export const FIB_COMMON_DEFAULTS = {
  /** Trend (diagonal) line; also the handle colour. */
  lineColor: '#787b86',
  lineWidth: 1,
  lineStyle: 'dashed' as DrawingLineStyle,
  showTrendLine: true,
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  extendLeft: false,
  extendRight: false,
  showLevels: true,
  showPrices: true,
  levelsFormat: 'values' as 'values' | 'percents',
  labelsPosition: 'left' as 'left' | 'center' | 'right',
  labelsVAlign: 'middle' as 'top' | 'middle' | 'bottom',
  fontSize: 12,
  fillBackground: true,
  /** 0 = opaque, 100 = invisible. */
  backgroundTransparency: 80,
};

export type FibCommonStyle = typeof FIB_COMMON_DEFAULTS & { levels: DrawingLevel[] };

export const FIB_COMMON_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'bool', key: 'showTrendLine', label: 'Trend line', inline: 'trend' },
  { kind: 'color', key: 'lineColor', label: 'Color', inline: 'trend' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'trend' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'trend' },
  { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Levels line', inline: 'levelsLine' },
  { kind: 'lineStyle', key: 'levelsLineStyle', label: 'Style', inline: 'levelsLine' },
  { kind: 'levels', key: 'levels', label: 'Levels', group: 'Levels' },
  { kind: 'bool', key: 'extendLeft', label: 'Extend left', inline: 'extend' },
  { kind: 'bool', key: 'extendRight', label: 'Extend right', inline: 'extend' },
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
  { kind: 'bool', key: 'showPrices', label: 'Prices', group: 'Labels' },
  { kind: 'bool', key: 'showLevels', label: 'Levels', group: 'Labels', inline: 'lv' },
  {
    kind: 'enum',
    key: 'levelsFormat',
    label: 'Format',
    group: 'Labels',
    inline: 'lv',
    options: ['values', 'percents'],
    labels: ['Values', 'Percents'],
  },
  {
    kind: 'enum',
    key: 'labelsPosition',
    label: 'Labels',
    group: 'Labels',
    inline: 'pos',
    options: ['left', 'center', 'right'],
    labels: ['Left', 'Center', 'Right'],
  },
  {
    kind: 'enum',
    key: 'labelsVAlign',
    label: 'Vertical',
    group: 'Labels',
    inline: 'pos',
    options: ['top', 'middle', 'bottom'],
    labels: ['Top', 'Middle', 'Bottom'],
  },
  { kind: 'fontSize', key: 'fontSize', label: 'Font size', group: 'Labels' },
];

/** Levels array of a style (tolerates malformed persisted values). */
export function levelsOf(s: { levels: unknown }): readonly DrawingLevel[] {
  return Array.isArray(s.levels) ? (s.levels as DrawingLevel[]) : [];
}

/** Level price for a fib defined by `from`/`to` prices: level 0 at `to`, 1 at `from`. */
export function fibRetracementPrice(
  from: number,
  to: number,
  level: number,
  reverse = false,
): number {
  return reverse ? from + (to - from) * level : to + (from - to) * level;
}

/** Trend-based extension: projects the move a->b from c. */
export function fibExtensionPrice(a: number, b: number, c: number, level: number): number {
  return c + (b - a) * level;
}

/** Horizontal span of the levels in px (extended to the pane edges). */
const span = { l: 0, r: 0 };

function setSpan(x0: number, x1: number, s: FibCommonStyle, width: number): void {
  span.l = s.extendLeft ? 0 : Math.min(x0, x1);
  span.r = s.extendRight ? width : Math.max(x0, x1);
}

/** Level label: "0.618(123.45)" / "61.8%(123.45)". */
function levelLabel(g: DrawingGeometry, s: FibCommonStyle, value: number, price: number): string {
  const lv = s.showLevels
    ? s.levelsFormat === 'percents'
      ? `${+(value * 100).toFixed(2)}%`
      : String(value)
    : '';
  if (!s.showPrices) return lv;
  return lv ? `${lv}(${g.format.price(price)})` : g.format.price(price);
}

/**
 * Draw the levels between x0 and x1; a level's price is `base + delta * level`
 * (linear for both fib tools, so no per-frame closure).
 * Backgrounds fill between consecutive visible levels with the upper level's colour.
 */
export function renderFibLevels(
  ctx: CanvasRenderingContext2D,
  theme: ChartTheme,
  g: DrawingGeometry,
  s: FibCommonStyle,
  x0: number,
  x1: number,
  base: number,
  delta: number,
): void {
  const levels = levelsOf(s);
  setSpan(x0, x1, s, g.width);
  const { l, r } = span;
  if (s.fillBackground && s.backgroundTransparency < 100) {
    ctx.globalAlpha = Math.max(0, Math.min(1, 1 - s.backgroundTransparency / 100));
    let prevY = NaN;
    for (const lv of levels) {
      if (!lv.visible) continue;
      const y = g.priceToY(base + delta * lv.value);
      if (prevY === prevY && y === y) {
        ctx.fillStyle = lv.color;
        ctx.fillRect(l, Math.min(prevY, y), r - l, Math.abs(y - prevY));
      }
      prevY = y;
    }
    ctx.globalAlpha = 1;
  }
  for (const lv of levels) {
    if (!lv.visible) continue;
    const y = g.priceToY(base + delta * lv.value);
    if (y < -20 || y > g.height + 20) continue;
    setLineStyle(ctx, lv.color, s.levelsLineWidth, s.levelsLineStyle);
    ctx.beginPath();
    ctx.moveTo(l, y);
    ctx.lineTo(r, y);
    ctx.stroke();
  }
  if (!s.showLevels && !s.showPrices) return;
  ctx.font = textFont(theme, s.fontSize);
  ctx.textBaseline =
    s.labelsVAlign === 'top' ? 'bottom' : s.labelsVAlign === 'bottom' ? 'top' : 'middle';
  // Left: outside the span (right-aligned before it); right: after it; center: centred above.
  ctx.textAlign =
    s.labelsPosition === 'left' ? 'right' : s.labelsPosition === 'right' ? 'left' : 'center';
  const tx =
    s.labelsPosition === 'left'
      ? l - LABEL_GAP
      : s.labelsPosition === 'right'
        ? r + LABEL_GAP
        : (l + r) / 2;
  const dy = s.labelsVAlign === 'top' ? -2 : s.labelsVAlign === 'bottom' ? 2 : 0;
  for (const lv of levels) {
    if (!lv.visible) continue;
    const price = base + delta * lv.value;
    const y = g.priceToY(price);
    if (y < -20 || y > g.height + 20) continue;
    ctx.fillStyle = lv.color;
    ctx.fillText(levelLabel(g, s, lv.value, price), tx, y + dy);
  }
}

/** Level lines are strong hits; the area between the outer visible levels is weak. */
export function hitFibLevels(
  g: DrawingGeometry,
  s: FibCommonStyle,
  x0: number,
  x1: number,
  base: number,
  delta: number,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  setSpan(x0, x1, s, g.width);
  if (x < span.l - tol || x > span.r + tol) return null;
  const t = tol + s.levelsLineWidth / 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (const lv of levelsOf(s)) {
    if (!lv.visible) continue;
    const ly = g.priceToY(base + delta * lv.value);
    if (Math.abs(y - ly) <= t) return BODY_HIT;
    if (ly < lo) lo = ly;
    if (ly > hi) hi = ly;
  }
  return s.fillBackground && y >= lo && y <= hi ? WEAK_BODY_HIT : null;
}
