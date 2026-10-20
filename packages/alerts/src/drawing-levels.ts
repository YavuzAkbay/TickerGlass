/**
 * Drawing levels (docs/alerts.md §2.6). The chart draws straight lines in
 * (logical index, f(price)) space, with f = log10 on log scales and the
 * identity otherwise; these functions reproduce a tool's line from its anchors,
 * the snapshotted scale and an `AnchorTimeline` of the alert's own bars.
 */
import { timeToLogical, type AnchorTimeline } from '@investopen/engine/node';
import type { DrawingPart, DrawingScaleMode } from './types';

/** A permanent problem with the drawing: the alert goes to status `error` with this message. */
export class DrawingLevelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DrawingLevelError';
  }
}

/** The fields of an engine `Drawing` the level math reads. */
export interface DrawingLike {
  type: string;
  points: readonly { time: number; price: number }[];
  style: Readonly<Record<string, unknown>>;
}

/** Tools whose single line is a `part: 'line'` target (§1.2). */
export const LINE_TOOLS: readonly string[] = [
  'trend-line',
  'ray',
  'extended-line',
  'measured-line',
  'arrow-line',
  'horizontal-line',
  'horizontal-ray',
];

/** Tools that are channels (upper/lower/middle parts or a whole-channel operand). */
export const CHANNEL_TOOLS: readonly string[] = [
  'parallel-channel',
  'rectangle',
  'flat-channel',
  'split-channel',
];

/** Anchors each tool needs. */
export const TOOL_POINTS: Readonly<Record<string, number>> = {
  'trend-line': 2,
  ray: 2,
  'extended-line': 2,
  'measured-line': 2,
  'arrow-line': 2,
  'horizontal-line': 1,
  'horizontal-ray': 1,
  'parallel-channel': 3,
  rectangle: 2,
  // Split channels are stored with a 4th anchor; a 3-anchor draft derives it.
  'flat-channel': 3,
  'split-channel': 3,
};

/** Tool default extensions (the engine's `defaults`), used when the style lacks the key. */
const EXTEND_DEFAULTS: Readonly<Record<string, readonly [boolean, boolean]>> = {
  'trend-line': [false, false],
  ray: [false, true],
  'extended-line': [true, true],
  'measured-line': [false, false],
  'parallel-channel': [false, false],
  rectangle: [false, false],
  'flat-channel': [false, false],
  'split-channel': [false, false],
};

/** Whether a drawing type supports `part` as a `DrawingLineOperand`. */
export function supportsPart(type: string, part: DrawingPart): boolean {
  if (LINE_TOOLS.includes(type)) return part === 'line';
  if (CHANNEL_TOOLS.includes(type)) return part !== 'line';
  return false;
}

/** Whether a drawing type can be a whole-channel operand. */
export function isChannelTool(type: string): boolean {
  return CHANNEL_TOOLS.includes(type);
}

const LOG_FLOOR = 1e-12;

function scaleFns(scale: DrawingScaleMode): { f: (p: number) => number; g: (v: number) => number } {
  if (scale === 'log')
    return { f: (p) => Math.log10(Math.max(p, LOG_FLOOR)), g: (v) => Math.pow(10, v) };
  return { f: (p) => p, g: (v) => v };
}

function extendOf(d: DrawingLike): [boolean, boolean] {
  const def = EXTEND_DEFAULTS[d.type] ?? [false, false];
  const l = d.style['extendLeft'];
  const r = d.style['extendRight'];
  return [typeof l === 'boolean' ? l : def[0], typeof r === 'boolean' ? r : def[1]];
}

function point(d: DrawingLike, j: number): { time: number; price: number } {
  const p = d.points[j];
  if (!p)
    throw new DrawingLevelError(
      CHANNEL_TOOLS.includes(d.type) ? 'incomplete channel' : 'incomplete drawing',
    );
  return p;
}

const logical = (tl: AnchorTimeline, time: number) => timeToLogical(tl, { time });

/** Parameter s range of a segment with the drawing's extensions. */
function inDomain(s: number, left: boolean, right: boolean): boolean {
  return (left || s >= 0) && (right || s <= 1);
}

/**
 * Parametric line A->B at logical `L` in f-space, or NaN outside the domain.
 * Throws `vertical line` when the anchors share a logical index.
 */
function lineAt(
  lA: number,
  fA: number,
  lB: number,
  fB: number,
  L: number,
  left: boolean,
  right: boolean,
): number {
  const dl = lB - lA;
  if (!(Math.abs(dl) >= 1e-9)) throw new DrawingLevelError('vertical line');
  const s = (L - lA) / dl;
  return inDomain(s, left, right) ? fA + s * (fB - fA) : NaN;
}

function checkFinite(...xs: number[]): boolean {
  return xs.every((x) => Number.isFinite(x));
}

/**
 * Level of a line tool (`part: 'line'`) or a channel part at the bar opening at
 * `t`, in the drawing pane's units. NaN where the drawing has no value (outside
 * a segment, before a horizontal ray, or without bars).
 * Throws `DrawingLevelError` for unsupported tools/parts, missing anchors and
 * vertical lines.
 */
export function drawingLevel(
  drawing: DrawingLike,
  part: DrawingPart,
  scale: DrawingScaleMode,
  timeline: AnchorTimeline,
  t: number,
): number {
  if (!supportsPart(drawing.type, part))
    throw new DrawingLevelError(`unsupported drawing part '${part}' for ${drawing.type}`);
  if (part !== 'line') {
    const ch = channelParts(drawing, scale, timeline, t);
    return ch[part];
  }
  const L = logical(timeline, t);
  switch (drawing.type) {
    case 'horizontal-line':
      return point(drawing, 0).price;
    case 'horizontal-ray': {
      const p = point(drawing, 0);
      const l0 = logical(timeline, p.time);
      if (!checkFinite(L, l0)) return NaN;
      return L >= l0 ? p.price : NaN;
    }
    default: {
      const a = point(drawing, 0);
      const b = point(drawing, 1);
      const lA = logical(timeline, a.time);
      const lB = logical(timeline, b.time);
      if (!checkFinite(L, lA, lB)) return NaN;
      const [left, right] = drawing.type === 'arrow-line' ? [false, false] : extendOf(drawing);
      const { f, g } = scaleFns(scale);
      const v = lineAt(lA, f(a.price), lB, f(b.price), L, left, right);
      return Number.isNaN(v) ? NaN : g(v);
    }
  }
}

interface ChannelParts {
  upper: number;
  lower: number;
  middle: number;
}

const NAN_PARTS: ChannelParts = { upper: NaN, lower: NaN, middle: NaN };

function channelParts(
  drawing: DrawingLike,
  scale: DrawingScaleMode,
  timeline: AnchorTimeline,
  t: number,
): ChannelParts {
  const { f, g } = scaleFns(scale);
  const L = logical(timeline, t);
  if (drawing.type === 'parallel-channel') {
    if (drawing.points.length < 3) throw new DrawingLevelError('incomplete channel');
    const p0 = point(drawing, 0);
    const p1 = point(drawing, 1);
    const p2 = point(drawing, 2);
    const l0 = logical(timeline, p0.time);
    const l1 = logical(timeline, p1.time);
    const l2 = logical(timeline, p2.time);
    if (!checkFinite(L, l0, l1, l2)) return NAN_PARTS;
    const f0 = f(p0.price);
    const f1 = f(p1.price);
    const [left, right] = extendOf(drawing);
    // Y_m at anchor 2 is unrestricted by the domain (it only defines the width).
    const ym2 = lineAt(l0, f0, l1, f1, l2, true, true);
    const delta = f(p2.price) - ym2;
    const ym = lineAt(l0, f0, l1, f1, L, left, right);
    if (Number.isNaN(ym)) return NAN_PARTS;
    const a = g(ym);
    const b = g(ym + delta);
    return { upper: Math.max(a, b), lower: Math.min(a, b), middle: g(ym + delta / 2) };
  }
  if (drawing.type === 'flat-channel' || drawing.type === 'split-channel') {
    // Two lines over the same bars: the trend line 0-1 and either a flat line at
    // anchor 2's price (flat-edge channel) or the line 2-3 (split channel).
    if (drawing.points.length < 3) throw new DrawingLevelError('incomplete channel');
    const p0 = point(drawing, 0);
    const p1 = point(drawing, 1);
    const p2 = point(drawing, 2);
    const l0 = logical(timeline, p0.time);
    const l1 = logical(timeline, p1.time);
    if (!checkFinite(L, l0, l1)) return NAN_PARTS;
    const [left, right] = extendOf(drawing);
    const a = lineAt(l0, f(p0.price), l1, f(p1.price), L, left, right);
    if (Number.isNaN(a)) return NAN_PARTS;
    let b = f(p2.price);
    if (drawing.type === 'split-channel') {
      // The engine's completePoints mirrors line 0-1's price change (in price) from anchor 2 at anchor 1's time.
      const p3 = drawing.points[3] ?? {
        time: p1.time,
        price: p2.price - (p1.price - p0.price),
      };
      const l2 = logical(timeline, p2.time);
      const l3 = logical(timeline, p3.time);
      if (!checkFinite(l2, l3)) return NAN_PARTS;
      b = lineAt(l2, f(p2.price), l3, f(p3.price), L, left, right);
      if (Number.isNaN(b)) return NAN_PARTS;
    }
    const pa = g(a);
    const pb = g(b);
    return { upper: Math.max(pa, pb), lower: Math.min(pa, pb), middle: g((a + b) / 2) };
  }
  if (drawing.type === 'rectangle') {
    const p0 = point(drawing, 0);
    const p1 = point(drawing, 1);
    const l0 = logical(timeline, p0.time);
    const l1 = logical(timeline, p1.time);
    if (!checkFinite(L, l0, l1)) return NAN_PARTS;
    const [left, right] = extendOf(drawing);
    if ((!left && L < Math.min(l0, l1)) || (!right && L > Math.max(l0, l1))) return NAN_PARTS;
    const upper = Math.max(p0.price, p1.price);
    const lower = Math.min(p0.price, p1.price);
    const middle = scale === 'log' ? g((f(upper) + f(lower)) / 2) : (upper + lower) / 2;
    return { upper, lower, middle };
  }
  throw new DrawingLevelError(`${drawing.type} is not a channel`);
}

/**
 * Whole-channel operand (parallel channel or rectangle) at the bar opening at
 * `t`: `{upper, lower}` with lower <= upper, NaN outside the drawing's domain.
 */
export function drawingChannel(
  drawing: DrawingLike,
  scale: DrawingScaleMode,
  timeline: AnchorTimeline,
  t: number,
): { upper: number; lower: number } {
  const { upper, lower } = channelParts(drawing, scale, timeline, t);
  return { upper, lower };
}
