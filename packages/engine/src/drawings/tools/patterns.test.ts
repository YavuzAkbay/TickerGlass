import { describe, expect, it } from 'vitest';
import type { DrawingPoint } from '../types';
import {
  ELLIOTT_DEGREE_KEYS,
  elliottLabel,
  labelAbove,
  ratioText,
  ratioValue,
  type PatternRatio,
} from './pattern-common';
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

/** X=20 A=60 B=40 C=50 D=30 on bars 20, 30, 40, 50, 60. */
const XABCD: DrawingPoint[] = [pt(20, 20), pt(30, 60), pt(40, 40), pt(50, 50), pt(60, 30)];

function setup(type: string, points: DrawingPoint[], style = {}) {
  const d = makeDrawing(type, points, style);
  const g = geometryOf(d);
  const def = tool(type);
  return {
    d,
    g,
    def,
    at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL),
    draw: () => {
      const r = recordingContext();
      def.render(r.rc, g, d.style, SELECTED);
      return r;
    },
  };
}

const prices = (pts: DrawingPoint[]) => pts.map((p) => p.price);

describe('ratios', () => {
  it('XABCD: AB/XA, BC/AB, CD/BC, AD/XA to three decimals', () => {
    const r = (num: [number, number], den: [number, number]): PatternRatio => ({
      from: 0,
      to: 1,
      num,
      den,
    });
    const p = prices(XABCD);
    expect(ratioText(ratioValue(p, r([1, 2], [0, 1])))).toBe('0.500'); // 20 / 40
    expect(ratioText(ratioValue(p, r([2, 3], [1, 2])))).toBe('0.500'); // 10 / 20
    expect(ratioText(ratioValue(p, r([3, 4], [2, 3])))).toBe('2.000'); // 20 / 10
    expect(ratioText(ratioValue(p, r([1, 4], [0, 1])))).toBe('0.750'); // 30 / 40
  });

  it('is undefined for flat or missing legs', () => {
    const r: PatternRatio = { from: 0, to: 1, num: [0, 1], den: [1, 2] };
    expect(ratioText(ratioValue([10, 20, 20], r))).toBe('');
    expect(ratioText(ratioValue([10, 20], r))).toBe('');
  });

  it('draws the XABCD ratio labels and point labels', () => {
    const { draw } = setup('xabcd', XABCD);
    expect(draw().texts).toEqual(['X', 'A', 'B', 'C', 'D', '0.500', '0.500', '2.000', '0.750']);
  });

  it('cypher: AB/XA, XC/XA, CD/XC', () => {
    // X=20 A=60 B=44 C=70 D=50: 16/40, 50/40, 20/50.
    const pts = [pt(20, 20), pt(30, 60), pt(40, 44), pt(50, 70), pt(60, 50)];
    expect(setup('cypher', pts).draw().texts.slice(5)).toEqual(['0.400', '1.250', '0.400']);
  });

  it('ABCD: BC/AB and CD/BC only', () => {
    const pts = [pt(20, 20), pt(30, 60), pt(40, 40), pt(50, 80)];
    expect(setup('abcd', pts).draw().texts).toEqual(['A', 'B', 'C', 'D', '0.500', '2.000']);
  });

  it('hides ratios when switched off', () => {
    expect(setup('xabcd', XABCD, { showRatios: false }).draw().texts).toEqual([
      'X',
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it('partial drafts only draw ratios whose legs exist', () => {
    expect(setup('xabcd', XABCD.slice(0, 3)).draw().texts).toEqual(['X', 'A', 'B', '0.500']);
    expect(setup('xabcd', XABCD.slice(0, 2)).draw().texts).toEqual(['X', 'A']);
  });
});

describe('label placement', () => {
  it('above a local high, below a local low or slope', () => {
    const { g } = setup('xabcd', XABCD);
    const above = XABCD.map((_, i) => labelAbove(g.points, i));
    // X is lower than A (below), A high, B low, C high (50 > 40, 50 > 30), D low.
    expect(above).toEqual([false, true, false, true, false]);
  });

  it('a lone anchor is above', () => {
    const { g } = setup('xabcd', XABCD.slice(0, 1));
    expect(labelAbove(g.points, 0)).toBe(true);
  });
});

describe('hits', () => {
  it('zigzag and connectors are strong', () => {
    const { at } = setup('xabcd', XABCD);
    expect(at((X(20) + X(30)) / 2, (Y(20) + Y(60)) / 2)).toEqual({ kind: 'body' });
    // X-B connector midpoint (also inside the XAB fill, but the line wins).
    expect(at(X(30), Y(30))).toEqual({ kind: 'body' });
  });

  it('triangle fills are weak, outside is null', () => {
    const { at } = setup('xabcd', XABCD, { showRatios: false });
    // Inside XAB, away from every line.
    expect(at(X(30), Y(45))).toEqual({ kind: 'body', weak: true });
    // Inside BCD.
    expect(at(X(50), Y(43))).toEqual({ kind: 'body', weak: true });
    expect(at(X(90), Y(10))).toBeNull();
    expect(setup('xabcd', XABCD, { fillBackground: false }).at(X(30), Y(45))).toBeNull();
  });

  it('head and shoulders: neckline strong, head area weak', () => {
    const pts = [
      pt(10, 20),
      pt(20, 60),
      pt(30, 40),
      pt(40, 80),
      pt(50, 40),
      pt(60, 60),
      pt(70, 20),
    ];
    const s = setup('head-shoulders', pts);
    expect(s.at(X(40), Y(40))).toEqual({ kind: 'body' });
    expect(s.at(X(40), Y(55))).toEqual({ kind: 'body', weak: true });
    expect(s.at(X(40), Y(90))).toBeNull();
    expect(s.draw().texts).toEqual(['Left Shoulder', 'Head', 'Right Shoulder']);
  });

  it('triangle pattern: converging lines are strong', () => {
    const pts = [pt(20, 20), pt(30, 60), pt(40, 30), pt(50, 50)];
    const s = setup('triangle-pattern', pts);
    // Midpoint of A-C.
    expect(s.at(X(30), Y(25))).toEqual({ kind: 'body' });
    expect(s.at(X(30), Y(10))).toBeNull();
  });
});

describe('Elliott', () => {
  it('labels per degree', () => {
    expect(elliottLabel('minor', '3')).toBe('3');
    expect(elliottLabel('minor', 'A')).toBe('A');
    expect(elliottLabel('intermediate', '3')).toBe('(3)');
    expect(elliottLabel('minute', '4')).toBe('[iv]');
    expect(elliottLabel('minute', 'W')).toBe('[w]');
    expect(elliottLabel('minuette', '2')).toBe('(ii)');
    expect(elliottLabel('subminuette', '5')).toBe('v');
    expect(elliottLabel('cycle', '4')).toBe('IV');
    expect(elliottLabel('supercycle', '1')).toBe('(I)');
    expect(elliottLabel('grand-supercycle', 'C')).toBe('((C))');
    expect(elliottLabel('primary', '3')).toBe('③');
    expect(elliottLabel('primary', 'A')).toBe('Ⓐ');
    expect(elliottLabel('primary', 'Z')).toBe('Ⓩ');
    expect(elliottLabel('nope', '1')).toBe('1');
  });

  it('every degree labels every wave id', () => {
    for (const k of ELLIOTT_DEGREE_KEYS)
      for (const id of ['0', '1', '2', '3', '4', '5', 'A', 'B', 'C', 'D', 'E', 'W', 'X', 'Y', 'Z'])
        expect(elliottLabel(k, id)).not.toBe('');
  });

  it.each([
    ['elliott-impulse', 6, ['0', '1', '2', '3', '4', '5']],
    ['elliott-correction', 4, ['0', 'A', 'B', 'C']],
    ['elliott-triangle', 6, ['0', 'A', 'B', 'C', 'D', 'E']],
    ['elliott-double-combo', 4, ['0', 'W', 'X', 'Y']],
    ['elliott-triple-combo', 6, ['0', 'W', 'X', 'Y', 'X', 'Z']],
  ] as const)('%s: %d anchors labelled', (type, count, ids) => {
    const pts = Array.from({ length: count }, (_, i) => pt(10 + i * 10, i % 2 ? 60 : 30));
    const s = setup(type, pts);
    expect(tool(type).creation).toEqual({ kind: 'points', count });
    expect(s.draw().texts).toEqual(ids);
    expect(setup(type, pts, { degree: 'minute' }).draw().texts[1]).toBe(
      ids[1]! >= '1' && ids[1]! <= '5' ? '[i]' : `[${ids[1]!.toLowerCase()}]`,
    );
    // Plain zigzag: line strong, no fill.
    expect(s.at(X(15), Y(45))).toEqual({ kind: 'body' });
    expect(s.at(X(15), Y(20))).toBeNull();
  });

  it('labels can be hidden', () => {
    const pts = [pt(10, 30), pt(20, 60), pt(30, 40), pt(40, 80)];
    expect(setup('elliott-correction', pts, { showLabels: false }).draw().texts).toEqual([]);
  });
});

describe('all pattern tools', () => {
  it.each([
    ['xabcd', 5],
    ['cypher', 5],
    ['head-shoulders', 7],
    ['abcd', 4],
    ['triangle-pattern', 4],
    ['three-drives', 7],
  ] as const)('%s: %d fixed anchors, shift unconstrained, one handle per anchor', (type, count) => {
    const def = tool(type);
    expect(def.creation).toEqual({ kind: 'points', count });
    expect(def.shiftConstraint).toBe('none');
    expect(def.group).toBe('patterns');
    const pts = Array.from({ length: count }, (_, i) => pt(10 + i * 8, i % 2 ? 60 : 30));
    const { g, d } = setup(type, pts);
    expect(def.handles?.(g, d.style) ?? g.points).toHaveLength(count);
    expect(def.completePoints).toBeUndefined();
  });

  it('three drives: five ratio connectors', () => {
    const pts = [
      pt(10, 20),
      pt(20, 60),
      pt(30, 40),
      pt(40, 80),
      pt(50, 55),
      pt(60, 100),
      pt(70, 70),
    ];
    // 20/40, 40/20, 25/40, 45/25, 30/45
    expect(setup('three-drives', pts).draw().texts.slice(7)).toEqual([
      '0.500',
      '2.000',
      '0.625',
      '1.800',
      '0.667',
    ]);
  });

  it('culls off-screen drawings', () => {
    const far = makeDrawing('xabcd', [pt(-500, 20), pt(-480, 30), pt(-490, 25)]);
    expect(tool('xabcd').isVisible?.(geometryOf(far), far.style) ?? false).toBe(false);
    const near = makeDrawing('xabcd', XABCD);
    expect(tool('xabcd').isVisible?.(geometryOf(near), near.style) ?? true).toBe(true);
  });
});
