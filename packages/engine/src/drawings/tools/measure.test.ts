import { describe, expect, it } from 'vitest';
import type { DrawingLevel, DrawingPoint, HandleMoveArgs } from '../types';
import { defaultFibLevels, fibExtensionPrice, fibRetracementPrice } from './fib-common';
import { measureStats } from './measure-common';
import { POSITION_DEFAULT_BARS, POSITION_DEFAULTS, positionStats } from './position-common';
import {
  D,
  geometryOf,
  IDLE,
  makeDrawing,
  makeView,
  pt,
  recordingContext,
  SELECTED,
  START,
  tool,
} from './test-utils';

const { X, Y } = makeView();
const TOL = 4;

function setup(type: string, points: DrawingPoint[], style = {}) {
  const d = makeDrawing(type, points, style);
  const g = geometryOf(d);
  const def = tool(type);
  return {
    d,
    g,
    def,
    at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL),
    move: (handle: number, target: DrawingPoint) =>
      def.moveHandle!({
        start: d.points,
        handle,
        target,
        x: g.toPixel(target).x,
        y: g.toPixel(target).y,
        geometry: g,
        style: d.style,
      } as HandleMoveArgs),
  };
}

describe('fib levels', () => {
  it('reference default levels and visibility', () => {
    const lv = defaultFibLevels();
    const visible = lv.filter((l) => l.visible).map((l) => l.value);
    expect(visible).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618, 2.618, 3.618, 4.236]);
    expect(lv.some((l) => !l.visible)).toBe(true);
    expect(defaultFibLevels()).not.toBe(lv); // fresh copies
  });

  it('retracement: level 0 at anchor 2, 1 at anchor 1; reverse swaps', () => {
    expect(fibRetracementPrice(10, 110, 0)).toBe(110);
    expect(fibRetracementPrice(10, 110, 1)).toBe(10);
    expect(fibRetracementPrice(10, 110, 0.618)).toBeCloseTo(48.2, 9);
    expect(fibRetracementPrice(10, 110, 1.618)).toBeCloseTo(-51.8, 9);
    expect(fibRetracementPrice(10, 110, 0, true)).toBe(10);
    expect(fibRetracementPrice(10, 110, 0.618, true)).toBeCloseTo(71.8, 9);
  });

  it('extension projects a->b from c', () => {
    expect(fibExtensionPrice(10, 30, 20, 0)).toBe(20);
    expect(fibExtensionPrice(10, 30, 20, 1)).toBe(40);
    expect(fibExtensionPrice(10, 30, 20, 1.618)).toBeCloseTo(52.36, 9);
  });
});

describe('fib retracement tool', () => {
  const pts = [pt(20, 20), pt(40, 60)];
  const only = (values: number[]): DrawingLevel[] =>
    values.map((value) => ({ value, color: '#fff', visible: true }));

  it('hits level lines strongly and the zone weakly', () => {
    const { at } = setup('fib-retracement', pts, { levels: only([0, 0.5, 1]) });
    expect(at(X(25), Y(60))).toEqual({ kind: 'body' }); // level 0
    expect(at(X(25), Y(40))).toEqual({ kind: 'body' }); // 0.5
    expect(at(X(38), Y(50))).toEqual({ kind: 'body', weak: true });
    expect(at(X(50), Y(40))).toBeNull(); // outside the x span
    const rev = setup('fib-retracement', pts, { levels: only([0.25]), reverse: true });
    expect(rev.at(X(38), Y(30))).toEqual({ kind: 'body' });
  });

  it('extend right reaches the pane edge', () => {
    const { at } = setup('fib-retracement', pts, { extendRight: true });
    expect(at(X(90), Y(60))).toEqual({ kind: 'body' });
  });

  it('renders visible levels with value(price) labels', () => {
    const { def, g, d } = setup('fib-retracement', pts, {
      levels: [...only([0, 0.5]), { value: 1, color: '#fff', visible: false }],
    });
    const { rc, texts } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(texts).toEqual(['0(60.00)', '0.5(40.00)']);
    const r2 = recordingContext();
    def.render(r2.rc, g, { ...d.style, levelsFormat: 'percents', showPrices: false }, IDLE);
    expect(r2.texts).toEqual(['0%', '50%']);
  });
});

describe('fib extension tool', () => {
  it('3 points; levels between anchors 2 and 3', () => {
    const def = tool('fib-extension');
    expect(def.creation).toEqual({ kind: 'points', count: 3 });
    const { at } = setup('fib-extension', [pt(10, 10), pt(20, 30), pt(30, 20)], {
      levels: [{ value: 1, color: '#fff', visible: true }],
      showTrendLine: false,
    });
    expect(at(X(25), Y(40))).toEqual({ kind: 'body' });
    expect(at(X(35), Y(40))).toBeNull();
  });

  it('a 2-anchor draft draws only the trend line', () => {
    const { def, g, d, at } = setup('fib-extension', [pt(10, 10), pt(20, 30)]);
    const { rc, calls, texts } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(1);
    expect(texts).toEqual([]);
    expect(at(X(15), Y(20))).toEqual({ kind: 'body' });
  });
});

describe('position stats', () => {
  it('sizes the position from account risk %', () => {
    const s = positionStats(100, 110, 95, POSITION_DEFAULTS); // 1000 account, 25%
    expect(s.riskAmount).toBe(250);
    expect(s.qty).toBe(50);
    expect(s.riskReward).toBe(2);
    expect(s.profitAmount).toBe(500);
    expect(s.lossAmount).toBe(250);
    expect(s.targetPercent).toBeCloseTo(10, 9);
    expect(s.stopPercent).toBeCloseTo(-5, 9);
  });

  it('currency risk, lot size and a zero stop distance', () => {
    const s = positionStats(100, 90, 104, {
      accountSize: 1000,
      lotSize: 10,
      risk: 40,
      riskUnit: 'currency',
    });
    expect(s.riskAmount).toBe(40);
    expect(s.qty).toBe(1);
    expect(s.riskReward).toBe(2.5);
    expect(s.profitAmount).toBe(100);
    const z = positionStats(100, 110, 100, POSITION_DEFAULTS);
    expect(z.qty).toBe(0);
    expect(z.riskReward).toBe(Infinity);
  });
});

describe('long / short position tools', () => {
  it('one click derives target above / stop below for long', () => {
    const def = tool('long-position');
    expect(def.creation).toEqual({ kind: 'click' });
    const d = makeDrawing('long-position', [pt(50, 50)]);
    const g = geometryOf(d);
    const out = def.completePoints!(d.points, g, d.style);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(pt(50, 50));
    expect(out[1]!.time).toBe(START + (50 + POSITION_DEFAULT_BARS) * D);
    expect(out[2]!.time).toBe(out[1]!.time);
    expect(out[1]!.price).toBeCloseTo(60, 9); // 10% of 400 px = 40 px = 10
    expect(out[2]!.price).toBeCloseTo(45, 9);
  });

  it('short position mirrors the levels', () => {
    const def = tool('short-position');
    const d = makeDrawing('short-position', [pt(50, 50)]);
    const out = def.completePoints!(d.points, geometryOf(d), d.style);
    expect(out[1]!.price).toBeCloseTo(40, 9);
    expect(out[2]!.price).toBeCloseTo(55, 9);
  });

  const pts = [pt(20, 50), pt(40, 70), pt(40, 40)];

  it('hit: entry line strong, zones weak', () => {
    const { at } = setup('long-position', pts);
    expect(at(X(30), Y(50))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(60))).toEqual({ kind: 'body', weak: true });
    expect(at(X(30), Y(45))).toEqual({ kind: 'body', weak: true });
    expect(at(X(30), Y(80))).toBeNull();
    expect(at(X(45), Y(50))).toBeNull();
  });

  it('handles: entry, target, stop, right edge', () => {
    const { def, g, d, move } = setup('long-position', pts);
    const hs = def.handles!(g, d.style);
    expect(hs.map((h) => [h.x, h.y])).toEqual([
      [X(20), Y(50)],
      [X(20), Y(70)],
      [X(20), Y(40)],
      [X(40), Y(50)],
    ]);
    expect(move(1, pt(5, 80))).toEqual([pts[0], pt(40, 80), pts[2]]);
    expect(move(2, pt(5, 30))).toEqual([pts[0], pts[1], pt(40, 30)]);
    expect(move(3, pt(60, 1))).toEqual([pts[0], pt(60, 70), pt(60, 40)]);
    expect(move(0, pt(25, 55))).toEqual([pt(25, 55), pts[1], pts[2]]);
  });

  it('renders target/stop labels; stats when selected; axis labels', () => {
    const { def, g, d } = setup('long-position', pts);
    const { rc, texts } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(texts).toEqual([
      'Target: 70.00 (40.00%) 20.00, Amount: 500.00',
      'Stop: 40.00 (-20.00%) 10.00, Amount: 250.00',
    ]);
    const r2 = recordingContext();
    def.render(r2.rc, g, d.style, SELECTED);
    expect(r2.texts.slice(2)).toEqual(['Qty: 25', 'Risk/Reward Ratio: 2.00']);
    expect(def.priceAxisLabels!(d, d.style, SELECTED).map((l) => l.value)).toEqual([50, 70, 40]);
    expect(def.priceAxisLabels!(d, d.style, IDLE)).toEqual([]);
    expect(def.shiftConstraint).toBe('none');
  });
});

describe('measure tools', () => {
  const pts = [pt(20, 50), pt(30, 40)];

  it('stats: price change, %, bars, time', () => {
    const { g } = setup('date-price-range', pts);
    const s = measureStats(g)!;
    expect(s.priceChange).toBe(-10);
    expect(s.percent).toBeCloseTo(-20, 9);
    expect(s.bars).toBe(10);
    expect(s.seconds).toBe(10 * D);
  });

  it('labels per kind', () => {
    const expected: Record<string, string[]> = {
      'price-range': ['-10.00 (-20.00%)'],
      'date-range': ['10 bars, 1w 3d'],
      'date-price-range': ['-10.00 (-20.00%)', '10 bars, 1w 3d'],
    };
    for (const [type, lines] of Object.entries(expected)) {
      const { def, g, d } = setup(type, pts);
      const { rc, texts } = recordingContext();
      def.render(rc, g, d.style, IDLE);
      expect(texts).toEqual(lines);
      expect(def.shiftConstraint).toBe('none');
    }
  });

  it('the measured box is a strong hit', () => {
    const { at } = setup('price-range', pts);
    expect(at(X(25), Y(45))).toEqual({ kind: 'body' });
    expect(at(X(35), Y(45))).toBeNull();
  });
});
