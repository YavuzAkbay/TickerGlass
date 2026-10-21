import type { OhlcvSource } from '../chart-types';
import type { ChartTheme } from '../options';
import type { PriceScale } from '../scale/price-scale';
import type { TimeScale } from '../scale/time-scale';
import { formatStudyValue } from './format';
import { paletteColor, plotBase, type Study } from './study';
import { drawVolumeProfile } from './volume-profile';
import {
  STUDY_COLOR_NONE,
  type StudyBgColorMeta,
  type StudyFillMeta,
  type StudyHLineMeta,
  type StudyLineStyle,
  type StudyPlotMeta,
  type StudyShapeMeta,
  type StudyShapeSize,
} from './types';

/** Where a study sits in its pane (drawing and hit testing). */
export interface StudyGeometry {
  /** Pane size in CSS px. */
  width: number;
  height: number;
  timeScale: TimeScale;
  /** Only `priceToY` is used, so callers may pass a rescaled view (compare overlays). */
  priceScale: Pick<PriceScale, 'priceToY'>;
  theme: ChartTheme;
  /** Displayed bars (shape anchors at high/low). */
  bars: OhlcvSource;
  /** Readable data indices: min(study length, displayed bars). */
  limit: number;
  /** Symbol price decimals for `inherit` formats (additive; default 2). */
  symbolDecimals?: number;
  /** Drawn positions (logical bar indices, may lie past the last bar). */
  pFrom: number;
  pTo: number;
}

/** Everything a study draw needs. `ctx` uses device pixels (identity transform). */
export interface StudyDrawContext extends StudyGeometry {
  ctx: CanvasRenderingContext2D;
  dpr: number;
}

/** Fill opacity of area plots. */
export const AREA_ALPHA = 0.2;

export const SHAPE_SIZES: Record<StudyShapeSize, number> = {
  tiny: 6,
  small: 9,
  normal: 13,
  large: 19,
  huge: 27,
};

/** Positions to draw for the visible width: one extra slot each side so lines leave the edge. */
export function drawSpan(ts: TimeScale, width: number): { pFrom: number; pTo: number } {
  return {
    pFrom: Math.floor(ts.xToLogical(0)) - 1,
    pTo: Math.ceil(ts.xToLogical(width)) + 1,
  };
}

/** Data index range [j0, j1] for positions [pFrom, pTo] of an output shifted by `offset`. */
export function dataRange(
  pFrom: number,
  pTo: number,
  offset: number,
  limit: number,
): [number, number] {
  return [Math.max(0, pFrom - offset), Math.min(limit - 1, pTo - offset)];
}

export function lineDash(style: StudyLineStyle, widthDev: number): number[] {
  const w = Math.max(1, widthDev);
  switch (style) {
    case 'dashed':
      return [w * 4, w * 3];
    case 'dotted':
      return [w, w * 2];
    default:
      return [];
  }
}

/** Draw all visible outputs of a study in array order. */
export function drawStudy(dc: StudyDrawContext, study: Study): void {
  const ctx = dc.ctx;
  ctx.save();
  for (const o of study.spec.outputs) {
    if (!o.visible) continue;
    switch (o.type) {
      case 'plot':
        drawPlot(dc, study, o);
        break;
      case 'hline':
        drawHLine(dc, o);
        break;
      case 'fill':
        drawFill(dc, study, o);
        break;
      case 'bgcolor':
        drawBgColor(dc, study, o);
        break;
      case 'shape':
        drawShapes(dc, study, o);
        break;
      case 'volumeProfile':
        drawVolumeProfile(dc, study, o);
        break;
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------- plots

function drawPlot(dc: StudyDrawContext, study: Study, o: StudyPlotMeta): void {
  const vals = study.values[o.id];
  if (!vals) return;
  const idx = study.colors[o.id];
  switch (o.kind) {
    case 'line':
    case 'step':
      strokeLine(dc, vals, idx, o, o.kind === 'step');
      break;
    case 'area': {
      const baseY = o.base === null ? dc.height : dc.priceScale.priceToY(o.base);
      fillBand(
        dc,
        { vals, off: o.offset, value: NaN, yCss: null },
        { vals: null, off: 0, value: NaN, yCss: baseY },
        o.colors,
        idx,
        o.offset,
        AREA_ALPHA,
      );
      strokeLine(dc, vals, idx, o, false);
      break;
    }
    case 'histogram':
    case 'columns':
      drawBars(dc, vals, idx, o);
      break;
    case 'circles':
    case 'cross':
      drawMarks(dc, vals, idx, o);
      break;
  }
}

/** Polyline (or steps) with NaN gaps (joined over with connectGaps); per-bar colours colour the segment ending at that bar. */
function strokeLine(
  dc: StudyDrawContext,
  vals: Float64Array,
  idx: Uint8Array | undefined,
  o: StudyPlotMeta,
  step: boolean,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = dc;
  const [j0, j1] = dataRange(dc.pFrom, dc.pTo, o.offset, dc.limit);
  if (j0 > j1) return;
  const w = Math.max(1, o.lineWidth) * dpr;
  ctx.lineWidth = w;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.setLineDash(lineDash(o.lineStyle, w));
  const multi = idx !== undefined;
  const connect = o.connectGaps === true;
  let cur = '';
  let pending = false;
  let have = false;
  let px = 0;
  let py = 0;
  ctx.beginPath();
  for (let j = j0; j <= j1; j++) {
    const v = vals[j]!;
    if (v !== v) {
      // connectGaps: the line joins the values either side of the gap.
      if (!connect) have = false;
      continue;
    }
    const x = ts.indexToX(j + o.offset) * dpr;
    const y = ps.priceToY(v) * dpr;
    const color = multi ? paletteColor(o.colors, idx, j) : (o.colors[0] ?? '');
    if (color === '') {
      // "No colour": the segment ending at this bar is not drawn.
      ctx.moveTo(x, y);
      have = true;
      px = x;
      py = y;
      continue;
    }
    if (color !== cur) {
      if (pending) ctx.stroke();
      ctx.strokeStyle = color;
      ctx.beginPath();
      pending = false;
      cur = color;
      if (have) ctx.moveTo(px, py);
    }
    if (!have) ctx.moveTo(x, y);
    else if (step) {
      ctx.lineTo(x, py);
      ctx.lineTo(x, y);
      pending = true;
    } else {
      ctx.lineTo(x, y);
      pending = true;
    }
    have = true;
    px = x;
    py = y;
  }
  if (pending) ctx.stroke();
  ctx.setLineDash([]);
}

function drawBars(
  dc: StudyDrawContext,
  vals: Float64Array,
  idx: Uint8Array | undefined,
  o: StudyPlotMeta,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = dc;
  const [j0, j1] = dataRange(dc.pFrom, dc.pTo, o.offset, dc.limit);
  if (j0 > j1) return;
  const spacing = ts.barSpacing * dpr;
  let w: number;
  if (o.kind === 'histogram') w = Math.max(1, Math.round(o.lineWidth * dpr));
  else {
    w = Math.max(1, Math.floor(spacing * 0.8));
    if (w > 2 && w % 2 === 0) w -= 1;
  }
  w = Math.min(w, Math.max(1, Math.floor(spacing)));
  const half = w >> 1;
  const baseY = Math.round(ps.priceToY(plotBase(o)) * dpr);
  const passes = paletteSize(idx, o.colors);
  for (let k = 0; k < passes; k++) {
    ctx.fillStyle = o.colors[k] ?? '';
    for (let j = j0; j <= j1; j++) {
      const v = vals[j]!;
      if (v !== v) continue;
      if (idx && colorIndex(idx, j, passes) !== k) continue;
      const x = Math.round(ts.indexToX(j + o.offset) * dpr);
      const y = Math.round(ps.priceToY(v) * dpr);
      const top = Math.min(y, baseY);
      ctx.fillRect(x - half, top, w, Math.max(1, Math.abs(baseY - y)));
    }
  }
}

function drawMarks(
  dc: StudyDrawContext,
  vals: Float64Array,
  idx: Uint8Array | undefined,
  o: StudyPlotMeta,
): void {
  const { ctx, dpr, timeScale: ts, priceScale: ps } = dc;
  const [j0, j1] = dataRange(dc.pFrom, dc.pTo, o.offset, dc.limit);
  if (j0 > j1) return;
  const lw = Math.max(1, o.lineWidth);
  const circles = o.kind === 'circles';
  const r = (circles ? lw + 1 : lw + 2) * dpr;
  ctx.lineWidth = Math.max(1, Math.round(dpr * Math.min(2, lw)));
  ctx.setLineDash([]);
  const passes = paletteSize(idx, o.colors);
  for (let k = 0; k < passes; k++) {
    const color = o.colors[k] ?? '';
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    let any = false;
    for (let j = j0; j <= j1; j++) {
      const v = vals[j]!;
      if (v !== v) continue;
      if (idx && colorIndex(idx, j, passes) !== k) continue;
      const x = ts.indexToX(j + o.offset) * dpr;
      const y = ps.priceToY(v) * dpr;
      if (circles) {
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      } else {
        ctx.moveTo(x - r, y);
        ctx.lineTo(x + r, y);
        ctx.moveTo(x, y - r);
        ctx.lineTo(x, y + r);
      }
      any = true;
    }
    if (!any) continue;
    if (circles) ctx.fill();
    else ctx.stroke();
  }
}

/** Palette index of bar j; -1 for STUDY_COLOR_NONE, other out-of-range indices fall back to 0. */
function colorIndex(idx: Uint8Array | undefined, j: number, size: number): number {
  const k = idx?.[j] ?? 0;
  if (k === STUDY_COLOR_NONE) return -1;
  return k < size ? k : 0;
}

/** Colour passes: one per palette entry when per-bar indices exist. */
function paletteSize(idx: Uint8Array | undefined, colors: readonly string[]): number {
  return idx ? Math.max(1, colors.length) : 1;
}

// ------------------------------------------------------------------- hlines

function drawHLine(dc: StudyDrawContext, o: StudyHLineMeta): void {
  if (!Number.isFinite(o.value)) return;
  const { ctx, dpr } = dc;
  const w = Math.max(1, Math.round(o.lineWidth * dpr));
  const y = Math.round(dc.priceScale.priceToY(o.value) * dpr) + (w % 2 ? 0.5 : 0);
  ctx.lineWidth = w;
  ctx.strokeStyle = o.color;
  ctx.setLineDash(lineDash(o.lineStyle, w));
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(dc.width * dpr, y);
  ctx.stroke();
  ctx.setLineDash([]);
}

// ------------------------------------------------------------------- fills

/** One edge of a band: a plot (values + offset), a constant price, or a fixed y. */
export interface BandSide {
  vals: Float64Array | null;
  off: number;
  value: number;
  /** Fixed y in CSS px (area base at the pane bottom). */
  yCss: number | null;
}

function sideY(dc: StudyDrawContext, s: BandSide, p: number): number {
  if (s.vals) {
    const j = p - s.off;
    if (j < 0 || j >= dc.limit) return NaN;
    const v = s.vals[j]!;
    return v === v ? dc.priceScale.priceToY(v) : NaN;
  }
  if (s.yCss !== null) return s.yCss;
  return Number.isFinite(s.value) ? dc.priceScale.priceToY(s.value) : NaN;
}

/**
 * Fill between two sides, segment by segment (bar p-1 to p) where both sides
 * are defined at both ends. Segment colour = palette entry of bar
 * p - colorOffset. One path per palette entry.
 */
export function fillBand(
  dc: StudyDrawContext,
  a: BandSide,
  b: BandSide,
  colors: readonly string[],
  idx: Uint8Array | undefined,
  colorOffset: number,
  alpha = 1,
): void {
  const { ctx, dpr } = dc;
  if (!a.vals && !b.vals) {
    // Two constants: one rectangle across the pane.
    const ya = sideY(dc, a, 0);
    const yb = sideY(dc, b, 0);
    if (ya !== ya || yb !== yb) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colors[0] ?? '';
    ctx.fillRect(0, Math.min(ya, yb) * dpr, dc.width * dpr, Math.abs(yb - ya) * dpr);
    ctx.globalAlpha = 1;
    return;
  }
  const ts = dc.timeScale;
  const passes = paletteSize(idx, colors);
  ctx.globalAlpha = alpha;
  for (let k = 0; k < passes; k++) {
    ctx.fillStyle = colors[k] ?? '';
    ctx.beginPath();
    let any = false;
    let pa = sideY(dc, a, dc.pFrom);
    let pb = sideY(dc, b, dc.pFrom);
    let px = ts.indexToX(dc.pFrom) * dpr;
    for (let p = dc.pFrom + 1; p <= dc.pTo; p++) {
      const ya = sideY(dc, a, p);
      const yb = sideY(dc, b, p);
      const x = ts.indexToX(p) * dpr;
      if (
        ya === ya &&
        yb === yb &&
        pa === pa &&
        pb === pb &&
        (!idx || colorIndex(idx, p - colorOffset, passes) === k)
      ) {
        ctx.moveTo(px, pa * dpr);
        ctx.lineTo(x, ya * dpr);
        ctx.lineTo(x, yb * dpr);
        ctx.lineTo(px, pb * dpr);
        ctx.closePath();
        any = true;
      }
      pa = ya;
      pb = yb;
      px = x;
    }
    if (any) ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function bandSide(study: Study, id: string): BandSide | null {
  const o = study.output(id);
  if (!o) return null;
  if (o.type === 'hline') return { vals: null, off: 0, value: o.value, yCss: null };
  if (o.type === 'plot') {
    const vals = study.values[id];
    return vals ? { vals, off: o.offset, value: NaN, yCss: null } : null;
  }
  return null;
}

function drawFill(dc: StudyDrawContext, study: Study, o: StudyFillMeta): void {
  const a = bandSide(study, o.between[0]);
  const b = bandSide(study, o.between[1]);
  if (!a || !b) return;
  // Colours follow the (shifted) plot so offset clouds keep their colours.
  const colorOffset = a.vals ? a.off : b.off;
  fillBand(dc, a, b, o.colors, study.colors[o.id], colorOffset);
}

// ------------------------------------------------------------------- bgcolor

function drawBgColor(dc: StudyDrawContext, study: Study, o: StudyBgColorMeta): void {
  const vals = study.values[o.id];
  if (!vals) return;
  const { ctx, dpr, timeScale: ts } = dc;
  const off = o.offset ?? 0;
  const [j0, j1] = dataRange(dc.pFrom, dc.pTo, off, dc.limit);
  if (j0 > j1) return;
  const idx = study.colors[o.id];
  const passes = paletteSize(idx, o.colors);
  const half = ts.barSpacing / 2;
  const h = Math.round(dc.height * dpr);
  for (let k = 0; k < passes; k++) {
    ctx.fillStyle = o.colors[k] ?? '';
    let run = -1;
    for (let j = j0; j <= j1 + 1; j++) {
      const on = j <= j1 && vals[j]! === vals[j]! && (!idx || colorIndex(idx, j, passes) === k);
      if (on && run < 0) run = j;
      else if (!on && run >= 0) {
        const x0 = Math.round((ts.indexToX(run + off) - half) * dpr);
        const x1 = Math.round((ts.indexToX(j - 1 + off) + half) * dpr);
        ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
        run = -1;
      }
    }
  }
}

// ------------------------------------------------------------------- shapes

/**
 * Vertical centre (CSS px) of a shape of size s drawn at position (displayed
 * bar) j, or NaN. aboveBar/belowBar need a displayed bar at j.
 */
export function shapeCenterY(
  dc: StudyGeometry,
  o: StudyShapeMeta,
  j: number,
  v: number,
  s: number,
): number {
  const gap = 4;
  const ps = dc.priceScale;
  switch (o.location) {
    case 'aboveBar': {
      if (j < 0 || j >= dc.bars.length) return NaN;
      const hi = dc.bars.high[j];
      return hi === undefined ? NaN : ps.priceToY(hi) - gap - s / 2;
    }
    case 'belowBar': {
      if (j < 0 || j >= dc.bars.length) return NaN;
      const lo = dc.bars.low[j];
      return lo === undefined ? NaN : ps.priceToY(lo) + gap + s / 2;
    }
    case 'absolute':
      return ps.priceToY(v);
    case 'top':
      return gap + s / 2;
    case 'bottom':
      return dc.height - gap - s / 2;
  }
}

/** Shapes point up when placed below the bar (or for up kinds). */
function pointsUp(o: StudyShapeMeta): boolean {
  if (o.shape === 'triangleUp' || o.shape === 'arrowUp' || o.shape === 'labelUp') return true;
  if (o.shape === 'triangleDown' || o.shape === 'arrowDown' || o.shape === 'labelDown')
    return false;
  return o.location === 'belowBar' || o.location === 'bottom';
}

function drawShapes(dc: StudyDrawContext, study: Study, o: StudyShapeMeta): void {
  const vals = study.values[o.id];
  if (!vals) return;
  const { ctx, dpr, timeScale: ts } = dc;
  const off = o.offset ?? 0;
  const [j0, j1] = dataRange(dc.pFrom, dc.pTo, off, dc.limit);
  if (j0 > j1) return;
  const idx = study.colors[o.id];
  const s = SHAPE_SIZES[o.size];
  const up = pointsUp(o);
  const label = o.shape === 'labelUp' || o.shape === 'labelDown';
  const fontPx = Math.max(9, Math.round(s * 0.8 + 3));
  const { format, precision } = study.spec;
  const decimals = dc.symbolDecimals ?? 2;
  ctx.font = `${Math.round(fontPx * dpr)}px ${dc.theme.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.setLineDash([]);
  for (let j = j0; j <= j1; j++) {
    const v = vals[j]!;
    if (v !== v) continue;
    const color = paletteColor(o.colors, idx, j);
    if (color === '') continue;
    const cy = shapeCenterY(dc, o, j + off, v, s);
    if (cy !== cy) continue;
    const x = ts.indexToX(j + off) * dpr;
    const text = o.textFromValue ? formatStudyValue(v, format, precision, decimals) : o.text;
    if (label) {
      drawLabel(ctx, x, cy * dpr, up, text, color, o.textColor, s * dpr, fontPx * dpr);
      continue;
    }
    shapePath(ctx, o.shape, x, cy * dpr, s * dpr, color, dpr);
    if (text) {
      ctx.fillStyle = o.textColor || color;
      ctx.textBaseline = up ? 'top' : 'bottom';
      const ty = up ? (cy + s / 2 + 2) * dpr : (cy - s / 2 - 2) * dpr;
      ctx.fillText(text, x, ty);
    }
  }
}

function shapePath(
  ctx: CanvasRenderingContext2D,
  shape: StudyShapeMeta['shape'],
  x: number,
  y: number,
  s: number,
  color: string,
  dpr: number,
): void {
  const h = s / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  switch (shape) {
    case 'triangleUp':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      break;
    case 'triangleDown':
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x - h, y - h);
      break;
    case 'arrowUp':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x + h / 3, y);
      ctx.lineTo(x + h / 3, y + h);
      ctx.lineTo(x - h / 3, y + h);
      ctx.lineTo(x - h / 3, y);
      ctx.lineTo(x - h, y);
      break;
    case 'arrowDown':
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x + h / 3, y);
      ctx.lineTo(x + h / 3, y - h);
      ctx.lineTo(x - h / 3, y - h);
      ctx.lineTo(x - h / 3, y);
      ctx.lineTo(x - h, y);
      break;
    case 'circle':
      ctx.moveTo(x + h, y);
      ctx.arc(x, y, h, 0, Math.PI * 2);
      break;
    case 'diamond':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h, y);
      break;
    case 'square':
      ctx.rect(x - h, y - h, s, s);
      break;
    case 'flag':
      ctx.rect(x - h, y - h, Math.max(1, dpr), s);
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y - h / 2);
      ctx.lineTo(x - h, y);
      break;
    case 'cross':
    case 'xcross': {
      ctx.lineWidth = Math.max(1, Math.round(s / 6));
      if (shape === 'cross') {
        ctx.moveTo(x - h, y);
        ctx.lineTo(x + h, y);
        ctx.moveTo(x, y - h);
        ctx.lineTo(x, y + h);
      } else {
        ctx.moveTo(x - h, y - h);
        ctx.lineTo(x + h, y + h);
        ctx.moveTo(x + h, y - h);
        ctx.lineTo(x - h, y + h);
      }
      ctx.stroke();
      return;
    }
    default:
      return;
  }
  ctx.closePath();
  ctx.fill();
}

/** Label bubble with a pointer towards the bar (labelUp points up). Device px. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  cy: number,
  up: boolean,
  text: string,
  color: string,
  textColor: string,
  s: number,
  fontPx: number,
): void {
  const tw = text ? ctx.measureText(text).width : 0;
  const w = Math.max(s, tw + fontPx);
  const bh = Math.max(s, fontPx * 1.5);
  const tip = s / 3;
  // cy is the anchor-side centre: the tip touches the anchor gap, the box hangs away from the bar.
  const tipY = up ? cy - s / 2 : cy + s / 2;
  const boxTop = up ? tipY + tip : tipY - tip - bh;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.rect(x - w / 2, boxTop, w, bh);
  ctx.moveTo(x - tip, up ? boxTop : boxTop + bh);
  ctx.lineTo(x, tipY);
  ctx.lineTo(x + tip, up ? boxTop : boxTop + bh);
  ctx.closePath();
  ctx.fill();
  if (text) {
    ctx.fillStyle = textColor || '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, boxTop + bh / 2);
  }
}
