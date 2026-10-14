// Shared by the chart-pattern and Elliott wave tools: a labelled zigzag through
// fixed anchors, standard dashed ratio connectors, weak fills and
// Elliott wave-degree labels.
import { BODY_HIT, setLineStyle, textFont, WEAK_BODY_HIT } from '../draw-utils';
import { defineDrawingTool } from '../registry';
import { pointInPolygon, polylineDistance, strokePolyline, tracePolyline } from '../shape-utils';
import { segmentDistance } from '../../studies/hit';
import type {
  DrawingGeometry,
  DrawingHitPart,
  DrawingLineStyle,
  DrawingProperty,
  PixelPoint,
} from '../types';

/** Gap between a point and its label, px. */
const LABEL_GAP = 6;

export type PatternStyle = {
  lineColor: string;
  lineWidth: number;
  lineStyle: DrawingLineStyle;
  showLabels: boolean;
  textColor: string;
  fontSize: number;
  showRatios: boolean;
  ratioColor: string;
  necklineColor: string;
  fillBackground: boolean;
  fillColor: string;
  /** Elliott wave degree (ignored by chart patterns). */
  degree: string;
};

/** A dashed connector `from` -> `to` (anchor indices) labelled |num| / |den| (price legs). */
export interface PatternRatio {
  from: number;
  to: number;
  num: readonly [number, number];
  den: readonly [number, number];
}

export interface PatternSpec {
  /** Label per anchor ('' = none), may depend on the style (Elliott degree). */
  labels(s: PatternStyle): readonly string[];
  ratios?: readonly PatternRatio[];
  /** Polygons (anchor indices) filled weakly. */
  fills?: readonly (readonly number[])[];
  /** Extra solid segments between anchors (triangle pattern). */
  lines?: readonly (readonly [number, number])[];
  neckline?: readonly [number, number];
}

export const PATTERN_DEFAULTS: PatternStyle = {
  lineColor: '#2962ff',
  lineWidth: 2,
  lineStyle: 'solid',
  showLabels: true,
  textColor: '#2962ff',
  fontSize: 12,
  showRatios: true,
  ratioColor: '#787b86',
  necklineColor: '#ff9800',
  fillBackground: true,
  fillColor: 'rgba(41, 98, 255, 0.15)',
  degree: 'minor',
};

// ------------------------------------------------------------------ Elliott degrees

interface Degree {
  label: string;
  open: string;
  close: string;
  /** 'arabic' | 'roman' | 'circled' numerals. */
  numerals: 'arabic' | 'roman' | 'circled';
  lower: boolean;
}

/** Wave degrees by convention (largest first). */
export const ELLIOTT_DEGREES: Readonly<Record<string, Degree>> = {
  'grand-supercycle': {
    label: 'Grand Supercycle',
    open: '((',
    close: '))',
    numerals: 'roman',
    lower: false,
  },
  supercycle: { label: 'Supercycle', open: '(', close: ')', numerals: 'roman', lower: false },
  cycle: { label: 'Cycle', open: '', close: '', numerals: 'roman', lower: false },
  primary: { label: 'Primary', open: '', close: '', numerals: 'circled', lower: false },
  intermediate: { label: 'Intermediate', open: '(', close: ')', numerals: 'arabic', lower: false },
  minor: { label: 'Minor', open: '', close: '', numerals: 'arabic', lower: false },
  minute: { label: 'Minute', open: '[', close: ']', numerals: 'roman', lower: true },
  minuette: { label: 'Minuette', open: '(', close: ')', numerals: 'roman', lower: true },
  subminuette: { label: 'Subminuette', open: '', close: '', numerals: 'roman', lower: true },
};

export const ELLIOTT_DEGREE_KEYS = Object.keys(ELLIOTT_DEGREES);
export const ELLIOTT_DEGREE_LABELS = ELLIOTT_DEGREE_KEYS.map((k) => ELLIOTT_DEGREES[k]!.label);

const ROMAN = ['0', 'i', 'ii', 'iii', 'iv', 'v'];
const CIRCLED = ['⓪', '①', '②', '③', '④', '⑤'];

/** Label of wave id '0'..'5' (numeral) or a letter (A-E, W, X, Y, Z) at `degree`. */
export function elliottLabel(degree: string, id: string): string {
  const d = ELLIOTT_DEGREES[degree] ?? ELLIOTT_DEGREES.minor!;
  const n = Number(id);
  if (id === '0') return d.numerals === 'circled' ? CIRCLED[0]! : '0';
  if (Number.isInteger(n) && n >= 1 && n <= 5) {
    if (d.numerals === 'circled') return CIRCLED[n]!;
    const base = d.numerals === 'roman' ? ROMAN[n]! : String(n);
    const text = d.numerals === 'roman' && !d.lower ? base.toUpperCase() : base;
    return `${d.open}${text}${d.close}`;
  }
  if (d.numerals === 'circled') {
    const code = id.toUpperCase().charCodeAt(0) - 65;
    return code >= 0 && code < 26 ? String.fromCodePoint(0x24b6 + code) : id;
  }
  const letter = d.lower ? id.toLowerCase() : id.toUpperCase();
  return `${d.open}${letter}${d.close}`;
}

/** Labels for a wave id sequence at the style's degree. */
export function elliottLabels(s: PatternStyle, ids: readonly string[]): string[] {
  return ids.map((id) => elliottLabel(s.degree, id));
}

// ------------------------------------------------------------------ math

/**
 * True when anchor `i` is a local high on screen versus its neighbours (label
 * goes above); false for a local low or a point on a slope (label below).
 * Ties count as high. A lone anchor is above.
 */
export function labelAbove(pts: readonly PixelPoint[], i: number): boolean {
  const y = pts[i]!.y;
  const prev = i > 0 ? pts[i - 1]!.y : undefined;
  const next = i + 1 < pts.length ? pts[i + 1]!.y : undefined;
  if (prev === undefined && next === undefined) return true;
  // The y axis points down: smaller y = higher.
  return (prev === undefined || y <= prev) && (next === undefined || y <= next);
}

/** |price[num0] - price[num1]| / |price[den0] - price[den1]|; NaN when a leg is missing or flat. */
export function ratioValue(prices: readonly number[], r: PatternRatio): number {
  const a = prices[r.num[0]];
  const b = prices[r.num[1]];
  const c = prices[r.den[0]];
  const d = prices[r.den[1]];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return NaN;
  const den = Math.abs(d - c);
  return den > 0 ? Math.abs(b - a) / den : NaN;
}

/** Ratio label text (3 decimals), '' when undefined. */
export function ratioText(v: number): string {
  return Number.isFinite(v) ? v.toFixed(3) : '';
}

function ratioReady(r: PatternRatio, n: number): boolean {
  return Math.max(r.from, r.to, ...r.num, ...r.den) < n;
}

function polygon(g: DrawingGeometry, idx: readonly number[]): PixelPoint[] | null {
  const out: PixelPoint[] = [];
  for (const i of idx) {
    const p = g.points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    out.push(p);
  }
  return out;
}

function ratioLabelPos(g: DrawingGeometry, r: PatternRatio): PixelPoint | null {
  const a = g.points[r.from];
  const b = g.points[r.to];
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function ratioLines(
  g: DrawingGeometry,
  spec: PatternSpec,
  s: PatternStyle,
): { a: PixelPoint; b: PixelPoint; text: string; mid: PixelPoint }[] {
  const out: { a: PixelPoint; b: PixelPoint; text: string; mid: PixelPoint }[] = [];
  if (!s.showRatios || !spec.ratios) return out;
  const n = g.points.length;
  const prices = g.drawing.points.map((p) => p.price);
  for (const r of spec.ratios) {
    if (!ratioReady(r, n)) continue;
    const a = g.points[r.from]!;
    const b = g.points[r.to]!;
    const mid = ratioLabelPos(g, r)!;
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) continue;
    out.push({ a, b, mid, text: ratioText(ratioValue(prices, r)) });
  }
  return out;
}

// ------------------------------------------------------------------ render / hit

export function renderPattern(
  ctx: CanvasRenderingContext2D,
  theme: Parameters<typeof textFont>[0],
  g: DrawingGeometry,
  s: PatternStyle,
  spec: PatternSpec,
): void {
  const pts = g.points;
  if (s.fillBackground && spec.fills) {
    ctx.fillStyle = s.fillColor;
    for (const f of spec.fills) {
      const poly = polygon(g, f);
      if (!poly) continue;
      ctx.beginPath();
      tracePolyline(ctx, poly, true);
      ctx.fill();
    }
  }
  const connectors = ratioLines(g, spec, s);
  if (connectors.length) {
    setLineStyle(ctx, s.ratioColor, 1, 'dashed');
    for (const c of connectors) {
      ctx.beginPath();
      ctx.moveTo(c.a.x, c.a.y);
      ctx.lineTo(c.b.x, c.b.y);
      ctx.stroke();
    }
  }
  if (spec.neckline) {
    const a = pts[spec.neckline[0]];
    const b = pts[spec.neckline[1]];
    if (a && b) {
      setLineStyle(ctx, s.necklineColor, s.lineWidth, 'solid');
      strokePolyline(ctx, [a, b]);
    }
  }
  setLineStyle(ctx, s.lineColor, s.lineWidth, s.lineStyle);
  for (const [i, j] of spec.lines ?? []) {
    const a = pts[i];
    const b = pts[j];
    if (a && b) strokePolyline(ctx, [a, b]);
  }
  strokePolyline(ctx, pts);

  ctx.setLineDash([]);
  ctx.textAlign = 'center';
  if (s.showLabels) {
    const labels = spec.labels(s);
    ctx.font = textFont(theme, s.fontSize);
    ctx.fillStyle = s.textColor;
    for (let i = 0; i < pts.length; i++) {
      const text = labels[i];
      const p = pts[i]!;
      if (!text || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const above = labelAbove(pts, i);
      ctx.textBaseline = above ? 'bottom' : 'top';
      ctx.fillText(text, p.x, above ? p.y - LABEL_GAP : p.y + LABEL_GAP);
    }
  }
  if (connectors.length) {
    ctx.font = textFont(theme, Math.max(9, s.fontSize - 1));
    ctx.fillStyle = s.ratioColor;
    ctx.textBaseline = 'middle';
    for (const c of connectors) if (c.text) ctx.fillText(c.text, c.mid.x, c.mid.y - 0.5);
  }
}

export function hitPattern(
  g: DrawingGeometry,
  s: PatternStyle,
  spec: PatternSpec,
  x: number,
  y: number,
  tol: number,
): DrawingHitPart | null {
  const t = tol + s.lineWidth / 2;
  if (polylineDistance(g.points, x, y) <= t) return BODY_HIT;
  for (const [i, j] of spec.lines ?? []) {
    const a = g.points[i];
    const b = g.points[j];
    if (a && b && segmentDistance(x, y, a.x, a.y, b.x, b.y) <= t) return BODY_HIT;
  }
  if (spec.neckline) {
    const a = g.points[spec.neckline[0]];
    const b = g.points[spec.neckline[1]];
    if (a && b && segmentDistance(x, y, a.x, a.y, b.x, b.y) <= t) return BODY_HIT;
  }
  for (const c of ratioLines(g, spec, s)) {
    if (segmentDistance(x, y, c.a.x, c.a.y, c.b.x, c.b.y) <= tol + 0.5) return BODY_HIT;
  }
  if (s.fillBackground && spec.fills) {
    for (const f of spec.fills) {
      const poly = polygon(g, f);
      if (poly && poly.length >= 3 && pointInPolygon(poly, x, y)) return WEAK_BODY_HIT;
    }
  }
  return null;
}

// ------------------------------------------------------------------ tool factory

export interface PatternToolOptions {
  type: string;
  name: string;
  count: number;
  spec: PatternSpec;
  defaults?: Partial<PatternStyle>;
  /** Show the wave-degree dropdown. */
  elliott?: boolean;
}

/** A pattern/wave tool: `count` anchors drawn as a labelled zigzag. */
export function makePatternTool(o: PatternToolOptions) {
  const { spec } = o;
  const properties: DrawingProperty[] = [
    { kind: 'color', key: 'lineColor', label: 'Line', inline: 'line' },
    { kind: 'lineWidth', key: 'lineWidth', label: 'Width', inline: 'line' },
    { kind: 'lineStyle', key: 'lineStyle', label: 'Style', inline: 'line' },
  ];
  if (o.elliott) {
    properties.push({
      kind: 'enum',
      key: 'degree',
      label: 'Degree',
      options: ELLIOTT_DEGREE_KEYS,
      labels: ELLIOTT_DEGREE_LABELS,
    });
  }
  properties.push(
    { kind: 'bool', key: 'showLabels', label: 'Labels', inline: 'labels' },
    { kind: 'color', key: 'textColor', label: 'Color', inline: 'labels' },
    { kind: 'fontSize', key: 'fontSize', label: 'Size', inline: 'labels' },
  );
  if (spec.ratios) {
    properties.push(
      { kind: 'bool', key: 'showRatios', label: 'Ratios', inline: 'ratios' },
      { kind: 'color', key: 'ratioColor', label: 'Color', inline: 'ratios' },
    );
  }
  if (spec.neckline) properties.push({ kind: 'color', key: 'necklineColor', label: 'Neckline' });
  if (spec.fills) {
    properties.push(
      { kind: 'bool', key: 'fillBackground', label: 'Background', inline: 'bg' },
      { kind: 'color', key: 'fillColor', label: 'Fill', inline: 'bg' },
    );
  }
  return defineDrawingTool({
    type: o.type,
    name: o.name,
    group: 'patterns',
    creation: { kind: 'points', count: o.count },
    shiftConstraint: 'none',
    defaults: { ...PATTERN_DEFAULTS, ...o.defaults } as PatternStyle,
    properties,

    render({ ctx, theme }, g, s) {
      renderPattern(ctx, theme, g, s, spec);
    },

    hitTest(g, s, x, y, tol) {
      return hitPattern(g, s, spec, x, y, tol);
    },
  });
}
