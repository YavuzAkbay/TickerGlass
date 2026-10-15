import { beforeEach, describe, expect, it } from 'vitest';
import { Geometry } from '../geometry';
import type { DrawingBarData, DrawingPoint } from '../types';
import { patternBars } from './bars-pattern';
import { FORECAST_DEFAULTS, forecastLayout, forecastResult } from './forecast';
import { ghostCandles, ghostSeed, mulberry32 } from './ghost-feed';
import { projectionSector } from './projection';
import {
  FORMAT,
  makeDrawing,
  makeView,
  N,
  pt,
  recordingContext,
  SELECTED,
  START,
  tool,
} from './test-utils';
import { clearVolumeProfileCache } from './volume-profile';
import { VP_DEFAULTS, vpLayout } from './vp-common';

const view = makeView();
const { X, Y } = view;
const TOL = 4;
const D = 86_400;

type Bar = { o: number; h: number; l: number; c: number; v: number };

/** N bars: flat 50 with zero volume unless `at` overrides them. */
function makeBars(at: Record<number, Bar> = {}, base: Bar = { o: 50, h: 50, l: 50, c: 50, v: 0 }) {
  const list = Array.from({ length: N }, (_, i) => at[i] ?? base);
  return {
    length: N,
    time: list.map((_, i) => START + i * D),
    open: list.map((b) => b.o),
    high: list.map((b) => b.h),
    low: list.map((b) => b.l),
    close: list.map((b) => b.c),
    volume: list.map((b) => b.v),
  } satisfies DrawingBarData;
}

function setup(type: string, points: DrawingPoint[], style = {}, bars?: DrawingBarData) {
  const d = makeDrawing(type, points, style);
  const g = new Geometry();
  g.update(
    d,
    view.pane,
    { timeline: view.timeline, timeScale: view.ts, width: 800, ...(bars ? { bars } : {}) },
    FORMAT,
  );
  const def = tool(type);
  return { d, g, def, at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL) };
}

function rendered(type: string, points: DrawingPoint[], style = {}, bars?: DrawingBarData) {
  const s = setup(type, points, style, bars);
  const rec = recordingContext();
  s.def.render(rec.rc, s.g, s.d.style, SELECTED);
  return { ...s, ...rec };
}

beforeEach(() => clearVolumeProfileCache());

// ------------------------------------------------------------ volume profile

/**
 * Bars 20..24 (rows 4 => row size 5 over 40..60):
 * 20 up   [40,60] vol 40 -> 10 per row;  22 down [50,55] vol 30 -> row 2;
 * 24 up   [45,50] vol 20 -> row 1;       21, 23 no volume.
 * Totals [10,30,40,10]: POC row 2 (52.5), VA rows 0..2 -> VAH 55, VAL 40.
 */
const VP_BARS = makeBars({
  20: { o: 41, h: 60, l: 40, c: 55, v: 40 },
  22: { o: 56, h: 55, l: 50, c: 51, v: 30 },
  24: { o: 46, h: 50, l: 45, c: 48, v: 20 },
});
const VP_STYLE = { rows: 4, widthPercent: 100 };

describe('fixed range volume profile', () => {
  it('lays out the range, POC and value area of the anchored bars', () => {
    const { g, d } = setup('fixed-range-vp', [pt(24, 10), pt(20, 90)], VP_STYLE, VP_BARS);
    const L = vpLayout(g, d.style as typeof VP_DEFAULTS, 20, 24)!;
    expect([L.left, L.right, L.top, L.bottom]).toEqual([X(20), X(24), Y(60), Y(40)]);
    expect([L.pocY, L.vahY, L.valY]).toEqual([Y(52.5), Y(55), Y(40)]);
    // Left placement: grows right from the range start over 100% of its width.
    expect([L.baseX, L.length]).toEqual([X(20), X(24) - X(20)]);
    const right = setup(
      'fixed-range-vp',
      [pt(20, 0), pt(24, 0)],
      { ...VP_STYLE, placement: 'right' },
      VP_BARS,
    );
    const R = vpLayout(right.g, right.d.style as typeof VP_DEFAULTS, 20, 24)!;
    expect([R.baseX, R.length]).toEqual([X(24), -(X(24) - X(20))]);
  });

  it('renders rows, POC and VA lines; nothing without bars', () => {
    const { calls } = rendered('fixed-range-vp', [pt(20, 0), pt(24, 0)], VP_STYLE, VP_BARS);
    // Background + 4 rows (row 2 has up and down parts, the others up only).
    expect(calls.filter((c) => c === 'fillRect')).toHaveLength(1 + 5);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(3);
    const empty = rendered('fixed-range-vp', [pt(20, 0), pt(24, 0)], VP_STYLE);
    expect(empty.calls).toEqual([]);
    expect(empty.at(X(22), Y(52.5))).toBeNull();
    expect(empty.def.panes).toBe('main');
    expect(empty.def.axes).toBe('time');
  });

  it('hits histogram rows and lines strongly, the range background weakly', () => {
    const { at } = setup('fixed-range-vp', [pt(20, 0), pt(24, 0)], VP_STYLE, VP_BARS);
    expect(at(X(22), Y(52.5))).toEqual({ kind: 'body' }); // POC
    expect(at(X(23), Y(55))).toEqual({ kind: 'body' }); // VAH
    // Row 2 spans the full 40 px; row 3 (55..60) only 10 px.
    expect(at(X(20) + 35, Y(51))).toEqual({ kind: 'body' });
    expect(at(X(20) + 5, Y(57.5))).toEqual({ kind: 'body' });
    expect(at(X(20) + 30, Y(57.5))).toEqual({ kind: 'body', weak: true });
    expect(at(X(27), Y(57.5))).toBeNull();
    expect(at(X(22), Y(70))).toBeNull();
  });

  it('puts handles on the POC, extends lines on request, culls off-screen ranges', () => {
    const { def, g, d } = setup('fixed-range-vp', [pt(20, 0), pt(24, 0)], VP_STYLE, VP_BARS);
    const hs = def.handles!(g, d.style);
    expect(hs.map((h) => [h.x, h.y])).toEqual([
      [X(20), Y(52.5)],
      [X(24), Y(52.5)],
    ]);
    expect(def.priceAxisLabels!(d, d.style, SELECTED)).toEqual([]);
    expect(def.isVisible!(g, d.style)).toBe(true);
    // Bars 0..4 lie left of the pane.
    const early = makeBars({ 2: { o: 41, h: 60, l: 40, c: 55, v: 40 } });
    expect(X(4)).toBeLessThan(-20);
    const off = setup('fixed-range-vp', [pt(0, 0), pt(4, 0)], VP_STYLE, early);
    expect(off.def.isVisible!(off.g, off.d.style)).toBe(false);
    const ext = setup(
      'fixed-range-vp',
      [pt(0, 0), pt(4, 0)],
      { ...VP_STYLE, extendPoc: true },
      early,
    );
    expect(ext.def.isVisible!(ext.g, ext.d.style)).toBe(true);
    // Equal rows: POC tie goes to row 1 (45..50) -> 47.5.
    expect(ext.at(X(60), Y(47.5))).toEqual({ kind: 'body' });
    expect(off.def.isVisible!(setup('fixed-range-vp', [pt(20, 0), pt(24, 0)]).g, d.style)).toBe(
      false,
    );
  });
});

describe('anchored volume profile', () => {
  it('profiles from the anchor bar to the last bar', () => {
    const { def, g, d, at } = setup('anchored-vp', [pt(20, 0)], VP_STYLE, VP_BARS);
    expect(def.creation).toEqual({ kind: 'click' });
    const L = vpLayout(g, d.style as typeof VP_DEFAULTS, 20, N - 1)!;
    expect([L.left, L.right, L.pocY]).toEqual([X(20), X(N - 1), Y(52.5)]);
    expect(at(X(50), Y(52.5))).toEqual({ kind: 'body' });
    expect(def.handles!(g, d.style)).toEqual([{ x: X(20), y: Y(52.5), cursor: 'ew-resize' }]);
    expect(def.isVisible!(g, d.style)).toBe(true);
    const rec = recordingContext();
    def.render(rec.rc, g, d.style, SELECTED);
    expect(rec.calls).toContain('fillRect');
    // Anchor after the last bar or without data: nothing.
    const past = setup('anchored-vp', [pt(N + 5, 0)], VP_STYLE, VP_BARS);
    expect(past.def.isVisible!(past.g, past.d.style)).toBe(false);
    expect(rendered('anchored-vp', [pt(20, 0)], VP_STYLE).calls).toEqual([]);
  });

  it('follows new data at the last bar', () => {
    const bars = makeBars({ 20: { o: 41, h: 60, l: 40, c: 55, v: 40 } });
    const a = setup('anchored-vp', [pt(20, 0)], VP_STYLE, bars);
    const before = vpLayout(a.g, a.d.style as typeof VP_DEFAULTS, 20, N - 1)!.profile.totalVolume;
    expect(before).toBe(40);
    bars.volume[N - 1] = 10;
    const after = vpLayout(a.g, a.d.style as typeof VP_DEFAULTS, 20, N - 1)!.profile.totalVolume;
    expect(after).toBe(50);
  });
});

// ------------------------------------------------------------ forecast

describe('forecast', () => {
  const quiet = { o: 50, h: 55, l: 45, c: 50, v: 1 };

  it('evaluates success, failure and pending', () => {
    const hit = makeBars({ 26: { ...quiet, h: 61 } }, quiet);
    expect(forecastResult(hit, 20, 30, 50, 60)).toEqual({ status: 'success', hitBar: 26 });
    // Reached after the target bar: failure.
    expect(forecastResult(hit, 20, 25, 50, 60)).toEqual({ status: 'failure', hitBar: -1 });
    // Target bar not in the data yet: pending.
    expect(forecastResult(makeBars({}, quiet), 20, 120, 50, 60).status).toBe('pending');
    // The source bar itself does not count; downward targets use lows.
    const down = makeBars({ 20: { ...quiet, l: 30 }, 25: { ...quiet, l: 39 } }, quiet);
    expect(forecastResult(down, 20, 30, 50, 40)).toEqual({ status: 'success', hitBar: 25 });
    expect(forecastResult(down, 20, 24, 50, 40).status).toBe('failure');
    // Target not after the source.
    expect(forecastResult(down, 30, 20, 50, 40).status).toBe('pending');
  });

  it('labels change, bars and time with the status colour', () => {
    const bars = makeBars({ 26: { ...quiet, h: 61 } }, quiet);
    const { texts, g, d } = rendered('forecast', [pt(20, 50), pt(30, 60)], {}, bars);
    // +10 = +20% of 50, 10 bars = 10 days.
    expect(texts).toEqual(['+10.00 (20.00%)', '10 bars, 1w 3d', 'Success']);
    expect(forecastLayout(g, d.style as typeof FORECAST_DEFAULTS)!.color).toBe(
      FORECAST_DEFAULTS.successColor,
    );
    const fail = setup('forecast', [pt(20, 50), pt(30, 70)], {}, bars);
    expect(forecastLayout(fail.g, fail.d.style as typeof FORECAST_DEFAULTS)!.color).toBe(
      FORECAST_DEFAULTS.failureColor,
    );
    const pending = rendered('forecast', [pt(90, 50), pt(110, 70)], {}, bars);
    expect(pending.texts).toEqual(['+20.00 (40.00%)', '20 bars, 2w 6d']);
    expect(rendered('forecast', [pt(20, 50), pt(30, 60)]).calls).toEqual([]);
  });

  it('hits the line and the label', () => {
    const bars = makeBars({}, quiet);
    const { at, def, g, d } = setup('forecast', [pt(20, 50), pt(30, 60)], {}, bars);
    expect(at(X(25), Y(55))).toEqual({ kind: 'body' });
    // Label above-right of the target (upward forecast).
    expect(at(X(30) + 14, Y(60) - 14)).toEqual({ kind: 'body' });
    expect(at(X(25), Y(40))).toBeNull();
    expect(def.isVisible!(g, d.style)).toBe(true);
    const far = setup('forecast', [pt(-500, 50), pt(-480, 60)], {}, bars);
    expect(far.def.isVisible!(far.g, far.d.style)).toBe(false);
  });
});

// ------------------------------------------------------------ projection

describe('projection', () => {
  const bars = makeBars();
  // Origin (X20, Y50); leg 1 +100 px / -40 px (price 60), leg 2 +100 / +40 (price 40).
  const P = [pt(20, 50), pt(30, 60), pt(30, 40)];

  it('builds the sector at the origin between the legs', () => {
    const { g } = setup('projection', P, {}, bars);
    const sc = projectionSector(g)!;
    expect([sc.cx, sc.cy]).toEqual([X(20), Y(50)]);
    expect(sc.r).toBeCloseTo(Math.hypot(100, 40), 9);
    expect(sc.start).toBeCloseTo(Math.atan2(-40, 100), 9);
    expect(sc.end).toBeCloseTo(Math.atan2(40, 100), 9);
    expect(sc.anticlockwise).toBe(false);
  });

  it('labels each leg with its change from the origin', () => {
    const { texts, calls } = rendered('projection', P, {}, bars);
    expect(texts).toEqual(['+10.00 (20.00%)', '-10.00 (-20.00%)']);
    expect(calls).toContain('arc');
    expect(rendered('projection', P).calls).toEqual([]);
  });

  it('hits legs and arc strongly, the sector weakly', () => {
    const { at, def, g, d } = setup('projection', P, {}, bars);
    expect(at(X(25), Y(55))).toEqual({ kind: 'body' });
    expect(at(X(20) + Math.hypot(100, 40), Y(50))).toEqual({ kind: 'body' });
    expect(at(X(20) + 50, Y(50))).toEqual({ kind: 'body', weak: true });
    expect(at(X(20) - 50, Y(50))).toBeNull();
    expect(def.isVisible!(g, d.style)).toBe(true);
  });
});

// ------------------------------------------------------------ bars pattern

describe('bars pattern', () => {
  const bars = makeBars({
    20: { o: 50, h: 55, l: 45, c: 52, v: 1 },
    21: { o: 52, h: 58, l: 50, c: 56, v: 1 },
    22: { o: 56, h: 57, l: 48, c: 49, v: 1 },
  });
  const ohlc = (b: { open: number; high: number; low: number; close: number }) => [
    b.open,
    b.high,
    b.low,
    b.close,
  ];

  it('derives the copy origin one bar after the range at the last close', () => {
    const { def, g, d } = setup('bars-pattern', [pt(22, 10), pt(20, 90)], {}, bars);
    const out = def.completePoints!(d.points, g, d.style);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ time: START + 23 * D, price: 49 });
  });

  it('copies, mirrors and flips the source bars', () => {
    const { g } = setup('bars-pattern', [pt(20, 0), pt(22, 0), pt(23, 49)], {}, bars);
    // Shift 49 - open(20) = -1.
    expect(patternBars(g, { mirrored: false, flipped: false }, 49).map(ohlc)).toEqual([
      [49, 54, 44, 51],
      [51, 57, 49, 55],
      [55, 56, 47, 48],
    ]);
    // Mirror: bars 22, 21, 20 with open/close swapped; reference close(22) = 49.
    expect(patternBars(g, { mirrored: true, flipped: false }, 49).map(ohlc)).toEqual([
      [49, 57, 48, 56],
      [56, 58, 50, 52],
      [52, 55, 45, 50],
    ]);
    // Flip around open(20) = 50, then shift -1: v -> 99 - v, high/low swap.
    expect(patternBars(g, { mirrored: false, flipped: true }, 49).map(ohlc)[0]).toEqual([
      49, 54, 44, 47,
    ]);
  });

  it('reuses its bar objects between calls (no per-call allocation)', () => {
    const { g } = setup('bars-pattern', [pt(20, 0), pt(22, 0), pt(23, 49)], {}, bars);
    const s = { mirrored: false, flipped: false };
    const first = patternBars(g, s, 49)[0];
    expect(patternBars(g, s, 49)[0]).toBe(first);
  });

  it('hits copied bars strongly, the copy box weakly; renders nothing without data', () => {
    const P = [pt(20, 0), pt(22, 0), pt(23, 49)];
    const { at, def, g, d } = setup('bars-pattern', P, {}, bars);
    expect(at(X(23), Y(50))).toEqual({ kind: 'body' });
    expect(at(X(24), Y(56))).toEqual({ kind: 'body' });
    expect(at(X(23), Y(56))).toEqual({ kind: 'body', weak: true });
    expect(at(X(30), Y(50))).toBeNull();
    expect(def.priceAxisLabels!(d, d.style, SELECTED)).toEqual([
      { value: 49, color: d.style.lineColor },
    ]);
    expect(def.isVisible!(g, d.style)).toBe(true);
    const line = setup('bars-pattern', P, { mode: 'line' }, bars);
    // Close line through (X23, 51), (X24, 55).
    expect(line.at(X(23.5), Y(53))).toEqual({ kind: 'body' });
    for (const mode of ['hl', 'oc', 'line', 'candles']) {
      const r = rendered('bars-pattern', P, { mode }, bars);
      expect(r.calls).toContain('stroke');
    }
    expect(rendered('bars-pattern', P).calls).toEqual([]);
  });
});

// ------------------------------------------------------------ ghost feed

describe('ghost feed', () => {
  it('mulberry32 is deterministic in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(xs.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });

  it('generates one candle per bar along each segment', () => {
    // No noise: closes on the segment, opens chain from the previous close.
    const c = ghostCandles([0, 4], [10, 18], 1, 0);
    expect(c.map((k) => [k.logical, k.open, k.close, k.high, k.low])).toEqual([
      [1, 10, 12, 12, 10],
      [2, 12, 14, 14, 12],
      [3, 14, 16, 16, 14],
      [4, 16, 18, 18, 16],
    ]);
    expect(ghostCandles([0, 3, 5], [10, 20, 15], 1, 1)).toHaveLength(5);
    expect(ghostCandles([0, 10], [10, 20], 7, 1)).toHaveLength(10);
    expect(ghostCandles([3, 3], [10, 20], 7, 1)).toHaveLength(1);
    // Noise: deterministic per seed, segment ends exact.
    const n1 = ghostCandles([0, 10], [10, 20], 7, 2);
    expect(ghostCandles([0, 10], [10, 20], 7, 2)).toEqual(n1);
    expect(ghostCandles([0, 10], [10, 20], 8, 2)).not.toEqual(n1);
    expect(n1[9]!.close).toBe(20);
    expect(
      n1.every((k) => k.high >= Math.max(k.open, k.close) && k.low <= Math.min(k.open, k.close)),
    ).toBe(true);
  });

  it('fixes the seed at creation and renders the candles', () => {
    const bars = makeBars();
    const P = [pt(20, 50), pt(30, 60), pt(35, 55)];
    const { def, g, d, at } = setup('ghost-feed', P, {}, bars);
    expect(def.creation).toEqual({ kind: 'multi', min: 2 });
    expect(d.style.seed).toBe(0);
    def.completePoints!(d.points, g, d.style);
    const seed = d.style.seed as number;
    expect(seed).toBeGreaterThan(0);
    def.completePoints!(d.points, g, d.style);
    expect(d.style.seed).toBe(seed);
    expect(ghostSeed(0, P[0])).toBe(ghostSeed(0, P[0]));
    expect(ghostSeed(0, P[0])).toBeGreaterThan(0);

    const rec = recordingContext();
    def.render(rec.rc, g, d.style, SELECTED);
    // 15 candles: wick + body each; dashed path while selected.
    expect(rec.calls.filter((c) => c === 'fillRect')).toHaveLength(30);
    expect(rec.calls).toContain('stroke');
    expect(at(X(25), Y(55))).toEqual({ kind: 'body' });
    expect(at(X(25), Y(90))).toBeNull();
    expect(rendered('ghost-feed', P).calls).toEqual([]);
    const far = setup('ghost-feed', [pt(-500, 50), pt(-480, 60)], {}, bars);
    expect(far.def.isVisible!(far.g, far.d.style)).toBe(false);
  });
});
