import { buildTradingCalendar, timeToLogical, type AnchorTimeline } from '@investopen/engine/node';
import { describe, expect, it } from 'vitest';
import {
  drawingChannel,
  drawingLevel,
  DrawingLevelError,
  type DrawingLike,
} from './drawing-levels';

const DAY = 86_400;
/** Monday 2026-10-05 09:30 New York (EDT) = 13:30 UTC. */
const MON = Date.UTC(2026, 9, 5, 13, 30) / 1000;

/** Daily Mon-Fri bars: `weeks` weeks starting MON. */
function weekdays(weeks: number): number[] {
  const out: number[] = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 5; d++) out.push(MON + (w * 7 + d) * DAY);
  return out;
}

function timeline(time: number[], calendar = false): AnchorTimeline {
  const n = time.length;
  return {
    time,
    length: n,
    interval: { unit: 'day', count: 1 },
    bricks: false,
    endTime: time[n - 1]!,
    calendar: calendar
      ? buildTradingCalendar(time, n, { unit: 'day', count: 1 }, 'America/New_York', '0930-1600')
      : null,
  };
}

const T = weekdays(2); // bars 0..9: Mon..Fri, Mon..Fri
const TL = timeline(T);
const at = (i: number) => T[i]!;

function line(
  type: string,
  pts: [number, number][],
  style: Record<string, unknown> = {},
): DrawingLike {
  return { type, points: pts.map(([time, price]) => ({ time, price })), style };
}

describe('trend line (daily Mon-Fri bars)', () => {
  const A: [number, number] = [at(0), 100];
  const B: [number, number] = [at(4), 104];

  it('interpolates inside the segment', () => {
    const d = line('trend-line', [A, B]);
    expect(drawingLevel(d, 'line', 'linear', TL, at(2))).toBe(102);
    expect(drawingLevel(d, 'line', 'linear', TL, at(0))).toBe(100);
    expect(drawingLevel(d, 'line', 'linear', TL, at(4))).toBe(104);
  });

  it('is NaN past anchor 1 unless extended right', () => {
    expect(drawingLevel(line('trend-line', [A, B]), 'line', 'linear', TL, at(6))).toBeNaN();
    const ext = line('trend-line', [A, B], { extendRight: true });
    expect(drawingLevel(ext, 'line', 'linear', TL, at(6))).toBe(106);
  });

  it('maps an anchor on a Saturday to the Monday bar', () => {
    const sat = MON + 5 * DAY; // Saturday 2026-10-10
    expect(timeToLogical(TL, { time: sat })).toBe(5);
    const d = line('trend-line', [
      [sat, 100],
      [at(9), 104],
    ]);
    expect(drawingLevel(d, 'line', 'linear', TL, at(5))).toBe(100);
    expect(drawingLevel(d, 'line', 'linear', TL, at(7))).toBe(102);
    expect(drawingLevel(d, 'line', 'linear', TL, at(4))).toBeNaN();
  });

  it('extendLeft extends past anchor 0 (to the right when A is right of B)', () => {
    const d = line('trend-line', [B, A], { extendLeft: true });
    expect(drawingLevel(d, 'line', 'linear', TL, at(6))).toBe(106);
    expect(drawingLevel(d, 'line', 'linear', TL, at(2))).toBe(102);
    // Not extended past anchor 1 (bar 0): before it would be s > 1; there are no bars left of 0.
    const r = line('trend-line', [B, A], { extendRight: true });
    expect(drawingLevel(r, 'line', 'linear', TL, at(6))).toBeNaN();
  });

  it('ray and extended-line use their default extensions when the style lacks them', () => {
    expect(drawingLevel(line('ray', [A, B]), 'line', 'linear', TL, at(6))).toBe(106);
    const ext = line('extended-line', [
      [at(2), 102],
      [at(4), 104],
    ]);
    expect(drawingLevel(ext, 'line', 'linear', TL, at(0))).toBe(100);
    expect(drawingLevel(ext, 'line', 'linear', TL, at(9))).toBe(109);
    // An explicit style wins over the tool default.
    const noExt = line('ray', [A, B], { extendRight: false });
    expect(drawingLevel(noExt, 'line', 'linear', TL, at(6))).toBeNaN();
  });

  it('info-line extends like a trend line; arrow-line never extends', () => {
    const style = { extendLeft: true, extendRight: true };
    expect(drawingLevel(line('info-line', [A, B], style), 'line', 'linear', TL, at(6))).toBe(106);
    expect(drawingLevel(line('arrow-line', [A, B], style), 'line', 'linear', TL, at(6))).toBeNaN();
    expect(drawingLevel(line('arrow-line', [A, B], style), 'line', 'linear', TL, at(1))).toBe(101);
  });
});

describe('log scale', () => {
  const pts: [number, number][] = [
    [at(0), 100],
    [at(2), 10000],
  ];
  it('is straight in log10(price)', () => {
    expect(drawingLevel(line('trend-line', pts), 'line', 'log', TL, at(1))).toBeCloseTo(1000, 9);
    expect(drawingLevel(line('trend-line', pts), 'line', 'linear', TL, at(1))).toBe(5050);
  });
});

describe('future anchor', () => {
  it('maps B two slots past the last bar through the calendar (weekend skipped)', () => {
    const tl = timeline(T, true);
    const fri = at(9);
    const tue = fri + 4 * DAY; // two trading slots: Mon, Tue
    expect(timeToLogical(tl, { time: tue })).toBe(11);
    const d = line('trend-line', [
      [at(0), 100],
      [tue, 111],
    ]);
    const lB = timeToLogical(tl, { time: tue });
    const lA = timeToLogical(tl, { time: at(0) });
    for (const i of [0, 3, 9]) {
      const want = 100 + ((i - lA) / (lB - lA)) * 11;
      expect(drawingLevel(d, 'line', 'linear', tl, at(i))).toBeCloseTo(want, 12);
    }
    expect(drawingLevel(d, 'line', 'linear', tl, at(9))).toBeCloseTo(109, 12);
    // Without a calendar the weekend counts as slots: a different line.
    expect(drawingLevel(d, 'line', 'linear', TL, at(9))).not.toBeCloseTo(109, 6);
  });
});

describe('horizontal tools', () => {
  it('horizontal ray starts at its anchor', () => {
    const d = line('horizontal-ray', [[at(3), 50]]);
    expect(drawingLevel(d, 'line', 'linear', TL, at(2))).toBeNaN();
    expect(drawingLevel(d, 'line', 'linear', TL, at(3))).toBe(50);
    expect(drawingLevel(d, 'line', 'log', TL, at(9))).toBe(50);
  });

  it('horizontal line is its price everywhere', () => {
    const d = line('horizontal-line', [[at(5), 42]]);
    expect(drawingLevel(d, 'line', 'linear', TL, at(0))).toBe(42);
    expect(drawingLevel(d, 'line', 'log', TL, at(9))).toBe(42);
  });
});

describe('parallel channel', () => {
  const linear = line('parallel-channel', [
    [at(0), 100],
    [at(4), 104],
    [at(2), 110],
  ]);

  it('linear: constant price offset', () => {
    expect(drawingChannel(linear, 'linear', TL, at(3))).toEqual({ upper: 111, lower: 103 });
    expect(drawingLevel(linear, 'middle', 'linear', TL, at(3))).toBe(107);
    expect(drawingLevel(linear, 'upper', 'linear', TL, at(3))).toBe(111);
    expect(drawingLevel(linear, 'lower', 'linear', TL, at(3))).toBe(103);
  });

  it('is NaN outside the anchors unless extended', () => {
    const out = drawingChannel(linear, 'linear', TL, at(6));
    expect(out.upper).toBeNaN();
    expect(out.lower).toBeNaN();
    const ext = { ...linear, style: { extendRight: true } };
    expect(drawingChannel(ext, 'linear', TL, at(6))).toEqual({ upper: 114, lower: 106 });
  });

  it('log: constant ratio', () => {
    const d = line('parallel-channel', [
      [at(0), 100],
      [at(2), 400],
      [at(1), 400],
    ]);
    const c = drawingChannel(d, 'log', TL, at(2));
    expect(c.upper).toBeCloseTo(800, 9);
    expect(c.lower).toBeCloseTo(400, 9);
    expect(drawingLevel(d, 'middle', 'log', TL, at(2))).toBeCloseTo(400 * Math.SQRT2, 9);
    // At bar 0 the main line is 100 and the parallel 200.
    const c0 = drawingChannel(d, 'log', TL, at(0));
    expect(c0.upper).toBeCloseTo(200, 9);
    expect(c0.lower).toBeCloseTo(100, 9);
  });

  it('offset below the main line orders upper/lower', () => {
    const d = line('parallel-channel', [
      [at(0), 100],
      [at(4), 104],
      [at(2), 96],
    ]);
    expect(drawingChannel(d, 'linear', TL, at(2))).toEqual({ upper: 102, lower: 96 });
  });

  it('needs 3 anchors and distinct anchor bars', () => {
    const two = line('parallel-channel', [
      [at(0), 100],
      [at(4), 104],
    ]);
    expect(() => drawingChannel(two, 'linear', TL, at(1))).toThrow(DrawingLevelError);
    expect(() => drawingChannel(two, 'linear', TL, at(1))).toThrow('incomplete channel');
    const vertical = line('parallel-channel', [
      [at(2), 100],
      [at(2) + 3600, 104],
      [at(3), 110],
    ]);
    expect(() => drawingChannel(vertical, 'linear', TL, at(1))).toThrow('vertical line');
  });
});

describe('rectangle', () => {
  const d = line('rectangle', [
    [at(2), 110],
    [at(5), 90],
  ]);

  it('spans its anchors', () => {
    const c = drawingChannel(d, 'linear', TL, at(1));
    expect(c.upper).toBeNaN();
    expect(c.lower).toBeNaN();
    expect(drawingChannel(d, 'linear', TL, at(3))).toEqual({ upper: 110, lower: 90 });
    expect(drawingChannel(d, 'linear', TL, at(5))).toEqual({ upper: 110, lower: 90 });
    expect(drawingChannel(d, 'linear', TL, at(9)).upper).toBeNaN();
  });

  it('extends by screen side and has a scale-dependent middle', () => {
    const ext = { ...d, style: { extendRight: true } };
    expect(drawingChannel(ext, 'linear', TL, at(9))).toEqual({ upper: 110, lower: 90 });
    expect(drawingChannel(ext, 'linear', TL, at(1)).upper).toBeNaN();
    // Anchors given right-to-left: extendLeft still means the screen's left side.
    const rtl = line(
      'rectangle',
      [
        [at(5), 90],
        [at(2), 110],
      ],
      { extendLeft: true },
    );
    expect(drawingChannel(rtl, 'linear', TL, at(0))).toEqual({ upper: 110, lower: 90 });
    expect(drawingChannel(rtl, 'linear', TL, at(9)).upper).toBeNaN();
    expect(drawingLevel(d, 'middle', 'linear', TL, at(3))).toBe(100);
    expect(drawingLevel(d, 'middle', 'log', TL, at(3))).toBeCloseTo(Math.sqrt(90 * 110), 9);
  });
});

describe('errors', () => {
  it('vertical line', () => {
    const d = line('trend-line', [
      [at(3), 100],
      [at(3), 104],
    ]);
    expect(() => drawingLevel(d, 'line', 'linear', TL, at(3))).toThrow(DrawingLevelError);
    expect(() => drawingLevel(d, 'line', 'linear', TL, at(3))).toThrow('vertical line');
  });

  it('unsupported tool or part', () => {
    const tl = line('trend-line', [
      [at(0), 1],
      [at(1), 2],
    ]);
    expect(() => drawingLevel(tl, 'upper', 'linear', TL, at(0))).toThrow(DrawingLevelError);
    const rect = line('rectangle', [
      [at(0), 1],
      [at(1), 2],
    ]);
    expect(() => drawingLevel(rect, 'line', 'linear', TL, at(0))).toThrow(DrawingLevelError);
    expect(() => drawingLevel(line('brush', []), 'line', 'linear', TL, at(0))).toThrow(
      DrawingLevelError,
    );
    expect(() => drawingChannel(tl, 'linear', TL, at(0))).toThrow(DrawingLevelError);
  });

  it('NaN without bars', () => {
    const empty: AnchorTimeline = { ...TL, time: [], length: 0 };
    const d = line('trend-line', [
      [at(0), 1],
      [at(1), 2],
    ]);
    expect(drawingLevel(d, 'line', 'linear', empty, at(0))).toBeNaN();
  });
});
