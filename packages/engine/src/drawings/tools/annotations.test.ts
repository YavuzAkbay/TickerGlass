import { describe, expect, it } from 'vitest';
import type { DrawingPoint } from '../types';
import { bubblePolygon, wrapText } from './annotation-common';
import { calloutLayout } from './callout';
import { parseTable, tableLayout } from './table';
import {
  geometryOf,
  IDLE,
  makeDrawing,
  makeView,
  pt,
  recordingContext,
  SELECTED,
  tool,
} from './test-utils';

const { X, Y } = makeView();
const TOL = 4;

function setup(type: string, points: DrawingPoint[], style = {}, text = '') {
  const d = makeDrawing(type, points, style, text);
  const g = geometryOf(d);
  const def = tool(type);
  return {
    d,
    g,
    def,
    at: (x: number, y: number) => def.hitTest(g, d.style, x, y, TOL),
    visible: () => (def.isVisible ? def.isVisible(g, d.style) : true),
  };
}

describe('annotation helpers', () => {
  it('wraps words to the width and keeps explicit newlines', () => {
    // approxTextWidth: 0.6 em per char without canvas (14px -> 8.4 px/char).
    const lines = wrapText('aaaa bbbb cccc\ndd', { fontSize: 14, bold: false, italic: false }, 80);
    expect(lines).toEqual(['aaaa bbbb', 'cccc', 'dd']);
  });

  it('bubble pointer sits on the side facing the tip', () => {
    const box = { x: 100, y: 100, w: 80, h: 40 };
    expect(bubblePolygon(box, null)).toHaveLength(4);
    expect(bubblePolygon(box, { x: 140, y: 120 })).toHaveLength(4); // inside: none
    const below = bubblePolygon(box, { x: 140, y: 200 });
    expect(below).toHaveLength(7);
    expect(below).toContainEqual({ x: 140, y: 200 });
    const left = bubblePolygon(box, { x: 20, y: 120 });
    expect(left[left.length - 2]).toEqual({ x: 20, y: 120 });
  });
});

describe('pinned text', () => {
  it('is pane-anchored and hits its text box from the anchor', () => {
    const { def, at } = setup('pinned-text', [{ time: 0.25, price: 0.5 }], {}, 'hello');
    expect(def.coords).toBe('pane');
    expect(at(200 + 5, 200 + 5)).toEqual({ kind: 'text' });
    expect(at(100, 100)).toBeNull();
  });
});

describe('note / pinned note', () => {
  it('hits the pin; tooltip only while hovered', () => {
    const { at, def, d, g } = setup('note', [pt(50, 50)], {}, 'my note');
    expect(at(X(50), Y(50) - 12)).toEqual({ kind: 'body' });
    expect(at(X(50) + 60, Y(50))).toBeNull();
    const idle = recordingContext();
    def.render(idle.rc, g, d.style, IDLE);
    expect(idle.texts).toEqual([]);
    const hover = recordingContext();
    def.render(hover.rc, g, d.style, { ...IDLE, hovered: true });
    expect(hover.texts).toEqual(['my note']);
  });

  it('pinned note uses pane coordinates', () => {
    const { def, at } = setup('pinned-note', [{ time: 0.5, price: 0.5 }]);
    expect(def.coords).toBe('pane');
    expect(at(400, 190)).toEqual({ kind: 'body' });
  });
});

describe('callout', () => {
  const pts = [pt(50, 20), pt(60, 70)];

  it('bubble centred on anchor 2, pointer to anchor 1', () => {
    const { g, d } = setup('callout', pts, {}, 'hi');
    const l = calloutLayout(g, d.style as never)!;
    expect(l.box.x + l.box.w / 2).toBeCloseTo(X(60), 9);
    expect(l.box.y + l.box.h / 2).toBeCloseTo(Y(70), 9);
    expect(l.tip).toBe(g.points[0]);
  });

  it('hits the text box (text), the pointer (body) and nothing else', () => {
    const { at } = setup('callout', pts, {}, 'hi');
    expect(at(X(60), Y(70))).toEqual({ kind: 'text' });
    expect(at(X(50), Y(20))).toEqual({ kind: 'body' }); // tip
    expect(at(X(10), Y(90))).toBeNull();
  });

  it('wraps long text into several lines', () => {
    const { def, d, g } = setup('callout', pts, { wrapWidth: 60 }, 'one two three four');
    const r = recordingContext();
    def.render(r.rc, g, d.style, SELECTED);
    expect(r.texts.length).toBeGreaterThan(1);
  });

  it('is culled when bubble and target are off-screen', () => {
    expect(setup('callout', [pt(-500, 20), pt(-480, 30)]).visible()).toBe(false);
    expect(setup('callout', pts).visible()).toBe(true);
  });
});

describe('comment', () => {
  it('bubble above the anchor; pointer hits at the anchor', () => {
    const { at, visible } = setup('comment', [pt(50, 50)], {}, 'nice');
    expect(at(X(50), Y(50))).toEqual({ kind: 'body' });
    expect(at(X(50) + 20, Y(50) - 30)).toEqual({ kind: 'text' });
    expect(at(X(50), Y(50) + 40)).toBeNull();
    expect(visible()).toBe(true);
  });
});

describe('price label', () => {
  it('shows the anchor price right of the anchor', () => {
    const { def, d, g, at } = setup('price-label', [pt(50, 42.5)]);
    const r = recordingContext();
    def.render(r.rc, g, d.style, IDLE);
    expect(r.texts).toEqual(['42.50']);
    expect(at(X(50) + 20, Y(42.5))).toEqual({ kind: 'body' });
    expect(at(X(50) - 40, Y(42.5))).toBeNull();
  });
});

describe('price tag', () => {
  const pts = [pt(40, 30), pt(60, 70)];
  it('renders price then text, hits box and connector', () => {
    const { def, d, g, at } = setup('price-tag', pts, {}, 'support');
    const r = recordingContext();
    def.render(r.rc, g, d.style, IDLE);
    expect(r.texts).toEqual(['30.00', 'support']);
    expect(at(X(60), Y(70))).toEqual({ kind: 'text' });
    expect(at(X(40), Y(30))).toEqual({ kind: 'body' });
    expect(at(X(10), Y(10))).toBeNull();
  });
});

describe('pin', () => {
  it('pole is a body hit, plate a text hit', () => {
    const { at } = setup('pin', [pt(50, 20)], { poleHeight: 100 }, 'go');
    expect(at(X(50), Y(20) - 50)).toEqual({ kind: 'body' });
    expect(at(X(50) + 8, Y(20) - 100 - 10)).toEqual({ kind: 'text' });
    expect(at(X(50) + 80, Y(20))).toBeNull();
  });
  it('culls far-left posts', () => {
    expect(setup('pin', [pt(-500, 20)]).visible()).toBe(false);
  });
});

describe('flag', () => {
  it('hits the pole and the pennant', () => {
    const { at } = setup('flag', [pt(50, 20)], { size: 30 });
    expect(at(X(50), Y(20) - 15)).toEqual({ kind: 'body' });
    expect(at(X(50) + 8, Y(20) - 30 + 7)).toEqual({ kind: 'body' });
    expect(at(X(50) + 30, Y(20))).toBeNull();
  });
});

describe('table', () => {
  it('parses rows by newline and cells by tab or pipe, padded to equal width', () => {
    expect(parseTable('a | b\tc\nd')).toEqual([
      ['a', 'b', 'c'],
      ['d', '', ''],
    ]);
    expect(parseTable('')).toEqual([['']]);
  });

  it('lays out column widths from the widest cell, rows of equal height', () => {
    const { g, d } = setup('table', [pt(30, 80)], {}, 'a | longer cell\nbbbbbbbbbbbbbbbbbbbb | c');
    const l = tableLayout(g, d.style as never)!;
    expect(l.rows).toHaveLength(2);
    expect(l.cols).toHaveLength(2);
    expect(l.cols[0]).toBeGreaterThan(l.cols[1]! - 100);
    expect(l.w).toBeCloseTo(l.cols[0]! + l.cols[1]!, 9);
    expect(l.h).toBeCloseTo(l.rowH * 2, 9);
    expect(l.x).toBeCloseTo(X(30), 9);
  });

  it('renders every non-empty cell; hits inside the grid only', () => {
    const { def, d, g, at } = setup('table', [pt(30, 80)], {}, 'h1|h2\n1|2');
    const r = recordingContext();
    def.render(r.rc, g, d.style, IDLE);
    expect(r.texts).toEqual(['h1', 'h2', '1', '2']);
    expect(at(X(30) + 5, Y(80) + 5)).toEqual({ kind: 'text' });
    expect(at(X(30) - 30, Y(80))).toBeNull();
  });
});

describe('image', () => {
  const pts = [pt(30, 80), pt(50, 40)];
  it('hits the whole box (strong) and not outside', () => {
    const { at } = setup('image', pts);
    expect(at(X(40), Y(60))).toEqual({ kind: 'body' });
    expect(at(X(60), Y(60))).toBeNull();
  });
  it('draws a placeholder without a decoded image', () => {
    const { def, d, g } = setup('image', pts);
    const r = recordingContext();
    def.render(r.rc, g, d.style, IDLE);
    expect(r.texts).toEqual(['Image']);
    expect(r.calls).not.toContain('drawImage');
  });
  it('has an image property backed by an empty default', () => {
    const def = tool('image');
    expect(def.properties.some((p) => p.kind === 'image' && p.key === 'src')).toBe(true);
    expect(def.defaults.src).toBe('');
  });
});
