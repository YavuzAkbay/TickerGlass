import { describe, expect, it } from 'vitest';
import type { DrawingPoint } from '../types';
import { cycleRange } from './cyclic-lines';
import { defaultGannFanLevels, defaultGannLevels, gannRatioText } from './gann-common';
import { priceBarRatio } from './gann-square-fixed';
import { sinePrice } from './sine-line';
import {
  geometryOf,
  makeDrawing,
  makeView,
  pt,
  recordingContext,
  SELECTED,
  tool,
} from './test-utils';

const { X, Y } = makeView();
const TOL = 4;
const BODY = { kind: 'body' };
const WEAK = { kind: 'body', weak: true };

function setup(type: string, points: DrawingPoint[], style = {}) {
  const d = makeDrawing(type, points, style);
  const g = geometryOf(d);
  const def = tool(type);
  return {
    d,
    g,
    def,
    at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL),
    visible: () => def.isVisible!(g, d.style),
    draw: () => {
      const r = recordingContext();
      def.render(r.rc, g, d.style, SELECTED);
      return {
        texts: r.texts,
        count: (name: string) => r.calls.filter((c) => c === name).length,
      };
    },
  };
}

const move = (type: string, start: DrawingPoint[], handle: number, target: DrawingPoint) => {
  const d = makeDrawing(type, start);
  const g = geometryOf(d);
  const p = g.toPixel(target);
  return tool(type).moveHandle!({
    start,
    handle,
    target,
    x: p.x,
    y: p.y,
    geometry: g,
    style: d.style,
  });
};

describe('gann helpers', () => {
  it('ratio labels, default levels and fans', () => {
    expect(gannRatioText(1)).toBe('1x1');
    expect(gannRatioText(2)).toBe('2x1');
    expect(gannRatioText(0.25)).toBe('1x4');
    expect(gannRatioText(1 / 3)).toBe('1x3');
    expect(defaultGannLevels().map((l) => l.value)).toEqual([0, 0.25, 0.382, 0.5, 0.618, 0.75, 1]);
    expect(defaultGannFanLevels().map((l) => gannRatioText(l.value))).toEqual([
      '1x8',
      '1x4',
      '1x3',
      '1x2',
      '1x1',
      '2x1',
      '3x1',
      '4x1',
      '8x1',
    ]);
  });
});

describe('gann box', () => {
  // Box (20, 80)-(40, 40): 200 x 160 px; price level v at y = Y(80) + 160 v.
  const pts = [pt(20, 80), pt(40, 40)];

  it('price/time grid strong, fill weak, angles optional', () => {
    const { at, def, visible } = setup('gann-box', pts);
    expect(def.group).toBe('fib');
    expect(at(X(30), Y(60))).toEqual(BODY); // 0.5 / 0.5
    expect(at(X(25), Y(70))).toEqual(BODY); // time 0.25
    expect(at(X(32), Y(80 - 40 * 0.382))).toEqual(BODY); // price 0.382
    expect(at(X(24), Y(72))).toEqual(WEAK); // on a diagonal, angles off
    expect(at(X(50), Y(60))).toBeNull();
    expect(visible()).toBe(true);
    expect(setup('gann-box', pts, { showAngles: true }).at(X(24), Y(72))).toEqual(BODY);
    expect(setup('gann-box', pts, { fillBackground: false }).at(X(24), Y(77))).toBeNull();
  });

  it('labels on four sides; corner handles; offscreen', () => {
    const { draw, def, g, d } = setup('gann-box', pts);
    expect(draw().texts.filter((t) => t === '0.382')).toHaveLength(4);
    expect(def.handles!(g, d.style)).toHaveLength(4);
    expect(move('gann-box', pts, 2, pt(18, 30))).toEqual([pt(18, 80), pt(40, 30)]);
    expect(move('gann-box', pts, 3, pt(45, 90))).toEqual([pt(20, 90), pt(45, 40)]);
    expect(setup('gann-box', [pt(-500, 20), pt(-480, 30)]).visible()).toBe(false);
  });
});

describe('gann square', () => {
  // Origin (20, 40) bottom-left, corner (40, 80): 200 x 160 px, 1x1 = the diagonal.
  const pts = [pt(20, 40), pt(40, 80)];
  const only = (k: 'showLevels' | 'showFans' | 'showArcs') => ({
    showLevels: k === 'showLevels',
    showFans: k === 'showFans',
    showArcs: k === 'showArcs',
  });

  it('fans from the origin to the far edges, weak bands', () => {
    const { at } = setup('gann-square', pts, only('showFans'));
    expect(at(X(30), Y(60))).toEqual(BODY); // 1x1
    expect(at(X(27), Y(68))).toEqual(BODY); // 2x1 -> (X30, Y80)
    expect(at(X(30), Y(50))).toEqual(BODY); // 1x2 -> (X40, Y60)
    expect(at(X(26), Y(58))).toEqual(WEAK); // between 1x1 and 2x1
    expect(at(X(50), Y(60))).toBeNull(); // outside the box
  });

  it('quarter arcs in box units and the level grid', () => {
    const arcs = setup('gann-square', pts, only('showArcs'));
    const c = Math.SQRT1_2;
    expect(arcs.at(X(20 + 20 * c), Y(40 + 40 * c))).toEqual(BODY); // arc 1
    expect(arcs.at(X(20 + 0.88 * 20 * c), Y(40 + 0.88 * 40 * c))).toBeNull();
    expect(setup('gann-square', pts, only('showLevels')).at(X(25), Y(50))).toEqual(BODY);
  });

  it('labels, corner handles, offscreen', () => {
    const { draw, def, g, d } = setup('gann-square', pts);
    const texts = draw().texts;
    expect(texts).toContain('1x8');
    expect(texts).toContain('8x1');
    expect(def.handles!(g, d.style)).toHaveLength(4);
    expect(setup('gann-square', [pt(-500, 20), pt(-480, 30)]).visible()).toBe(false);
  });
});

describe('gann square fixed', () => {
  it('creation makes the box square on screen; drags keep the price/bar ratio', () => {
    const d = makeDrawing('gann-square-fixed', [pt(20, 40), pt(40, 50)]);
    const g = geometryOf(d);
    // 20 bars = 200 px wide -> 200 px = 50 price high, above.
    const out = tool('gann-square-fixed').completePoints!(d.points, g, d.style);
    expect(out[0]).toEqual(pt(20, 40));
    expect(out[1]!.time).toBe(pt(40, 0).time);
    expect(out[1]!.price).toBeCloseTo(90, 9);
    const sq = [pt(20, 40), pt(40, 90)];
    expect(priceBarRatio(sq[0]!, sq[1]!, g)).toBeCloseTo(2.5, 9);
    // Anchor 2 to bar 30 below anchor 1: 10 bars * 2.5 = 25 below.
    const m1 = move('gann-square-fixed', sq, 1, pt(30, 10));
    expect(m1[0]).toEqual(sq[0]);
    expect(m1[1]!.time).toBe(pt(30, 0).time);
    expect(m1[1]!.price).toBeCloseTo(15, 9);
    // Anchor 1 to bar 30 above anchor 2: 10 bars -> 25 above 90.
    const m0 = move('gann-square-fixed', sq, 0, pt(30, 95));
    expect(m0[0]!.price).toBeCloseTo(115, 9);
    expect(m0[1]).toEqual(sq[1]);
  });
});

describe('gann fan', () => {
  // Origin (20, 40), 1x1 through (40, 80).
  const pts = [pt(20, 40), pt(40, 80)];

  it('rays past anchor 2 to the pane edge, weak bands', () => {
    const { at, visible, draw } = setup('gann-fan', pts);
    expect(at(X(45), Y(90))).toEqual(BODY); // 1x1 beyond anchor 2
    expect(at(X(25), Y(60))).toEqual(BODY); // 2x1
    expect(at(X(26), Y(58))).toEqual(WEAK); // between 1x1 and 2x1
    expect(at(X(10), Y(60))).toBeNull(); // behind the origin
    expect(visible()).toBe(true);
    expect(draw().texts).toEqual(defaultGannFanLevels().map((l) => gannRatioText(l.value)));
    expect(setup('gann-fan', [pt(-500, 20), pt(-520, 30)]).visible()).toBe(false);
  });
});

describe('cyclic lines', () => {
  it('cycleRange', () => {
    expect(cycleRange(100, 50, 0, 800)).toEqual({ from: 0, to: 14 });
    expect(cycleRange(100, 50, 300, 800)).toEqual({ from: 4, to: 14 });
    expect(cycleRange(500, -100, 0, 800)).toEqual({ from: 0, to: 5 });
    expect(cycleRange(-100, -10, 0, 800)).toBeNull();
    expect(cycleRange(100, 0, 0, 800)).toEqual({ from: 0, to: 0 });
  });

  it('vertical lines every cycle from anchor 1 onward', () => {
    const { at, visible, draw } = setup('cyclic-lines', [pt(20, 50), pt(30, 50)]);
    expect(at(X(50), 100)).toEqual(BODY);
    expect(at(X(20), 390)).toEqual(BODY);
    expect(at(X(55), 100)).toBeNull();
    expect(at(X(10), 100)).toBeNull(); // before anchor 1
    expect(visible()).toBe(true);
    let n = 0;
    for (let k = 0; X(20 + 10 * k) <= 801; k++) n++;
    expect(draw().count('moveTo')).toBe(n);
    expect(setup('cyclic-lines', [pt(-500, 20), pt(-480, 30)]).visible()).toBe(true);
    expect(setup('cyclic-lines', [pt(-500, 20), pt(-520, 30)]).visible()).toBe(false);
  });
});

describe('time cycles', () => {
  // Cycle 100 px (10 bars), radius 50 px, baseline Y(50) = 200 px.
  const pts = [pt(20, 50), pt(30, 60)];

  it('semicircles repeating along the baseline', () => {
    const { at, visible } = setup('time-cycles', pts);
    expect(at(X(25), Y(62.5))).toEqual(BODY); // top of cycle 0
    expect(at(X(45), Y(62.5))).toEqual(BODY); // top of cycle 2
    expect(at(X(30), Y(50))).toEqual(BODY); // cycle point on the baseline
    expect(at(X(25), Y(55))).toEqual(WEAK); // inside
    expect(at(X(25), Y(40))).toBeNull(); // other side of the baseline
    expect(at(X(15), Y(55))).toBeNull(); // before anchor 1
    expect(visible()).toBe(true);
    expect(setup('time-cycles', [pt(20, 50), pt(30, 40)]).at(X(25), Y(37.5))).toEqual(BODY);
    expect(setup('time-cycles', [pt(-500, 20), pt(-520, 30)]).visible()).toBe(false);
    expect(setup('time-cycles', [pt(20, 300), pt(30, 310)]).visible()).toBe(false);
  });
});

describe('sine line', () => {
  it('sinePrice through peak and trough', () => {
    expect(sinePrice(0, 80, 10, 20, 0)).toBeCloseTo(80, 9);
    expect(sinePrice(0, 80, 10, 20, 10)).toBeCloseTo(20, 9);
    expect(sinePrice(0, 80, 10, 20, 5)).toBeCloseTo(50, 9);
    expect(sinePrice(0, 80, 10, 20, 20)).toBeCloseTo(80, 9);
    expect(sinePrice(0, 80, 10, 20, -10)).toBeCloseTo(20, 9);
  });

  it('wave across the pane, polyline hits', () => {
    // Peak (20, 80), trough (30, 40): period 20 bars.
    const { at, visible, d, g, def } = setup('sine-line', [pt(20, 80), pt(30, 40)]);
    expect(at(X(25), Y(60))).toEqual(BODY);
    expect(at(X(40), Y(80))).toEqual(BODY);
    expect(at(X(50), Y(40))).toEqual(BODY);
    expect(at(X(25), Y(80))).toBeNull();
    expect(visible()).toBe(true);
    expect(def.handles).toBeUndefined();
    expect(def.hitTest(g, d.style, X(70), Y(40), TOL)).toEqual(BODY); // trough at bar 70
    expect(setup('sine-line', [pt(20, 300), pt(30, 250)]).visible()).toBe(false);
    expect(setup('sine-line', [pt(20, 80), pt(20, 40)]).visible()).toBe(false);
  });
});
