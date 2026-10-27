import { describe, expect, it } from 'vitest';
import { BarStore } from '../bars';
import { IndicatorInstance } from '../instance';
import {
  CHART_PATTERNS,
  interpAnchors,
  patternBoundary,
  type PatternPivot,
} from './chart-patterns';

/**
 * Piecewise-linear close path through [bar, price] waypoints, rendered as
 * wick-less OHLCV. The ZigZag pivots of such a series are exactly the path's
 * turning points (depth 10 confirms them 5 bars late), so scenarios can name
 * the pivots they produce.
 */
function pathBars(waypoints: readonly (readonly [number, number])[]): BarStore {
  const n = waypoints[waypoints.length - 1]![0] + 1;
  const close = new Float64Array(n);
  for (let w = 0; w < waypoints.length - 1; w++) {
    const [b0, p0] = waypoints[w]!;
    const [b1, p1] = waypoints[w + 1]!;
    for (let i = b0; i < b1; i++) close[i] = p0 + ((p1 - p0) * (i - b0)) / (b1 - b0);
  }
  close[n - 1] = waypoints[waypoints.length - 1]![1]!;
  const time = new Float64Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const volume = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    time[i] = i * 60;
    open[i] = i === 0 ? close[0]! : close[i - 1]!;
    high[i] = Math.max(open[i]!, close[i]!);
    low[i] = Math.min(open[i]!, close[i]!);
    volume[i] = 1000;
  }
  const store = new BarStore();
  store.setAll({ time, open, high, low, close, volume });
  return store;
}

function compute(store: BarStore, inputs: Record<string, number> = {}) {
  const inst = new IndicatorInstance(CHART_PATTERNS, inputs);
  inst.computeAll(store);
  expect(inst.result().status).toEqual({ state: 'ok' });
  return inst.result();
}

function columnsOf(bars: BarStore, to: number): BarStore {
  const store = new BarStore();
  store.setAll({
    time: bars.time.subarray(0, to),
    open: bars.open.subarray(0, to),
    high: bars.high.subarray(0, to),
    low: bars.low.subarray(0, to),
    close: bars.close.subarray(0, to),
    volume: bars.volume.subarray(0, to),
  });
  return store;
}

const DOUBLE_TOP: readonly (readonly [number, number])[] = [
  [0, 104],
  [10, 99],
  [25, 110],
  [40, 103],
  [55, 111],
  [70, 97],
  [82, 104],
];

const HEAD_SHOULDERS: readonly (readonly [number, number])[] = [
  [0, 100],
  [10, 96],
  [25, 108],
  [40, 101],
  [55, 116],
  [70, 102],
  [85, 109],
  [92, 103],
];

const ASCENDING_TRIANGLE: readonly (readonly [number, number])[] = [
  [0, 100],
  [12, 108],
  [24, 102],
  [36, 111],
  [48, 105.4],
  [62, 116],
];

describe('Chart Patterns', () => {
  it('detects a double top and draws its boundaries, zone pivots and label', () => {
    const bars = pathBars(DOUBLE_TOP);
    const r = compute(bars);
    const v = r.values;
    // Pivots: L10 H25 L40 H55 L70.
    expect(v.zz![10]).toBeCloseTo(99, 10);
    expect(v.zz![25]).toBeCloseTo(110, 10);
    expect(v.zz![40]).toBeCloseTo(103, 10);
    expect(v.zz![55]).toBeCloseTo(111, 10);
    expect(v.zz![70]).toBeCloseTo(97, 10);
    // The double top completes at the second top (bar 55).
    expect(v.dblTop![55]).toBe(1);
    expect(v.dblBot![70]).toBeNaN();
    expect(v.hs![70]).toBeNaN();
    // Boundaries: tops line through (25, 110)-(55, 111), lows through (10, 99)-(40, 103).
    expect(v.upper![25]).toBeCloseTo(110, 10);
    expect(v.upper![55]).toBeCloseTo(111, 10);
    expect(v.upper![10]).toBeCloseTo(110, 10);
    expect(v.lower![10]).toBeCloseTo(99, 10);
    expect(v.lower![40]).toBeCloseTo(103, 10);
    expect(v.lower![55]).toBeCloseTo(103, 10);
    expect(v.upper![56]).toBeNaN();
    expect(v.lower![9]).toBeNaN();
    // Bearish palette (0) on the pattern, pivot skeleton recoloured inside it.
    expect(r.colors.upper![30]).toBe(0);
    expect(r.colors.lower![30]).toBe(0);
    for (const j of [10, 25, 40, 55]) expect(r.colors.zz![j]).toBe(1);
    expect(r.colors.zz![70]).toBe(0);
  });

  it('detects a head & shoulders and suppresses the double bottom of its valleys', () => {
    const bars = pathBars(HEAD_SHOULDERS);
    const r = compute(bars);
    const v = r.values;
    // Pivots: L10 H25 L40 H55 L70 H85; the last leg falls without a new pivot.
    expect(v.hs![85]).toBe(1);
    // The [H L H L] window of the two valleys would be a double bottom, but
    // the head & shoulders window contains it.
    expect(v.dblBot![70]).toBeNaN();
    expect(v.dblTop![55]).toBeNaN();
    // Shoulder-head-shoulder line over the tops, neckline through the lows.
    expect(v.upper![25]).toBeCloseTo(108, 10);
    expect(v.upper![55]).toBeCloseTo(116, 10);
    expect(v.upper![70]).toBeCloseTo(112.5, 10);
    expect(v.upper![85]).toBeCloseTo(109, 10);
    expect(v.lower![10]).toBeCloseTo(96, 10);
    expect(v.lower![40]).toBeCloseTo(101, 10);
    expect(v.lower![55]).toBeCloseTo(101.5, 10);
    expect(v.lower![70]).toBeCloseTo(102, 10);
    for (const j of [10, 25, 40, 55, 70, 85]) expect(r.colors.zz![j]).toBe(1);
  });

  it('detects an ascending triangle from fitted trend lines', () => {
    const bars = pathBars(ASCENDING_TRIANGLE);
    const r = compute(bars);
    const v = r.values;
    // Pivots: H12 L24 H36 L48 H62; flat highs, rising lows -> bullish pattern
    // completing at the low (bar 48).
    expect(v.ascTri![48]).toBe(1);
    expect(v.rect![48]).toBeNaN();
    expect(v.symTri![62]).toBeNaN();
    // Upper fit: 106.5 + 0.125j; lower fit: 98.6 + 0.141666...j.
    expect(v.upper![12]).toBeCloseTo(108, 10);
    expect(v.upper![48]).toBeCloseTo(112.5, 10);
    expect(v.lower![24]).toBeCloseTo(102, 10);
    expect(v.lower![48]).toBeCloseTo(105.4, 10);
    expect(r.colors.upper![30]).toBe(1);
    for (const j of [12, 24, 36, 48]) expect(r.colors.zz![j]).toBe(2);
  });

  it('respects the max pattern length', () => {
    const bars = pathBars(DOUBLE_TOP);
    const r = compute(bars, { maxBars: 20 });
    for (const id of ['dblTop', 'dblBot', 'hs', 'ascTri']) {
      const arr = r.values[id]!;
      expect(arr.every(Number.isNaN)).toBe(true);
    }
    expect(r.values.upper!.every(Number.isNaN)).toBe(true);
    expect(r.values.lower!.every(Number.isNaN)).toBe(true);
    // The pivot skeleton itself is still drawn (uncoloured).
    expect(r.values.zz![25]).toBeCloseTo(110, 10);
    expect(r.colors.zz!.every((c) => c === 0)).toBe(true);
  });

  it('gives the same arrays from a live feed as from a full computation', () => {
    const bars = pathBars(DOUBLE_TOP);
    const full = compute(bars);
    const inst = new IndicatorInstance(CHART_PATTERNS, {});
    inst.computeAll(columnsOf(bars, 45));
    for (let to = 46; to <= bars.length; to++) inst.computeLast(columnsOf(bars, to), 'append');
    expect(inst.result().status).toEqual({ state: 'ok' });
    // Compare at the used length only: spare array capacity may differ.
    const n = bars.length;
    const slice = (r: ReturnType<IndicatorInstance['result']>) => ({
      values: Object.fromEntries(
        Object.entries(r.values).map(([id, a]) => [id, Array.from(a.subarray(0, n))]),
      ),
      colors: Object.fromEntries(
        Object.entries(r.colors).map(([id, a]) => [id, Array.from(a.subarray(0, n))]),
      ),
    });
    expect(slice(inst.result())).toEqual(slice(full));
  });
});

describe('Chart Patterns performance', () => {
  /** Seeded random walk (LCG), wide enough bars for sparse and dense pivots. */
  function randomWalk(n: number): BarStore {
    let seed = 7;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const time = new Float64Array(n);
    const open = new Float64Array(n);
    const high = new Float64Array(n);
    const low = new Float64Array(n);
    const close = new Float64Array(n);
    const volume = new Float64Array(n);
    let p = 100;
    for (let i = 0; i < n; i++) {
      open[i] = p;
      p = Math.max(1, p * (1 + (rand() - 0.5) * 0.02));
      close[i] = p;
      high[i] = Math.max(open[i]!, p) * 1.002;
      low[i] = Math.min(open[i]!, p) * 0.998;
      time[i] = i * 60;
      volume[i] = 1;
    }
    const store = new BarStore();
    store.setAll({ time, open, high, low, close, volume });
    return store;
  }

  it('is fast for 40k bars, however far apart the pivots are', () => {
    const bars = randomWalk(40_000);
    for (const deviation of [5, 30]) {
      const t0 = Date.now();
      const inst = new IndicatorInstance(CHART_PATTERNS, { deviation });
      inst.computeAll(bars);
      const ms = Date.now() - t0;
      expect(inst.result().status).toEqual({ state: 'ok' });
      expect(ms).toBeLessThan(1500);
    }
  });
});

describe('pattern geometry helpers', () => {
  const anchors: PatternPivot[] = [
    { bar: 10, price: 100, dir: -1 },
    { bar: 30, price: 110, dir: 1 },
    { bar: 60, price: 104, dir: -1 },
  ];

  it('interpolates anchors piecewise and clamps at the ends', () => {
    expect(interpAnchors(anchors, 5)).toBe(100);
    expect(interpAnchors(anchors, 10)).toBe(100);
    expect(interpAnchors(anchors, 20)).toBeCloseTo(105, 10);
    expect(interpAnchors(anchors, 45)).toBeCloseTo(107, 10);
    expect(interpAnchors(anchors, 60)).toBe(104);
    expect(interpAnchors(anchors, 90)).toBe(104);
  });

  it('evaluates fitted lines and anchor boundaries', () => {
    const fit = { slope: 0.5, intercept: 90 };
    expect(
      patternBoundary(
        {
          kind: 'ascendingTriangle',
          category: 1,
          startBar: 0,
          endBar: 60,
          labelBar: 60,
          pivots: anchors,
          highAnchors: anchors,
          lowAnchors: anchors,
          fitHigh: fit,
          fitLow: null,
        },
        40,
        true,
      ),
    ).toBe(110);
    expect(
      patternBoundary(
        {
          kind: 'ascendingTriangle',
          category: 1,
          startBar: 0,
          endBar: 60,
          labelBar: 60,
          pivots: anchors,
          highAnchors: anchors,
          lowAnchors: anchors,
          fitHigh: null,
          fitLow: null,
        },
        20,
        false,
      ),
    ).toBeCloseTo(105, 10);
  });
});
