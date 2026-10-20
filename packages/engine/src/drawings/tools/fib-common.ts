// Shared level rendering/hit testing for the fib tools: price levels
// (retracement, extension, channel), time levels (time zone, trend-based
// time) and concentric arcs (circles, speed arcs, wedge; pixel space).
import type { ChartTheme } from '../../options';
import { BODY_HIT, setLineStyle, textFont, WEAK_BODY_HIT } from '../draw-utils';
import { arcDistance } from '../shape-utils';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingLevel,
  DrawingLineStyle,
  DrawingProperty,
} from '../types';

const LABEL_GAP = 4;

/** default fib levels: [value, colour, visible]. */
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

/** Fresh copy of the default levels (sorted by value). */
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

/** Level value text: "0.618" / "61.8%". */
export function levelValueText(value: number, format: 'values' | 'percents' = 'values'): string {
  return format === 'percents' ? `${+(value * 100).toFixed(2)}%` : String(value);
}

/** Level label: "0.618(123.45)" / "61.8%(123.45)". */
function levelLabel(g: DrawingGeometry, s: FibCommonStyle, value: number, price: number): string {
  const lv = s.showLevels ? levelValueText(value, s.levelsFormat) : '';
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

/** Opacity of a fill from `backgroundTransparency` (0 = opaque .. 100 = invisible). */
export function fillAlpha(transparency: number): number {
  return Math.max(0, Math.min(1, 1 - transparency / 100));
}

const sorted: DrawingLevel[] = [];

/** Visible, finite levels sorted ascending (shared buffer: do not keep). */
export function visibleLevels(s: { levels: unknown }): readonly DrawingLevel[] {
  sorted.length = 0;
  for (const lv of levelsOf(s)) if (lv.visible && Number.isFinite(lv.value)) sorted.push(lv);
  sorted.sort((a, b) => a.value - b.value);
  return sorted;
}

// ------------------------------------------------------------ time levels

/** Fibonacci numbers for the fib time zone (defaults). */
const TV_TIME_ZONE_LEVELS: readonly (readonly [number, string, boolean])[] = [
  [0, '#787b86', true],
  [1, '#2962ff', true],
  [2, '#2962ff', true],
  [3, '#2962ff', true],
  [5, '#2962ff', true],
  [8, '#2962ff', true],
  [13, '#2962ff', true],
  [21, '#2962ff', true],
  [34, '#2962ff', true],
  [55, '#2962ff', true],
  [89, '#2962ff', true],
];

/** Fresh copy of the fib time zone levels (Fibonacci sequence 0..89). */
export function defaultTimeZoneLevels(): DrawingLevel[] {
  return TV_TIME_ZONE_LEVELS.map(([value, color, visible]) => ({ value, color, visible }));
}

const TV_TREND_TIME_LEVELS: readonly (readonly [number, string, boolean])[] = [
  [0, '#787b86', true],
  [0.382, '#f23645', true],
  [0.5, '#81c784', false],
  [0.618, '#4caf50', true],
  [1, '#089981', true],
  [1.382, '#00bcd4', true],
  [1.618, '#2962ff', true],
  [2, '#9c27b0', true],
  [2.382, '#e91e63', true],
  [2.618, '#f23645', true],
  [3, '#ff9800', false],
  [4.236, '#787b86', false],
];

/** Fresh copy of the trend-based fib time levels. */
export function defaultTrendTimeLevels(): DrawingLevel[] {
  return TV_TREND_TIME_LEVELS.map(([value, color, visible]) => ({ value, color, visible }));
}

/** Style keys of the time-level fib tools (vertical, full-height level lines). */
export const FIB_TIME_DEFAULTS = {
  /** Trend line; also the handle colour. */
  lineColor: '#787b86',
  lineWidth: 1,
  lineStyle: 'dashed' as DrawingLineStyle,
  showTrendLine: true,
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  showLabels: true,
  labelsPosition: 'right' as 'left' | 'center' | 'right',
  labelsVAlign: 'bottom' as 'top' | 'middle' | 'bottom',
  fontSize: 12,
  fillBackground: false,
  backgroundTransparency: 80,
};

export type FibTimeStyle = typeof FIB_TIME_DEFAULTS & { levels: DrawingLevel[] };

export const FIB_TIME_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'bool', key: 'showTrendLine', label: 'Trend line', inline: 'trend' },
  { kind: 'color', key: 'lineColor', label: 'Color', inline: 'trend' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'trend' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'trend' },
  { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Levels line', inline: 'levelsLine' },
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
  {
    kind: 'enum',
    key: 'labelsPosition',
    label: 'Horizontal',
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

/** Pixel x of time level `value`: logical `base + delta * value`. */
export function timeLevelX(g: DrawingGeometry, base: number, delta: number, value: number): number {
  return g.logicalToX(base + delta * value);
}

/**
 * Draw full-height vertical level lines at logical `base + delta * level`
 * (fractional bars: future levels are placed on the extrapolated timeline),
 * optional fills between consecutive visible levels (outer level's colour)
 * and level labels.
 */
export function renderTimeLevels(
  ctx: CanvasRenderingContext2D,
  theme: ChartTheme,
  g: DrawingGeometry,
  s: FibTimeStyle,
  base: number,
  delta: number,
): void {
  const levels = visibleLevels(s);
  const H = g.height;
  const W = g.width;
  if (s.fillBackground && s.backgroundTransparency < 100) {
    ctx.globalAlpha = fillAlpha(s.backgroundTransparency);
    let prev = NaN;
    for (const lv of levels) {
      const x = timeLevelX(g, base, delta, lv.value);
      if (prev === prev && x === x && Math.max(prev, x) >= 0 && Math.min(prev, x) <= W) {
        ctx.fillStyle = lv.color;
        ctx.fillRect(Math.min(prev, x), 0, Math.abs(x - prev), H);
      }
      prev = x;
    }
    ctx.globalAlpha = 1;
  }
  for (const lv of levels) {
    const x = timeLevelX(g, base, delta, lv.value);
    if (!(x >= -20 && x <= W + 20)) continue;
    setLineStyle(ctx, lv.color, s.levelsLineWidth, s.levelsLineStyle);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  if (!s.showLabels) return;
  ctx.font = textFont(theme, s.fontSize);
  ctx.textAlign =
    s.labelsPosition === 'left' ? 'right' : s.labelsPosition === 'right' ? 'left' : 'center';
  ctx.textBaseline =
    s.labelsVAlign === 'top' ? 'top' : s.labelsVAlign === 'bottom' ? 'bottom' : 'middle';
  const dx =
    s.labelsPosition === 'left' ? -LABEL_GAP : s.labelsPosition === 'right' ? LABEL_GAP : 0;
  const ty =
    s.labelsVAlign === 'top' ? LABEL_GAP : s.labelsVAlign === 'bottom' ? H - LABEL_GAP : H / 2;
  for (const lv of levels) {
    const x = timeLevelX(g, base, delta, lv.value);
    if (!(x >= -20 && x <= W + 20)) continue;
    ctx.fillStyle = lv.color;
    ctx.fillText(levelValueText(lv.value), x + dx, ty);
  }
}

/** Level lines are strong hits; between the outer visible levels is weak when filled. */
export function hitTimeLevels(
  g: DrawingGeometry,
  s: FibTimeStyle,
  base: number,
  delta: number,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  if (y < -tol || y > g.height + tol) return null;
  const t = tol + s.levelsLineWidth / 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (const lv of visibleLevels(s)) {
    const lx = timeLevelX(g, base, delta, lv.value);
    if (Math.abs(x - lx) <= t) return BODY_HIT;
    if (lx < lo) lo = lx;
    if (lx > hi) hi = lx;
  }
  return s.fillBackground && x >= lo && x <= hi ? WEAK_BODY_HIT : null;
}

/** Culling: a level line (or the fill between the outer levels) overlaps the pane. */
export function timeLevelsInView(
  g: DrawingGeometry,
  s: FibTimeStyle,
  base: number,
  delta: number,
  margin = 50,
): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (const lv of visibleLevels(s)) {
    const lx = timeLevelX(g, base, delta, lv.value);
    if (lx >= -margin && lx <= g.width + margin) return true;
    if (lx < lo) lo = lx;
    if (lx > hi) hi = lx;
  }
  return s.fillBackground && lo < 0 && hi > g.width;
}

// ------------------------------------------------------------ arc levels (pixel space)

/** default fib circle / speed arc / wedge levels. */
const TV_ARC_LEVELS: readonly (readonly [number, string, boolean])[] = [
  [0.236, '#f23645', true],
  [0.382, '#ff9800', true],
  [0.5, '#4caf50', true],
  [0.618, '#089981', true],
  [0.786, '#00bcd4', true],
  [1, '#787b86', true],
  [1.618, '#2962ff', true],
  [2.618, '#f23645', true],
  [3.618, '#9c27b0', true],
  [4.236, '#e91e63', true],
];

/** Fresh copy of the arc levels; `upTo`: levels above it are hidden. */
export function defaultArcLevels(upTo = Infinity): DrawingLevel[] {
  return TV_ARC_LEVELS.map(([value, color, visible]) => ({
    value,
    color,
    visible: visible && value <= upTo,
  }));
}

/** Style keys of the arc-level fib tools (circles, speed arcs, wedge). */
export const FIB_ARC_DEFAULTS = {
  lineColor: '#787b86',
  lineWidth: 1,
  lineStyle: 'dashed' as DrawingLineStyle,
  showTrendLine: true,
  levelsLineWidth: 1,
  levelsLineStyle: 'solid' as DrawingLineStyle,
  showLabels: true,
  fontSize: 12,
  fillBackground: true,
  backgroundTransparency: 80,
};

export type FibArcStyle = typeof FIB_ARC_DEFAULTS & { levels: DrawingLevel[] };

export const FIB_ARC_PROPERTIES: readonly DrawingProperty[] = [
  { kind: 'bool', key: 'showTrendLine', label: 'Trend line', inline: 'trend' },
  { kind: 'color', key: 'lineColor', label: 'Color', inline: 'trend' },
  { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'trend' },
  { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'trend' },
  { kind: 'lineWidth', key: 'levelsLineWidth', label: 'Levels line', inline: 'levelsLine' },
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
];

/**
 * Concentric arcs around (cx, cy) with radius `unit * level` (pixels), from
 * angle `start` to `end` like `ctx.arc` (`full`: whole circles). Labels sit
 * on each arc at `labelAngle`.
 */
export interface ArcLevelsSpec {
  cx: number;
  cy: number;
  unit: number;
  start: number;
  end: number;
  anticlockwise: boolean;
  full: boolean;
  labelAngle: number;
}

function traceArc(ctx: CanvasRenderingContext2D, a: ArcLevelsSpec, r: number, back: boolean) {
  if (a.full) {
    ctx.moveTo(a.cx + r, a.cy);
    ctx.arc(a.cx, a.cy, r, 0, Math.PI * 2, back);
  } else if (back) ctx.arc(a.cx, a.cy, r, a.end, a.start, !a.anticlockwise);
  else ctx.arc(a.cx, a.cy, r, a.start, a.end, a.anticlockwise);
}

/** Draw the arcs, ring/sector fills between consecutive visible levels, and labels. */
export function renderArcLevels(
  ctx: CanvasRenderingContext2D,
  theme: ChartTheme,
  s: FibArcStyle,
  a: ArcLevelsSpec,
): void {
  if (!(a.unit > 0) || ![a.cx, a.cy].every(Number.isFinite)) return;
  const levels = visibleLevels(s);
  if (s.fillBackground && s.backgroundTransparency < 100) {
    ctx.globalAlpha = fillAlpha(s.backgroundTransparency);
    let prev = NaN;
    for (const lv of levels) {
      const r = Math.abs(lv.value) * a.unit;
      if (prev === prev && r > prev) {
        ctx.fillStyle = lv.color;
        ctx.beginPath();
        traceArc(ctx, a, r, false);
        traceArc(ctx, a, prev, true);
        ctx.closePath();
        ctx.fill();
      }
      prev = r;
    }
    ctx.globalAlpha = 1;
  }
  for (const lv of levels) {
    const r = Math.abs(lv.value) * a.unit;
    if (r <= 0) continue;
    setLineStyle(ctx, lv.color, s.levelsLineWidth, s.levelsLineStyle);
    ctx.beginPath();
    traceArc(ctx, a, r, false);
    ctx.stroke();
  }
  if (!s.showLabels) return;
  ctx.font = textFont(theme, s.fontSize);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const c = Math.cos(a.labelAngle);
  const sn = Math.sin(a.labelAngle);
  for (const lv of levels) {
    const r = Math.abs(lv.value) * a.unit;
    if (r <= 0) continue;
    ctx.fillStyle = lv.color;
    // Just outside the arc, along the label direction.
    const rr = r + s.fontSize / 2 + 2;
    ctx.fillText(levelValueText(lv.value), a.cx + c * rr, a.cy + sn * rr);
  }
}

/** Normalised angle in [0, 2π). */
function norm(t: number): number {
  const m = t % (2 * Math.PI);
  return m < 0 ? m + 2 * Math.PI : m;
}

/** Whether angle `t` lies on the arc `start` -> `end` (ctx.arc convention). */
export function angleOnArc(t: number, start: number, end: number, anticlockwise: boolean): boolean {
  const sweep = anticlockwise ? norm(start - end) : norm(end - start);
  const along = anticlockwise ? norm(start - t) : norm(t - start);
  return along <= sweep + 1e-9;
}

/** Arcs are strong hits; the band between the inner and outer visible arcs is weak when filled. */
export function hitArcLevels(
  s: FibArcStyle,
  a: ArcLevelsSpec,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  if (!(a.unit > 0)) return null;
  const t = tol + s.levelsLineWidth / 2;
  let lo = Infinity;
  let hi = -Infinity;
  for (const lv of visibleLevels(s)) {
    const r = Math.abs(lv.value) * a.unit;
    if (r <= 0) continue;
    const d = a.full
      ? Math.abs(Math.hypot(x - a.cx, y - a.cy) - r)
      : arcDistance(a.cx, a.cy, r, a.start, a.end, x, y, a.anticlockwise);
    if (d <= t) return BODY_HIT;
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  if (!s.fillBackground || lo >= hi) return null;
  const d = Math.hypot(x - a.cx, y - a.cy);
  if (d < lo || d > hi) return null;
  const on = a.full || angleOnArc(Math.atan2(y - a.cy, x - a.cx), a.start, a.end, a.anticlockwise);
  return on ? WEAK_BODY_HIT : null;
}

/** Largest visible arc radius (px), 0 without levels. */
export function maxArcRadius(s: FibArcStyle, unit: number): number {
  let m = 0;
  for (const lv of visibleLevels(s)) m = Math.max(m, Math.abs(lv.value) * unit);
  return m;
}

/** Culling: the outer circle's bounding box overlaps the pane (conservative). */
export function arcLevelsInView(
  g: DrawingGeometry,
  s: FibArcStyle,
  a: ArcLevelsSpec,
  margin = 50,
): boolean {
  const r = maxArcRadius(s, a.unit);
  return (
    a.cx + r >= -margin &&
    a.cx - r <= g.width + margin &&
    a.cy + r >= -margin &&
    a.cy - r <= g.height + margin
  );
}
