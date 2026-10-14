import {
  anchorsInView,
  approxTextWidth,
  BODY_HIT,
  extendSegment,
  lineDistance,
  segmentInView,
  setLineStyle,
  textFont,
  WEAK_BODY_HIT,
} from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { linearRegression, type LinearRegression } from '../shape-utils';
import type { DrawingGeometry, DrawingHandle, DrawingLineStyle } from '../types';

const LABEL_GAP = 4;

export const REGRESSION_TREND_DEFAULTS = {
  /** Base (regression) line; also the handle colour. */
  lineColor: '#f23645',
  lineWidth: 1,
  lineStyle: 'dashed' as DrawingLineStyle,
  showUpper: true,
  upperDeviation: 2,
  upperLineColor: '#2962ff',
  upperLineWidth: 1,
  upperLineStyle: 'solid' as DrawingLineStyle,
  showLower: true,
  lowerDeviation: -2,
  lowerLineColor: '#2962ff',
  lowerLineWidth: 1,
  lowerLineStyle: 'solid' as DrawingLineStyle,
  extendLeft: false,
  extendRight: false,
  showPearsonR: true,
  fillBackground: true,
  upperFillColor: 'rgba(41, 98, 255, 0.2)',
  lowerFillColor: 'rgba(242, 54, 69, 0.2)',
  fontSize: 12,
};

type RegressionStyle = typeof REGRESSION_TREND_DEFAULTS;

/** Regression channel in px: base/upper/lower segments [x0, y0, x1, y1] over the bar range. */
export interface RegressionChannel {
  fit: LinearRegression;
  /** First and last bar used (whole logical indices). */
  from: number;
  to: number;
  base: number[];
  upper: number[];
  lower: number[];
}

const channel: RegressionChannel = {
  fit: { slope: 0, intercept: 0, stdev: 0, r: NaN, n: 0 },
  from: 0,
  to: 0,
  base: [0, 0, 0, 0],
  upper: [0, 0, 0, 0],
  lower: [0, 0, 0, 0],
};

function lineAt(g: DrawingGeometry, out: number[], c: RegressionChannel, k: number): void {
  const { slope, intercept, stdev } = c.fit;
  out[0] = g.logicalToX(c.from);
  out[1] = g.priceToY(slope * c.from + intercept + k * stdev);
  out[2] = g.logicalToX(c.to);
  out[3] = g.priceToY(slope * c.to + intercept + k * stdev);
}

/**
 * Least-squares fit of the closes of the bars between the two anchors
 * (inclusive, clamped to the data) and its lines in px (reused object), or
 * null without two anchors or two bars.
 */
export function regressionChannel(
  g: DrawingGeometry,
  s: Pick<RegressionStyle, 'upperDeviation' | 'lowerDeviation'>,
): RegressionChannel | null {
  const [l0, l1] = g.logical;
  if (l0 === undefined || l1 === undefined || g.bars.length === 0) return null;
  if (!Number.isFinite(l0) || !Number.isFinite(l1)) return null;
  const fit = linearRegression(g.bars, Math.round(l0), Math.round(l1));
  if (!fit) return null;
  channel.fit = fit;
  channel.from = Math.max(0, Math.round(Math.min(l0, l1)));
  channel.to = Math.min(g.bars.length - 1, Math.round(Math.max(l0, l1)));
  lineAt(g, channel.base, channel, 0);
  lineAt(g, channel.upper, channel, s.upperDeviation);
  lineAt(g, channel.lower, channel, s.lowerDeviation);
  return channel;
}

const ext = [0, 0, 0, 0];
const ext2 = [0, 0, 0, 0];

function extended(g: DrawingGeometry, s: RegressionStyle, seg: number[], out: number[]) {
  return extendSegment(
    seg[0]!,
    seg[1]!,
    seg[2]!,
    seg[3]!,
    s.extendLeft,
    s.extendRight,
    g.width,
    g.height,
    out,
  );
}

function stroke(ctx: CanvasRenderingContext2D, seg: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(seg[0]!, seg[1]!);
  ctx.lineTo(seg[2]!, seg[3]!);
  ctx.stroke();
}

/** Fill between `a` and `b`, both extended alike (they share x at the ends). */
function fillBand(
  ctx: CanvasRenderingContext2D,
  g: DrawingGeometry,
  s: RegressionStyle,
  a: number[],
  b: number[],
) {
  extended(g, s, a, ext);
  extended(g, s, b, ext2);
  ctx.beginPath();
  ctx.moveTo(ext[0]!, ext[1]!);
  ctx.lineTo(ext[2]!, ext[3]!);
  ctx.lineTo(ext2[2]!, ext2[3]!);
  ctx.lineTo(ext2[0]!, ext2[1]!);
  ctx.closePath();
  ctx.fill();
}

/** Pearson's r label text (3 decimals), or '' when undefined (flat closes). */
export function pearsonText(r: number): string {
  return Number.isFinite(r) ? r.toFixed(3) : '';
}

/** Pearson label top-left: below the start of the lowest drawn line. */
function labelPos(c: RegressionChannel, s: RegressionStyle): { x: number; y: number } {
  const lines = [c.base];
  if (s.showUpper) lines.push(c.upper);
  if (s.showLower) lines.push(c.lower);
  let y = -Infinity;
  for (const l of lines) y = Math.max(y, l[1]!);
  return { x: c.base[0]!, y: y + LABEL_GAP };
}

/**
 * Linear regression of the closes between two anchor bars: base line, upper
 * and lower lines at k standard deviations (default ±2), fills and Pearson's r.
 * Anchors only set the bar range (their prices are ignored).
 */
export const regressionTrend = defineDrawingTool({
  type: 'regression-trend',
  name: 'Regression trend',
  group: 'lines',
  creation: { kind: 'points', count: 2 },
  axes: 'time',
  panes: 'main',
  defaults: REGRESSION_TREND_DEFAULTS,
  properties: [
    { kind: 'color', key: 'lineColor', label: 'Base', inline: 'base' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'base' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'base' },
    { kind: 'bool', key: 'showUpper', label: 'Upper', inline: 'up' },
    { kind: 'color', key: 'upperLineColor', label: 'Color', inline: 'up' },
    { kind: 'lineWidth', key: 'upperLineWidth', label: 'Width', inline: 'up' },
    { kind: 'lineStyle', key: 'upperLineStyle', label: 'Style', inline: 'up' },
    {
      kind: 'number',
      key: 'upperDeviation',
      label: 'Upper deviation',
      min: -10,
      max: 10,
      step: 0.1,
    },
    { kind: 'bool', key: 'showLower', label: 'Lower', inline: 'down' },
    { kind: 'color', key: 'lowerLineColor', label: 'Color', inline: 'down' },
    { kind: 'lineWidth', key: 'lowerLineWidth', label: 'Width', inline: 'down' },
    { kind: 'lineStyle', key: 'lowerLineStyle', label: 'Style', inline: 'down' },
    {
      kind: 'number',
      key: 'lowerDeviation',
      label: 'Lower deviation',
      min: -10,
      max: 10,
      step: 0.1,
    },
    { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
    { kind: 'color', key: 'upperFillColor', label: 'Upper', inline: 'bg' },
    { kind: 'color', key: 'lowerFillColor', label: 'Lower', inline: 'bg' },
    { kind: 'bool', key: 'extendLeft', label: 'Extend left', inline: 'extend' },
    { kind: 'bool', key: 'extendRight', label: 'Extend right', inline: 'extend' },
    { kind: 'bool', key: 'showPearsonR', label: "Pearson's R", inline: 'r' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', inline: 'r' },
  ],

  render({ ctx, theme }, g, s) {
    const c = regressionChannel(g, s);
    if (!c) return;
    if (s.fillBackground) {
      if (s.showUpper) {
        ctx.fillStyle = s.upperFillColor;
        fillBand(ctx, g, s, c.base, c.upper);
      }
      if (s.showLower) {
        ctx.fillStyle = s.lowerFillColor;
        fillBand(ctx, g, s, c.base, c.lower);
      }
    }
    if (s.showUpper) {
      setLineStyle(ctx, s.upperLineColor, s.upperLineWidth, s.upperLineStyle);
      stroke(ctx, extended(g, s, c.upper, ext));
    }
    if (s.showLower) {
      setLineStyle(ctx, s.lowerLineColor, s.lowerLineWidth, s.lowerLineStyle);
      stroke(ctx, extended(g, s, c.lower, ext));
    }
    setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
    stroke(ctx, extended(g, s, c.base, ext));
    const text = s.showPearsonR ? pearsonText(c.fit.r) : '';
    if (text) {
      const p = labelPos(c, s);
      ctx.font = textFont(theme, s.fontSize);
      ctx.fillStyle = s.lineColor;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(text, p.x, p.y);
    }
  },

  hitTest(g, s, x, y, tol) {
    const c = regressionChannel(g, s);
    if (!c) return null;
    const el = s.extendLeft;
    const er = s.extendRight;
    const near = (seg: number[], w: number) =>
      lineDistance(x, y, seg[0]!, seg[1]!, seg[2]!, seg[3]!, el, er) <= tol + w / 2;
    if (near(c.base, s.lineWidth)) return BODY_HIT;
    if (s.showUpper && near(c.upper, s.upperLineWidth)) return BODY_HIT;
    if (s.showLower && near(c.lower, s.lowerLineWidth)) return BODY_HIT;
    const text = s.showPearsonR ? pearsonText(c.fit.r) : '';
    if (text) {
      const p = labelPos(c, s);
      const w = approxTextWidth(text, s.fontSize);
      if (x >= p.x && x <= p.x + w && y >= p.y && y <= p.y + s.fontSize * 1.2) return BODY_HIT;
    }
    if (!s.fillBackground || (!s.showUpper && !s.showLower)) return null;
    // Between the outer drawn lines over the (extended) bar range.
    const x0 = c.base[0]!;
    const dx = c.base[2]! - x0;
    if (Math.abs(dx) < 1e-9) return null;
    const u = (x - x0) / dx;
    if ((u < 0 && !el) || (u > 1 && !er)) return null;
    const at = (seg: number[]) => seg[1]! + (seg[3]! - seg[1]!) * u;
    const ys = [at(c.base)];
    if (s.showUpper) ys.push(at(c.upper));
    if (s.showLower) ys.push(at(c.lower));
    return y >= Math.min(...ys) && y <= Math.max(...ys) ? WEAK_BODY_HIT : null;
  },

  /** On the base line at each anchor's bar (the anchors' prices are ignored). */
  handles(g, s) {
    const c = regressionChannel(g, s);
    const hs: DrawingHandle[] = [];
    for (let i = 0; i < Math.min(2, g.points.length); i++) {
      const p = g.points[i]!;
      const l = g.logical[i]!;
      hs.push(
        c ? { x: p.x, y: g.priceToY(c.fit.slope * Math.round(l) + c.fit.intercept) } : { ...p },
      );
    }
    return hs;
  },

  priceAxisLabels() {
    return [];
  },

  isVisible(g, s) {
    const c = regressionChannel(g, s);
    if (!c) return anchorsInView(g);
    const el = s.extendLeft;
    const er = s.extendRight;
    const inView = (seg: number[]) =>
      segmentInView(seg[0]!, seg[1]!, seg[2]!, seg[3]!, el, er, g.width, g.height);
    if (inView(c.base) || (s.showUpper && inView(c.upper)) || (s.showLower && inView(c.lower)))
      return true;
    // The band may cover the pane while every line is off screen.
    if (!s.fillBackground) return false;
    const dx = c.base[2]! - c.base[0]!;
    if (Math.abs(dx) < 1e-9) return false;
    const u = (g.width / 2 - c.base[0]!) / dx;
    if ((u < 0 && !el) || (u > 1 && !er)) return false;
    const at = (seg: number[]) => seg[1]! + (seg[3]! - seg[1]!) * u;
    const top = Math.min(at(c.upper), at(c.lower), at(c.base));
    const bottom = Math.max(at(c.upper), at(c.lower), at(c.base));
    return top <= g.height && bottom >= 0;
  },
});
