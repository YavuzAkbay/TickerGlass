import { describe, expect, it } from 'vitest';
import type { DrawingPoint } from '../types';
import { angleOnArc, defaultTimeZoneLevels, levelValueText } from './fib-common';
import { PHI, spiralRadius } from './fib-spiral';
import { rayToEdge, type Seg } from './fan-common';
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

describe('fib helpers', () => {
  it('level text, Fibonacci time zones and arc angles', () => {
    expect(levelValueText(0.618)).toBe('0.618');
    expect(levelValueText(0.618, 'percents')).toBe('61.8%');
    expect(defaultTimeZoneLevels().map((l) => l.value)).toEqual([
      0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89,
    ]);
    expect(angleOnArc(Math.PI / 2, 0, Math.PI, false)).toBe(true);
    expect(angleOnArc(-Math.PI / 2, 0, Math.PI, false)).toBe(false);
    expect(angleOnArc(-Math.PI / 4, 0, -Math.PI / 2, true)).toBe(true);
    expect(angleOnArc(Math.PI / 4, 0, -Math.PI / 2, true)).toBe(false);
  });

  it('rayToEdge: through the target and past the pane', () => {
    const g = geometryOf(makeDrawing('fib-speed-fan', [pt(20, 20), pt(40, 60)]));
    const out: Seg = [0, 0, 0, 0];
    const r = rayToEdge(g, 100, 200, 110, 200, out)!;
    expect(r[0]).toBe(100);
    expect(r[1]).toBe(200);
    expect(r[3]).toBe(200);
    expect(r[2]).toBeGreaterThan(800);
    expect(rayToEdge(g, 100, 200, 100, 200, out)).toBeNull();
  });
});

describe('fib channel', () => {
  // Base (20, 50)-(40, 50); anchor 3 at (30, 60): width 10 price, level v at 50 + 10 v.
  const pts = [pt(20, 50), pt(40, 50), pt(30, 60)];

  it('parallel level lines at multiples of the width, weak fill between', () => {
    const { at, def } = setup('fib-channel', pts);
    expect(def.group).toBe('fib');
    expect(at(X(30), Y(50))).toEqual(BODY); // 0
    expect(at(X(25), Y(55))).toEqual(BODY); // 0.5
    expect(at(X(35), Y(66.18))).toEqual(BODY); // 1.618
    expect(at(X(30), Y(81))).toEqual(WEAK); // between 2.618 and 3.618
    expect(at(X(30), Y(95))).toBeNull(); // past 4.236
    expect(at(X(50), Y(55))).toBeNull(); // past the anchors
    expect(setup('fib-channel', pts, { extendRight: true }).at(X(50), Y(55))).toEqual(BODY);
    expect(setup('fib-channel', pts, { fillBackground: false }).at(X(30), Y(81))).toBeNull();
  });

  it('slanted base: levels shift vertically in pixels', () => {
    // Base (20, 20)-(40, 60); anchor 3 (30, 50): base at bar 30 is 40, width 10.
    const { at } = setup('fib-channel', [pt(20, 20), pt(40, 60), pt(30, 50)]);
    expect(at(X(30), Y(45))).toEqual(BODY); // 0.5
    expect(at(X(20), Y(30))).toEqual(BODY); // level 1 at bar 20
  });

  it('renders the base for drafts, levels, fills and labels when complete', () => {
    expect(setup('fib-channel', pts.slice(0, 2)).draw().count('stroke')).toBe(1);
    const r = setup('fib-channel', pts).draw();
    // 11 visible reference levels: 11 lines, 10 bands.
    expect(r.count('stroke')).toBe(11);
    expect(r.count('fill')).toBe(10);
    expect(r.texts).toContain('0.618');
  });

  it('culling', () => {
    expect(setup('fib-channel', pts).visible()).toBe(true);
    const left = [pt(-200, 50), pt(-180, 50), pt(-190, 60)];
    expect(setup('fib-channel', left).visible()).toBe(false);
    expect(setup('fib-channel', left, { extendRight: true }).visible()).toBe(true);
  });
});

describe('fib time zone', () => {
  // Anchors at bars 20 and 25: zones at 20 + 5 n -> 20, 25, 30, 35, 45, 60, 85, (125...).
  const pts = [pt(20, 50), pt(25, 50)];

  it('vertical lines at the Fibonacci bar multiples', () => {
    const { at } = setup('fib-time-zone', pts);
    expect(at(X(45), Y(10))).toEqual(BODY); // n = 5
    expect(at(X(60), Y(90))).toEqual(BODY); // n = 8
    expect(at(X(85), Y(50))).toEqual(BODY); // n = 13
    expect(at(X(40), Y(10))).toBeNull(); // no zone at n = 4
    expect(at(X(22), Y(50))).toEqual(BODY); // trend line
    expect(setup('fib-time-zone', pts, { fillBackground: true }).at(X(40), Y(10))).toEqual(WEAK);
  });

  it('labels the visible zones with their numbers', () => {
    const r = setup('fib-time-zone', pts).draw();
    expect(r.texts).toEqual(['0', '1', '2', '3', '5', '8', '13']);
    expect(r.count('stroke')).toBe(8); // 7 zones in view + trend line
  });

  it('culling: later zones can reach into view', () => {
    expect(setup('fib-time-zone', [pt(-500, 50), pt(-475, 50)]).visible()).toBe(true); // 21: bar 25
    expect(setup('fib-time-zone', [pt(-500, 50), pt(-499, 50)]).visible()).toBe(false);
  });
});

describe('trend-based fib time', () => {
  // Move bars 20 -> 30 projected from bar 40: level v at bar 40 + 10 v.
  const pts = [pt(20, 50), pt(30, 60), pt(40, 40)];

  it('levels at anchor 3 + level * (anchor 2 - anchor 1) bars', () => {
    const { at } = setup('fib-trend-time', pts);
    expect(at(X(40), Y(90))).toEqual(BODY); // 0
    expect(at(X(46.18), Y(90))).toEqual(BODY); // 0.618
    expect(at(X(56.18), Y(90))).toEqual(BODY); // 1.618
    expect(at(X(48), Y(90))).toEqual(WEAK); // between 0.618 and 1
    expect(at(X(35), Y(50))).toEqual(BODY); // trend line b-c
    expect(at(X(70), Y(90))).toBeNull(); // past 2.618
  });

  it('two-anchor draft draws the trend line only', () => {
    const r = setup('fib-trend-time', pts.slice(0, 2)).draw();
    expect(r.count('stroke')).toBe(1);
    expect(r.count('fillText')).toBe(0);
  });

  it('culling', () => {
    expect(setup('fib-trend-time', pts).visible()).toBe(true);
    expect(setup('fib-trend-time', [pt(-300, 50), pt(-290, 60), pt(-280, 40)]).visible()).toBe(
      false,
    );
  });
});

describe('fib speed resistance fan', () => {
  // Box (20, 20)-(40, 60): price ray v through (40, 20 + 40 v); time ray v through (20 + 20 v, 60).
  const pts = [pt(20, 20), pt(40, 60)];

  it('price rays, time rays, grid and weak bands', () => {
    const { at } = setup('fib-speed-fan', pts);
    expect(at(X(30), Y(30))).toEqual(BODY); // price 0.5 halfway
    expect(at(X(60), Y(80))).toEqual(BODY); // price 1 (diagonal) extended
    expect(at(X(25), Y(40))).toEqual(BODY); // time 0.5 halfway
    expect(at(X(35), Y(30))).toEqual(BODY); // grid: price 0.25 horizontal
    expect(at(X(50), Y(72.5))).toEqual(WEAK); // between price 0.75 and 1
    expect(at(X(50), Y(10))).toBeNull(); // below price 0
    const noGrid = setup('fib-speed-fan', pts, { showGrid: false });
    expect(noGrid.at(X(35), Y(30))).toEqual(WEAK); // between price 0.25 and 0.382
  });

  it('renders grid, 14 rays, 12 bands and labels', () => {
    const r = setup('fib-speed-fan', pts).draw();
    expect(r.count('fill')).toBe(12);
    expect(r.count('stroke')).toBe(28); // 7 + 7 grid lines, 14 rays
    expect(r.texts.filter((t) => t === '0.382')).toHaveLength(2);
  });

  it('culling: rays pointing away from the pane', () => {
    expect(setup('fib-speed-fan', pts).visible()).toBe(true);
    // Origin far left, box opening further left: every ray points away.
    expect(setup('fib-speed-fan', [pt(-200, 50), pt(-220, 60)]).visible()).toBe(false);
  });
});

describe('fib circles', () => {
  // Diameter (20, 50)-(40, 50): centre (30, 50), level 1 radius 100 px.
  const pts = [pt(20, 50), pt(40, 50)];

  it('concentric circles around the midpoint', () => {
    const { at } = setup('fib-circles', pts);
    expect(at(X(30), Y(75))).toEqual(BODY); // level 1: 100 px = 25 price
    expect(at(X(35), Y(50))).toEqual(BODY); // level 0.5: 50 px = 5 bars (also trend line)
    expect(at(X(30), Y(50 + 12.5))).toEqual(BODY); // level 0.5 vertically
    expect(at(X(30) + 210, Y(50))).toEqual(WEAK); // between 1.618 and 2.618
    expect(at(X(30), Y(50) - 10)).toBeNull(); // inside 0.236
    expect(at(X(30) + 430, Y(50))).toBeNull(); // outside 4.236
  });

  it('renders circles, rings and labels', () => {
    const r = setup('fib-circles', pts).draw();
    expect(r.count('arc')).toBe(10 + 9 * 2);
    expect(r.count('fill')).toBe(9);
    expect(r.texts).toContain('4.236');
  });

  it('culling by the outer circle', () => {
    expect(setup('fib-circles', pts).visible()).toBe(true);
    expect(setup('fib-circles', [pt(-400, 50), pt(-398, 50)]).visible()).toBe(false);
  });
});

describe('fib speed resistance arcs', () => {
  // Centre (20, 50); anchor 2 (30, 60) above: radius 1 = hypot(100, 40) px; upper half.
  const pts = [pt(20, 50), pt(30, 60)];
  const R = Math.hypot(X(30) - X(20), Y(60) - Y(50));

  it('upper half circles around anchor 1', () => {
    const { at } = setup('fib-speed-arcs', pts);
    expect(at(X(20), Y(50) - R / 2)).toEqual(BODY); // 0.5 at the top
    expect(at(X(20) - R, Y(50))).toEqual(BODY); // 1 at its left end
    expect(at(X(20), Y(50) - R * 0.7)).toEqual(WEAK); // between 0.618 and 0.786
    expect(at(X(20), Y(50) + R / 2)).toBeNull(); // lower half not drawn
    const full = setup('fib-speed-arcs', pts, { fullCircles: true });
    expect(full.at(X(20), Y(50) + R / 2)).toEqual(BODY);
  });

  it('flips below when anchor 2 is below', () => {
    const { at } = setup('fib-speed-arcs', [pt(20, 50), pt(30, 40)]);
    expect(at(X(20), Y(50) + R / 2)).toEqual(BODY);
    expect(at(X(20), Y(50) - R / 2)).toBeNull();
  });

  it('renders levels up to 1 by default', () => {
    const r = setup('fib-speed-arcs', pts).draw();
    expect(r.count('fill')).toBe(5);
    expect(r.texts).toEqual(['0.236', '0.382', '0.5', '0.618', '0.786', '1']);
  });
});

describe('fib wedge', () => {
  // Apex (20, 50); side to (40, 50) (0 rad, 200 px); side to (20, 70) (up, -pi/2).
  const pts = [pt(20, 50), pt(40, 50), pt(20, 70)];
  const d = (r: number) => r / Math.SQRT2;

  it('arcs inside the wedge, sides and weak sectors', () => {
    const { at } = setup('fib-wedge', pts);
    expect(at(X(20) + d(100), Y(50) - d(100))).toEqual(BODY); // 0.5 at -45 deg
    expect(at(X(20) + d(100), Y(50) + d(100))).toBeNull(); // outside the wedge
    expect(at(X(20) + d(140), Y(50) - d(140))).toEqual(WEAK); // between 0.618 and 0.786
    expect(at(X(30), Y(50))).toEqual(BODY); // side to anchor 2
    expect(at(X(20), Y(60))).toEqual(BODY); // side towards anchor 3
    expect(at(X(20) + d(230), Y(50) - d(230))).toBeNull(); // past level 1
  });

  it('two-anchor draft draws the first side', () => {
    const { at, draw } = setup('fib-wedge', pts.slice(0, 2));
    expect(draw().count('stroke')).toBe(1);
    expect(at(X(30), Y(50))).toEqual(BODY);
  });

  it('renders arcs and sector fills', () => {
    const r = setup('fib-wedge', pts).draw();
    expect(r.count('fill')).toBe(5);
    expect(r.count('arc')).toBe(6 + 5 * 2);
  });
});

describe('fib spiral', () => {
  // Centre (50, 50), anchor 2 at 100 px to the right; radius x PHI per quarter turn.
  const pts = [pt(50, 50), pt(60, 50)];
  const px = (p: number) => p / 4; // px -> price units

  it('golden radius growth', () => {
    expect(spiralRadius(100, 0)).toBe(100);
    expect(spiralRadius(100, Math.PI / 2)).toBeCloseTo(100 * PHI, 9);
    expect(spiralRadius(100, Math.PI)).toBeCloseTo(100 * PHI * PHI, 9);
    expect(spiralRadius(100, -Math.PI / 2)).toBeCloseTo(100 / PHI, 9);
  });

  it('clockwise on screen by default; counterclockwise option', () => {
    const cw = setup('fib-spiral', pts);
    expect(cw.at(X(60), Y(50))).toEqual(BODY); // through anchor 2
    expect(cw.at(X(50), Y(50 - px(100 * PHI)))).toEqual(BODY); // +90 deg: down
    expect(cw.at(X(50), Y(50 + px(100 / PHI)))).toEqual(BODY); // -90 deg: up
    expect(cw.at(X(50), Y(50 + px(100 * PHI)))).toBeNull();
    const ccw = setup('fib-spiral', pts, { counterclockwise: true });
    expect(ccw.at(X(50), Y(50 + px(100 * PHI)))).toEqual(BODY);
    expect(ccw.at(X(50), Y(50 - px(100 * PHI)))).toBeNull();
  });

  it('renders the spiral and the radius line', () => {
    const r = setup('fib-spiral', pts).draw();
    expect(r.count('stroke')).toBe(2);
    expect(r.count('lineTo')).toBeGreaterThan(50);
  });

  it('visible in view', () => {
    expect(setup('fib-spiral', pts).visible()).toBe(true);
  });
});
