import type { Drawing } from '@investopen/engine';
import { describe, expect, it } from 'vitest';
import {
  fitsImageBudget,
  IMAGE_BUDGET_CHARS,
  keepPerDrawingStyle,
  stripPerDrawingStyle,
} from './per-drawing';
import { useDrawingTemplates } from './store';

const img = (id: string, len: number, type = 'image'): Drawing =>
  ({ id, type, style: { src: 'x'.repeat(len) } }) as unknown as Drawing;

describe('per-drawing style keys', () => {
  it('strips glyph, seed and src only for their own tool', () => {
    expect(
      stripPerDrawingStyle('image', { src: 'data:image/png;base64,AA', keepAspect: true }),
    ).toEqual({
      keepAspect: true,
    });
    expect(stripPerDrawingStyle('icon', { glyph: 'A', size: 1 })).toEqual({ size: 1 });
    expect(stripPerDrawingStyle('path-sketch', { seed: 3, up: 'x' })).toEqual({ up: 'x' });
    expect(stripPerDrawingStyle('trend-line', { src: 'keep' })).toEqual({ src: 'keep' });
  });

  it("applying a default or template keeps the drawing's own image src", () => {
    expect(keepPerDrawingStyle('image', { src: 'old', showBorder: true }, { src: 'mine' })).toEqual(
      {
        showBorder: true,
        src: 'mine',
      },
    );
    // A src that leaked into a saved style never reaches a drawing without one.
    expect(
      keepPerDrawingStyle('image', { src: 'old', showBorder: true }, { keepAspect: true }),
    ).toEqual({
      showBorder: true,
    });
  });

  it('saved defaults and templates never carry the image src', () => {
    const t = useDrawingTemplates.getState();
    t.saveDefault('image', { src: 'data:image/png;base64,AA', showBorder: true });
    t.saveTemplate('image', 'T', { src: 'data:image/png;base64,AA', showBorder: true });
    expect(useDrawingTemplates.getState().defaults.image).toEqual({ showBorder: true });
    expect(useDrawingTemplates.getState().byType.image![0]!.style).toEqual({ showBorder: true });
  });
});

describe('embedded image budget', () => {
  it('sums every image drawing except the one being edited', () => {
    const all = [img('a', 1_200_000), img('b', 700_000), img('c', 5_000_000, 'text')];
    expect(fitsImageBudget(all, undefined, 'x'.repeat(100_000))).toBe(true);
    expect(fitsImageBudget(all, undefined, 'x'.repeat(100_001))).toBe(false);
    // Replacing 'a' frees its own share.
    expect(fitsImageBudget(all, 'a', 'x'.repeat(300_000))).toBe(true);
    expect(fitsImageBudget(all, 'b', 'x'.repeat(IMAGE_BUDGET_CHARS - 1_200_000))).toBe(true);
    expect(fitsImageBudget(all, 'b', 'x'.repeat(IMAGE_BUDGET_CHARS - 1_199_999))).toBe(false);
  });
});
