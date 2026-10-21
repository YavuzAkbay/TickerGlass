import { describe, expect, it } from 'vitest';
import { lineStats } from './measured-line';
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

function hit(type: string, points = [pt(20, 20), pt(40, 60)], style = {}, text = '') {
  const d = makeDrawing(type, points, style, text);
  const g = geometryOf(d);
  const def = tool(type);
  return { d, g, def, at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL) };
}

describe('ray / extended line', () => {
  it('ray extends right only by default', () => {
    const { at, def, g, d } = hit('ray');
    expect(def.defaults.extendRight).toBe(true);
    expect(def.defaults.extendLeft).toBe(false);
    expect(at(X(30), Y(40))).toEqual({ kind: 'body' });
    expect(at(X(50), Y(80))).toEqual({ kind: 'body' }); // past anchor 2
    expect(at(X(10), Y(0))).toBeNull(); // before anchor 1
    expect(
      def.isVisible!(geometryOf(makeDrawing('ray', [pt(-50, 20), pt(-40, 21)])), d.style),
    ).toBe(true);
    expect(g.points).toHaveLength(2);
  });

  it('extended line extends both ways', () => {
    const { at, def } = hit('extended-line');
    expect(def.defaults.extendLeft).toBe(true);
    expect(at(X(10), Y(0))).toEqual({ kind: 'body' });
    expect(at(X(50), Y(80))).toEqual({ kind: 'body' });
  });
});

describe('line culling (line-viewport intersection)', () => {
  it('rays and extended lines are visible only when they cross the pane', () => {
    const def = tool('ray');
    const vis = (points: ReturnType<typeof pt>[], style = {}) => {
      const d = makeDrawing('ray', points, style);
      return def.isVisible!(geometryOf(d), d.style);
    };
    // Pointing away from the pane (left of it, going left): culled.
    expect(vis([pt(-50, 50), pt(-60, 50)])).toBe(false);
    // Off to the left but pointing into it: visible.
    expect(vis([pt(-60, 50), pt(-50, 50)])).toBe(true);
    // Rising steeply above the pane: culled even though it extends right.
    expect(vis([pt(10, 150), pt(11, 200)])).toBe(false);
    // Extended both ways through the pane from far away: visible.
    expect(vis([pt(-300, 50), pt(-290, 50)], { extendLeft: true })).toBe(true);
    // A plain trend line far off screen: culled.
    expect(
      tool('trend-line').isVisible!(
        geometryOf(makeDrawing('trend-line', [pt(-90, 1), pt(-80, 2)])),
        {
          ...tool('trend-line').defaults,
        },
      ),
    ).toBe(false);
  });
});

describe('measured line', () => {
  it('computes price change, %, bars, time, angle and distance', () => {
    const { g } = hit('measured-line', [pt(20, 20), pt(40, 60)]);
    const s = lineStats(g)!;
    expect(s.priceChange).toBe(40);
    expect(s.percent).toBeCloseTo(200, 9);
    expect(s.bars).toBe(20);
    expect(s.seconds).toBe(20 * D);
    // 20 bars * 10 px right, 40 * 4 px up
    expect(s.distance).toBeCloseTo(Math.hypot(200, 160), 6);
    expect(s.angle).toBeCloseTo((Math.atan2(160, 200) * 180) / Math.PI, 6);
  });

  it('percent is NaN from a zero price; negative moves are signed', () => {
    const { g } = hit('measured-line', [pt(40, 0), pt(20, 10)]);
    const s = lineStats(g)!;
    expect(s.percent).toBeNaN();
    expect(s.bars).toBe(-20);
    expect(s.seconds).toBe(-20 * D);
  });

  it('renders the stats label with the enabled lines only', () => {
    const { d, g, def } = hit('measured-line');
    const { rc, texts } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(texts).toEqual(['+40.00 (200.00%)', '20 bars, 2w 6d', 'Distance: 256 px, 38.66°']);
    const r2 = recordingContext();
    def.render(r2.rc, g, { ...d.style, showDistance: false, showPercentChange: false }, IDLE);
    expect(r2.texts).toEqual(['+40.00', '20 bars, 2w 6d', '38.66°']);
  });

  it('hits the stats label as part of the drawing', () => {
    // Line rises (20 -> 60): the label sits below its midpoint (bar 30, price 40).
    const { at } = hit('measured-line');
    expect(at(X(30), Y(40) + 30)).toEqual({ kind: 'body' });
    expect(at(X(30), Y(40) + 200)).toBeNull();
    const none = hit('measured-line', undefined, {
      showPriceRange: false,
      showPercentChange: false,
      showBarsRange: false,
      showDateTimeRange: false,
      showDistance: false,
      showAngle: false,
    });
    expect(none.at(X(30), Y(40) + 30)).toBeNull();
  });

  it('hits the line', () => {
    const { at } = hit('measured-line');
    expect(at(X(30), Y(40))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(60))).toBeNull();
  });
});

describe('horizontal ray', () => {
  it('extends from the anchor to the right; text and price label', () => {
    const { at, def, d, g } = hit('horizontal-ray', [pt(30, 50)], {}, 'note');
    expect(at(X(80), Y(50))).toEqual({ kind: 'body' });
    expect(at(X(20), Y(50))).toBeNull();
    expect(at(X(30) + 10, Y(50) - 10)).toEqual({ kind: 'text' });
    expect(def.priceAxisLabels!(d, d.style, IDLE)).toEqual([{ value: 50, color: '#6E9BD6' }]);
    expect(def.isVisible!(g, d.style)).toBe(true);
    const off = geometryOf(makeDrawing('horizontal-ray', [pt(200, 50)]));
    expect(def.isVisible!(off, d.style)).toBe(false);
    const left = geometryOf(makeDrawing('horizontal-ray', [pt(-200, 50)]));
    expect(def.isVisible!(left, d.style)).toBe(true);
  });
});

describe('vertical line', () => {
  it('hits by x only, time-axis label, no price labels', () => {
    const { at, def, d, g } = hit('vertical-line', [pt(30, 50)]);
    expect(def.axes).toBe('time');
    expect(at(X(30) + 2, 5)).toEqual({ kind: 'body' });
    expect(at(X(32), 5)).toBeNull();
    expect(def.timeAxisLabels!(d, d.style, IDLE)).toEqual([
      { value: START + 30 * D, color: '#6E9BD6' },
    ]);
    expect(def.priceAxisLabels!(d, d.style, SELECTED)).toEqual([]);
    expect(def.handles!(g, d.style)).toEqual([{ x: X(30), y: 200, cursor: 'ew-resize' }]);
  });

  it('hits vertical text left of the line', () => {
    const { at } = hit('vertical-line', [pt(30, 50)], {}, 'event');
    // vertical text, top aligned: x in [line - 4 - 14.4, line - 4], y from 8 down
    expect(at(X(30) - 10, 20)).toEqual({ kind: 'text' });
  });
});

describe('cross line', () => {
  it('hits either line and labels both axes', () => {
    const { at, def, d } = hit('cross-line', [pt(30, 50)]);
    expect(at(X(80), Y(50))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(90))).toEqual({ kind: 'body' });
    expect(at(X(80), Y(90))).toBeNull();
    expect(def.priceAxisLabels!(d, d.style, IDLE).map((l) => l.value)).toEqual([50]);
    expect(def.timeAxisLabels!(d, d.style, IDLE).map((l) => l.value)).toEqual([START + 30 * D]);
    const hidden = { ...d.style, showPriceLabel: false };
    expect(def.priceAxisLabels!(d, hidden, IDLE)).toEqual([]);
  });
});

describe('arrow', () => {
  it('draws the head and hits the segment and text', () => {
    const { at, def, d, g } = hit('arrow-line', [pt(20, 20), pt(40, 20)], {}, 'go');
    expect(def.group).toBe('shapes');
    const { rc, calls } = recordingContext();
    def.render(rc, g, d.style, IDLE);
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(2); // line + head
    expect(at(X(30), Y(20))).toEqual({ kind: 'body' });
    expect(at(X(30), Y(20) - 10)).toEqual({ kind: 'text' });
    expect(at(X(45), Y(20))).toBeNull();
  });
});
