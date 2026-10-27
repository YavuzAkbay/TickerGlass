import { defineIndicator } from '../registry';
import type { InputsSchema, StepContext } from '../types';
import { COLOR } from './common';
import { zigZagPivots } from './zigzag';

// ----------------------------------------------------------- detection core

/** One ZigZag pivot (`dir`: 1 = high, -1 = low). */
export interface PatternPivot {
  bar: number;
  price: number;
  dir: number;
}

export type PatternKind =
  | 'doubleTop'
  | 'doubleBottom'
  | 'tripleTop'
  | 'tripleBottom'
  | 'headShoulders'
  | 'inverseHeadShoulders'
  | 'ascendingTriangle'
  | 'descendingTriangle'
  | 'symmetricalTriangle'
  | 'risingWedge'
  | 'fallingWedge'
  | 'rectangle';

/** 0 = bearish, 1 = bullish, 2 = neutral. */
export type PatternCategory = 0 | 1 | 2;

export const PATTERN_CATEGORY: Readonly<Record<PatternKind, PatternCategory>> = {
  doubleTop: 0,
  tripleTop: 0,
  headShoulders: 0,
  risingWedge: 0,
  descendingTriangle: 0,
  doubleBottom: 1,
  tripleBottom: 1,
  inverseHeadShoulders: 1,
  fallingWedge: 1,
  ascendingTriangle: 1,
  symmetricalTriangle: 2,
  rectangle: 2,
};

/** Straight line y = intercept + slope * bar through a pattern's pivots. */
export interface PatternLine {
  slope: number;
  intercept: number;
}

export interface DetectedPattern {
  kind: PatternKind;
  category: PatternCategory;
  /** First/last pivot bar of the pattern's pivot window. */
  startBar: number;
  endBar: number;
  /** The completing pivot's bar (where the label sits). */
  labelBar: number;
  /** The window's pivots, oldest first (the pattern's zigzag path). */
  pivots: PatternPivot[];
  /** Boundary anchors: equal highs/lows, shoulders and head, or trend touches. */
  highAnchors: PatternPivot[];
  lowAnchors: PatternPivot[];
  /** Trend-line fits (line patterns); null = piecewise anchors (point patterns). */
  fitHigh: PatternLine | null;
  fitLow: PatternLine | null;
}

/** Window sizes tried for line patterns, largest first. */
const WINDOW_SIZES = [6, 5, 4] as const;
/** Smallest pivot window that can hold a pattern (double top/bottom). */
const MIN_WINDOW = 4;
/** Largest pivot window (triple top/bottom, head & shoulders, 3-touch lines). */
const MAX_WINDOW = 6;
/**
 * Pivots behind the last one whose patterns are re-checked on every bar. A
 * pattern is written while its completing pivot is within this lookback and
 * never touched afterwards, so the drawn picture only depends on the final
 * pivot list. Must not exceed the retained-pivot window minus MAX_WINDOW + 1.
 */
const LOOKBACK = 7;
/** Minimum pattern length in bars. */
const MIN_SPAN = 5;

function relDiff(a: number, b: number): number {
  const mean = (a + b) / 2;
  return mean > 0 || mean < 0 ? (Math.abs(a - b) / mean) * 100 : Infinity;
}

function meanOf(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Least-squares line through the points (closed form, mirrored by the goldens). */
function fitLine(points: readonly PatternPivot[]): PatternLine {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.bar;
    sy += p.price;
    sxx += p.bar * p.bar;
    sxy += p.bar * p.price;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function lineValue(line: PatternLine, bar: number): number {
  return line.intercept + line.slope * bar;
}

/** Piecewise-linear value at `bar` through the anchors, clamped at the ends. */
export function interpAnchors(points: readonly PatternPivot[], bar: number): number {
  const first = points[0]!;
  if (bar <= first.bar) return first.price;
  const last = points[points.length - 1]!;
  if (bar >= last.bar) return last.price;
  for (let k = 1; k < points.length; k++) {
    const b = points[k]!;
    if (bar <= b.bar) {
      const a = points[k - 1]!;
      return a.price + ((b.price - a.price) * (bar - a.bar)) / (b.bar - a.bar);
    }
  }
  return last.price;
}

/** Upper (high) or lower (low) boundary value of a detected pattern at a bar. */
export function patternBoundary(p: DetectedPattern, bar: number, high: boolean): number {
  const fit = high ? p.fitHigh : p.fitLow;
  if (fit) return lineValue(fit, bar);
  return interpAnchors(high ? p.highAnchors : p.lowAnchors, bar);
}

interface Window {
  pivots: PatternPivot[];
  startBar: number;
  endBar: number;
  meanPrice: number;
}

/** The `size` pivots ending at `end`, or null outside the span/length limits. */
function windowOf(
  pivots: readonly PatternPivot[],
  end: number,
  size: number,
  maxBars: number,
): Window | null {
  const start = end - size + 1;
  if (start < 0) return null;
  const w = pivots.slice(start, end + 1);
  const startBar = w[0]!.bar;
  const endBar = w[size - 1]!.bar;
  const span = endBar - startBar;
  if (span < MIN_SPAN || span > maxBars) return null;
  const meanPrice = meanOf(w.map((p) => p.price));
  if (!(meanPrice > 0)) return null;
  return { pivots: w, startBar, endBar, meanPrice };
}

function build(
  kind: PatternKind,
  w: Window,
  highAnchors: PatternPivot[],
  lowAnchors: PatternPivot[],
): DetectedPattern {
  const last = w.pivots[w.pivots.length - 1]!;
  return {
    kind,
    category: PATTERN_CATEGORY[kind],
    startBar: w.startBar,
    endBar: w.endBar,
    labelBar: last.bar,
    pivots: w.pivots,
    highAnchors,
    lowAnchors,
    fitHigh: null,
    fitLow: null,
  };
}

/**
 * Reversal patterns from roughly equal extremes: double/triple top and bottom,
 * head & shoulders and its inverse. The window's last pivot decides the family
 * (a high completes tops, a low completes bottoms).
 */
function pointPattern(w: Window, tolerance: number): DetectedPattern | null {
  const p = w.pivots;
  if (p[p.length - 1]!.dir > 0) {
    if (p.length === 4) {
      // [L H L H]: two tops about a middle valley.
      if (relDiff(p[1]!.price, p[3]!.price) <= tolerance)
        return build('doubleTop', w, [p[1]!, p[3]!], [p[0]!, p[2]!]);
      return null;
    }
    // [L H L H L H]: three tops over two similar valleys, or a head above two
    // about-equal shoulders.
    const h1 = p[1]!.price;
    const h3 = p[3]!.price;
    const h5 = p[5]!.price;
    const meanH = meanOf([h1, h3, h5]);
    if (
      meanH > 0 &&
      relDiff(h1, meanH) <= tolerance &&
      relDiff(h3, meanH) <= tolerance &&
      relDiff(h5, meanH) <= tolerance &&
      relDiff(p[2]!.price, p[4]!.price) <= tolerance
    )
      return build('tripleTop', w, [p[1]!, p[3]!, p[5]!], [p[0]!, p[2]!, p[4]!]);
    if (h3 > h1 && h3 > h5 && relDiff(h1, h5) <= tolerance)
      return build('headShoulders', w, [p[1]!, p[3]!, p[5]!], [p[0]!, p[2]!, p[4]!]);
    return null;
  }
  if (p.length === 4) {
    // [H L H L]: two bottoms about a middle peak.
    if (relDiff(p[1]!.price, p[3]!.price) <= tolerance)
      return build('doubleBottom', w, [p[0]!, p[2]!], [p[1]!, p[3]!]);
    return null;
  }
  // [H L H L H L]: three bottoms under two similar peaks, or a head below two
  // about-equal shoulders.
  const l1 = p[1]!.price;
  const l3 = p[3]!.price;
  const l5 = p[5]!.price;
  const meanL = meanOf([l1, l3, l5]);
  if (
    meanL > 0 &&
    relDiff(l1, meanL) <= tolerance &&
    relDiff(l3, meanL) <= tolerance &&
    relDiff(l5, meanL) <= tolerance &&
    relDiff(p[2]!.price, p[4]!.price) <= tolerance
  )
    return build('tripleBottom', w, [p[0]!, p[2]!, p[4]!], [p[1]!, p[3]!, p[5]!]);
  if (l3 < l1 && l3 < l5 && relDiff(l1, l5) <= tolerance)
    return build('inverseHeadShoulders', w, [p[0]!, p[2]!, p[4]!], [p[1]!, p[3]!, p[5]!]);
  return null;
}

/**
 * Continuation patterns from a trend line through the highs and one through
 * the lows: rectangle, triangles (flat vs trending sides) and wedges (same
 * direction, converging). Flatness is measured as the fitted line's total
 * change over the pattern span as a percentage of the window's mean price.
 */
function linePattern(w: Window, tolerance: number): DetectedPattern | null {
  const highs = w.pivots.filter((p) => p.dir > 0);
  const lows = w.pivots.filter((p) => p.dir < 0);
  if (highs.length < 2 || lows.length < 2) return null;
  const fitHigh = fitLine(highs);
  const fitLow = fitLine(lows);
  // The fitted lines must not cross inside the pattern.
  if (lineValue(fitHigh, w.startBar) <= lineValue(fitLow, w.startBar)) return null;
  if (lineValue(fitHigh, w.endBar) <= lineValue(fitLow, w.endBar)) return null;
  // Every touch must lie on its line (a V-shaped sequence of lows averages
  // out to a flat fit but is not a trend line).
  for (const p of highs)
    if ((Math.abs(p.price - lineValue(fitHigh, p.bar)) / w.meanPrice) * 100 > tolerance)
      return null;
  for (const p of lows)
    if ((Math.abs(p.price - lineValue(fitLow, p.bar)) / w.meanPrice) * 100 > tolerance) return null;
  // Flatness is the fitted line's change across its own touches (the anchors'
  // extent), as a percentage of the window's mean price.
  const changeHigh =
    (Math.abs(
      lineValue(fitHigh, highs[highs.length - 1]!.bar) - lineValue(fitHigh, highs[0]!.bar),
    ) /
      w.meanPrice) *
    100;
  const changeLow =
    (Math.abs(lineValue(fitLow, lows[lows.length - 1]!.bar) - lineValue(fitLow, lows[0]!.bar)) /
      w.meanPrice) *
    100;
  const flatHigh = changeHigh < tolerance;
  const flatLow = changeLow < tolerance;
  const risingHigh = !flatHigh && fitHigh.slope > 0;
  const fallingHigh = !flatHigh && fitHigh.slope < 0;
  const risingLow = !flatLow && fitLow.slope > 0;
  const fallingLow = !flatLow && fitLow.slope < 0;
  let kind: PatternKind | null = null;
  if (flatHigh && flatLow) kind = 'rectangle';
  else if (flatHigh && risingLow) kind = 'ascendingTriangle';
  else if (fallingHigh && flatLow) kind = 'descendingTriangle';
  else if (fallingHigh && risingLow) kind = 'symmetricalTriangle';
  else if (risingHigh && risingLow && fitLow.slope > fitHigh.slope) kind = 'risingWedge';
  else if (fallingHigh && fallingLow && fitHigh.slope < fitLow.slope) kind = 'fallingWedge';
  if (!kind) return null;
  const last = w.pivots[w.pivots.length - 1]!;
  return {
    kind,
    category: PATTERN_CATEGORY[kind],
    startBar: w.startBar,
    endBar: w.endBar,
    labelBar: last.bar,
    pivots: w.pivots,
    highAnchors: highs,
    lowAnchors: lows,
    fitHigh,
    fitLow,
  };
}

function matchAt(
  pivots: readonly PatternPivot[],
  end: number,
  tolerance: number,
  maxBars: number,
): DetectedPattern | null {
  // Reversal patterns first (they take precedence over continuation shapes).
  const w6 = windowOf(pivots, end, MAX_WINDOW, maxBars);
  if (w6) {
    const p = pointPattern(w6, tolerance);
    if (p) return p;
  }
  const w4 = windowOf(pivots, end, MIN_WINDOW, maxBars);
  if (w4) {
    const p = pointPattern(w4, tolerance);
    if (p) return p;
  }
  for (const size of WINDOW_SIZES) {
    const w = windowOf(pivots, end, size, maxBars);
    if (!w) continue;
    const p = linePattern(w, tolerance);
    if (p) return p;
  }
  return null;
}

/**
 * Detects chart patterns on a ZigZag pivot list: windows ending at each of
 * the last `lookback` pivots (one pattern per completing pivot, larger
 * windows first, reversals before continuation shapes), then a pattern whose
 * pivot window is contained in a longer one is dropped (the two valleys of a
 * head & shoulders do not label as a double bottom; a containing window has
 * at most 6 pivots, so containment is decided among the detected set). The
 * indicator re-checks exactly these ends on every bar with the default
 * lookback, and a pattern's window is frozen once its completing pivot is
 * `lookback - 1` pivots behind the last, so the final drawn state equals a
 * full-history pass (`lookback: Infinity`) over the final pivot list.
 * `tolerance` is the maximum relative difference in % for equal extremes and
 * flat trend lines, `maxBars` the longest pattern span.
 */
export function detectChartPatterns(
  pivots: readonly PatternPivot[],
  tolerance: number,
  maxBars: number,
  lookback: number = LOOKBACK,
): DetectedPattern[] {
  const found: { p: DetectedPattern; startIdx: number; endIdx: number }[] = [];
  const firstEnd = Number.isFinite(lookback)
    ? Math.max(MIN_WINDOW - 1, pivots.length - lookback)
    : MIN_WINDOW - 1;
  for (let end = firstEnd; end < pivots.length; end++) {
    const p = matchAt(pivots, end, tolerance, maxBars);
    if (p) found.push({ p, startIdx: end - p.pivots.length + 1, endIdx: end });
  }
  return found
    .filter((a) => !found.some((b) => b.endIdx > a.endIdx && b.startIdx <= a.startIdx))
    .map((f) => f.p);
}

// -------------------------------------------------------------- definition

/**
 * Label outputs, one per pattern kind: id, bubble text and category. The
 * category decides the default colour and where the bubble sits (bullish
 * patterns label below the completing bar, the rest above).
 */
const PATTERN_LABELS = [
  { kind: 'doubleTop', id: 'dblTop', text: 'Double Top' },
  { kind: 'doubleBottom', id: 'dblBot', text: 'Double Bottom' },
  { kind: 'tripleTop', id: 'triTop', text: 'Triple Top' },
  { kind: 'tripleBottom', id: 'triBot', text: 'Triple Bottom' },
  { kind: 'headShoulders', id: 'hs', text: 'Head & Shoulders' },
  { kind: 'inverseHeadShoulders', id: 'ihs', text: 'Inverse H&S' },
  { kind: 'ascendingTriangle', id: 'ascTri', text: 'Ascending Triangle' },
  { kind: 'descendingTriangle', id: 'descTri', text: 'Descending Triangle' },
  { kind: 'symmetricalTriangle', id: 'symTri', text: 'Symmetrical Triangle' },
  { kind: 'risingWedge', id: 'risWed', text: 'Rising Wedge' },
  { kind: 'fallingWedge', id: 'falWed', text: 'Falling Wedge' },
  { kind: 'rectangle', id: 'rect', text: 'Rectangle' },
] as const;

type LabelDef = (typeof PATTERN_LABELS)[number];
type LabelId = LabelDef['id'];

const LABEL_ID = Object.fromEntries(PATTERN_LABELS.map((l) => [l.kind, l.id])) as Record<
  PatternKind,
  LabelId
>;
const LABEL_IDS: readonly LabelId[] = PATTERN_LABELS.map((l) => l.id);

const CATEGORY_COLOR: Record<PatternCategory, string> = {
  0: COLOR.red,
  1: COLOR.green,
  2: COLOR.orange,
};

const LINE_COLORS = [COLOR.red, COLOR.green, COLOR.orange] as const;
/** Pivot lines: 0 outside patterns, then bearish/bullish/neutral (category + 1). */
const PIVOT_COLORS = [COLOR.level, COLOR.red, COLOR.green, COLOR.orange] as const;

/**
 * Retained ZigZag pivots: the detection lookback plus the reach of a
 * max-size window ending at the oldest re-checked pivot.
 */
const K = LOOKBACK + MAX_WINDOW - 1;
const BAR_KEYS = Array.from({ length: K }, (_, k) => `b${k}`);
const PRICE_KEYS = Array.from({ length: K }, (_, k) => `p${k}`);
const DIR_KEYS = Array.from({ length: K }, (_, k) => `d${k}`);
/**
 * What the last run drew, per pattern: start/end bar, label bar and label
 * kind index (a run detects at most one pattern per re-checked pivot).
 */
const DRAWN_START = Array.from({ length: LOOKBACK }, (_, k) => `s${k}`);
const DRAWN_END = Array.from({ length: LOOKBACK }, (_, k) => `e${k}`);
const DRAWN_LABEL_BAR = Array.from({ length: LOOKBACK }, (_, k) => `l${k}`);
const DRAWN_LABEL_KIND = Array.from({ length: LOOKBACK }, (_, k) => `k${k}`);
const LABEL_INDEX = Object.fromEntries(PATTERN_LABELS.map((l, k) => [l.kind, k])) as Record<
  PatternKind,
  number
>;
const WIN_INIT: Record<string, number> = { n: 0, dirty: 0, drawn: 0 };
for (let k = 0; k < K; k++) {
  WIN_INIT[BAR_KEYS[k]!] = -1;
  WIN_INIT[PRICE_KEYS[k]!] = 0;
  WIN_INIT[DIR_KEYS[k]!] = 0;
}
for (let k = 0; k < LOOKBACK; k++) {
  WIN_INIT[DRAWN_START[k]!] = 0;
  WIN_INIT[DRAWN_END[k]!] = -1;
  WIN_INIT[DRAWN_LABEL_BAR[k]!] = -1;
  WIN_INIT[DRAWN_LABEL_KIND[k]!] = 0;
}

type PatternCtx = Pick<
  StepContext<InputsSchema, LabelId | 'zone' | 'upper' | 'lower' | 'zz'>,
  'i' | 'high' | 'low' | 'setAt'
>;

/** Rolling pivot window carried across bars (ta.vars). */
interface PatternVars extends Record<string, number> {
  /** Retained pivots (0..K). */
  n: number;
  /** 1: the pivots changed since the last run. */
  dirty: number;
  /** Patterns drawn by the last run (0..LOOKBACK). */
  drawn: number;
}

/**
 * Chart Patterns: automatic detection on ZigZag pivots (see `zigZagPivots` and
 * `detectChartPatterns`). The pivot skeleton is drawn as a gap-connecting line
 * (segments inside a pattern take the pattern's colour), each pattern's
 * boundaries are drawn as lines with a filled zone between them, and a label
 * bubble names the pattern at its completing pivot. Every bar re-checks the
 * pivot lookback, so finished patterns accumulate exactly as they do on a live
 * feed; patterns repaint while their completing pivot can still move, like the
 * ZigZag's do.
 */
export const CHART_PATTERNS = defineIndicator({
  id: 'chart-patterns',
  name: 'Chart Patterns',
  shortName: 'Patterns',
  category: 'other',
  keywords: [
    'pattern',
    'patterns',
    'double top',
    'double bottom',
    'triple top',
    'triple bottom',
    'head and shoulders',
    'inverse head and shoulders',
    'triangle',
    'wedge',
    'rectangle',
    'auto',
    'detect',
    'detection',
    'reversal',
    'continuation',
  ],
  overlay: true,
  repaints: true,
  inputs: {
    deviation: {
      kind: 'float',
      label: 'Price deviation for reversals (%)',
      default: 5,
      min: 0.00001,
      max: 100,
      step: 0.5,
    },
    depth: { kind: 'int', label: 'Pivot legs', default: 10, min: 2, max: 500 },
    tolerance: {
      kind: 'float',
      label: 'Pattern match tolerance (%)',
      default: 3,
      min: 0.1,
      max: 50,
      step: 0.5,
      hideInTitle: true,
    },
    maxBars: {
      kind: 'int',
      label: 'Max pattern length (bars)',
      default: 150,
      min: 10,
      max: 5000,
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'fill',
      id: 'zone',
      title: 'Zone',
      between: ['upper', 'lower'],
      color: COLOR.blueFill,
    },
    {
      type: 'plot',
      id: 'upper',
      title: 'Upper Boundary',
      kind: 'line',
      color: LINE_COLORS,
      lineWidth: 2,
      showLastValue: false,
    },
    {
      type: 'plot',
      id: 'lower',
      title: 'Lower Boundary',
      kind: 'line',
      color: LINE_COLORS,
      lineWidth: 2,
      showLastValue: false,
    },
    {
      type: 'plot',
      id: 'zz',
      title: 'Pivot Lines',
      kind: 'line',
      color: PIVOT_COLORS,
      lineWidth: 1,
      connectGaps: true,
      showLastValue: false,
    },
    ...PATTERN_LABELS.map(
      (l) =>
        ({
          type: 'shape',
          id: l.id,
          title: l.text,
          shape: PATTERN_CATEGORY[l.kind] === 1 ? 'labelUp' : 'labelDown',
          location: PATTERN_CATEGORY[l.kind] === 1 ? 'belowBar' : 'aboveBar',
          color: CATEGORY_COLOR[PATTERN_CATEGORY[l.kind]],
          text: l.text,
          textColor: '#ffffff',
        }) as const,
    ),
  ],
  setup({ inputs, ta }) {
    const win = ta.vars({ ...WIN_INIT }) as PatternVars;
    const at = (keys: readonly string[], k: number): number => win[keys[k]!]!;
    const setSlot = (k: number, bar: number, price: number, dir: number) => {
      win[BAR_KEYS[k]!] = bar;
      win[PRICE_KEYS[k]!] = price;
      win[DIR_KEYS[k]!] = dir;
    };
    /** New pivot: drop the oldest once the window is full. */
    const push = (bar: number, price: number, dir: number) => {
      const n = win.n;
      if (n >= K) {
        for (let k = 0; k < K - 1; k++)
          setSlot(k, at(BAR_KEYS, k + 1), at(PRICE_KEYS, k + 1), at(DIR_KEYS, k + 1));
        setSlot(K - 1, bar, price, dir);
      } else {
        setSlot(n, bar, price, dir);
        win.n = n + 1;
      }
    };
    const zz = zigZagPivots<PatternCtx>(ta, inputs.depth, {
      set(c, j, price, high) {
        win.dirty = 1;
        const dir = high ? 1 : -1;
        const last = win.n - 1;
        if (last >= 0 && at(DIR_KEYS, last) === dir && at(BAR_KEYS, last) === j) {
          // A hidden same-bar pivot restored by a ZigZag move: refresh its price.
          win[PRICE_KEYS[last]!] = price;
        } else {
          push(j, price, dir);
        }
        c.setAt('zz', j, price);
      },
      clear(c, j, high) {
        win.dirty = 1;
        // The moving pivot is removed here and re-added by the following set.
        const last = win.n - 1;
        if (last >= 0 && at(BAR_KEYS, last) === j && at(DIR_KEYS, last) === (high ? 1 : -1))
          win.n = last;
        c.setAt('zz', j, NaN);
      },
    });
    return (c) => {
      zz.update(c, inputs.deviation);
      const n = win.n;
      // Detection and drawing depend on the pivots only: without a change
      // since the last run, a re-run would rewrite the same values.
      if (n < MIN_WINDOW || !win.dirty) return;
      win.dirty = 0;
      // Every change re-draws the pivot lookback, so a full computation
      // accumulates the same finished patterns a live feed does (each run
      // re-checks the windows that can still change; finished ones keep their
      // writes until they leave the lookback, which the clear below covers).
      const pivots: PatternPivot[] = [];
      for (let k = 0; k < n; k++)
        pivots.push({ bar: at(BAR_KEYS, k), price: at(PRICE_KEYS, k), dir: at(DIR_KEYS, k) });
      const patterns = detectChartPatterns(pivots, inputs.tolerance, inputs.maxBars);
      // Clear everything previous runs wrote for pivots still in the lookback
      // (bars behind the oldest re-checked pivot belong to finished patterns).
      // Within the lookback only the last run's patterns left anything, so
      // only their bars are visited.
      const from = pivots[Math.max(0, n - LOOKBACK)]!.bar;
      const to = pivots[n - 1]!.bar;
      for (let k = 0; k < win.drawn; k++) {
        for (let j = Math.max(from, at(DRAWN_START, k)); j <= at(DRAWN_END, k); j++) {
          if (!patterns.some((p) => j >= p.startBar && j <= p.endBar)) {
            if (!Number.isNaN(c.get('upper', j))) c.setAt('upper', j, NaN);
            if (!Number.isNaN(c.get('lower', j))) c.setAt('lower', j, NaN);
          }
        }
        const labelBar = at(DRAWN_LABEL_BAR, k);
        const id = LABEL_IDS[at(DRAWN_LABEL_KIND, k)]!;
        if (labelBar >= from && !Number.isNaN(c.get(id, labelBar))) c.setAt(id, labelBar, NaN);
      }
      // Palette colours only render where the pivot line has a value (which
      // only the retained pivots' bars have).
      for (let k = 0; k < n; k++) {
        const j = at(BAR_KEYS, k);
        const zzj = c.get('zz', j);
        if (j >= from && j <= to && !Number.isNaN(zzj)) c.setAt('zz', j, zzj, 0);
      }
      for (const p of patterns) {
        for (let j = p.startBar; j <= p.endBar; j++) {
          // Unconditional: the value can be unchanged while the category
          // colour changes when patterns overlap.
          c.setAt('upper', j, patternBoundary(p, j, true), p.category);
          c.setAt('lower', j, patternBoundary(p, j, false), p.category);
        }
        for (const pv of p.pivots) c.setAt('zz', pv.bar, c.get('zz', pv.bar), p.category + 1);
        if (!Object.is(c.get(LABEL_ID[p.kind], p.labelBar), 1))
          c.setAt(LABEL_ID[p.kind], p.labelBar, 1);
      }
      win.drawn = patterns.length;
      for (let k = 0; k < patterns.length; k++) {
        const p = patterns[k]!;
        win[DRAWN_START[k]!] = p.startBar;
        win[DRAWN_END[k]!] = p.endBar;
        win[DRAWN_LABEL_BAR[k]!] = p.labelBar;
        win[DRAWN_LABEL_KIND[k]!] = LABEL_INDEX[p.kind];
      }
    };
  },
});
