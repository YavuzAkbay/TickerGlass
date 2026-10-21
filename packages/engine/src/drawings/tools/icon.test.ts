import { describe, expect, it } from 'vitest';
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

function setup(style = {}, points = [pt(20, 50)]) {
  const d = makeDrawing('icon', points, style);
  return { d, g: geometryOf(d), def: tool('icon') };
}

describe('icon', () => {
  it('is a single-click annotation tool with glyph and size properties', () => {
    const def = tool('icon');
    expect(def.creation).toEqual({ kind: 'click' });
    expect(def.properties.map((p) => p.key)).toEqual(['glyph', 'size']);
  });

  it('draws the preset glyph centred on the anchor', () => {
    const { d, g, def } = setup({ glyph: '\u{1F680}', size: 40 });
    const { rc, texts } = recordingContext();
    def.render(rc, g, d.style, SELECTED);
    expect(texts).toEqual(['\u{1F680}']);
  });

  it('hits inside the size box and misses outside', () => {
    const { d, g, def } = setup({ size: 40 });
    expect(def.hitTest(g, d.style, X(20), Y(50), 4)).toEqual({ kind: 'body' });
    expect(def.hitTest(g, d.style, X(20) + 23, Y(50) - 23, 4)).toEqual({ kind: 'body' });
    expect(def.hitTest(g, d.style, X(20) + 25, Y(50), 4)).toBeNull();
  });

  it('is visible only while the glyph box overlaps the pane', () => {
    const near = setup({ size: 40 });
    expect(near.def.isVisible!(near.g, near.d.style)).toBe(true);
    const far = setup({ size: 40 }, [pt(-500, 50)]);
    expect(far.def.isVisible!(far.g, far.d.style)).toBe(false);
  });
});
