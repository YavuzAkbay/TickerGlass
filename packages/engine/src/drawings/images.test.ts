import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDrawingImages, drawingImage } from './images';

/** Fake `Image`: decodes when the test calls `finish`. */
class FakeImage {
  static made: FakeImage[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = '';
  constructor() {
    FakeImage.made.push(this);
  }
  finish(ok = true): void {
    (ok ? this.onload : this.onerror)?.();
  }
}

afterEach(() => {
  clearDrawingImages();
  FakeImage.made = [];
  vi.unstubAllGlobals();
});

describe('drawingImage', () => {
  it('returns null without a DOM', () => {
    expect(drawingImage('data:image/png;base64,AA', () => undefined)).toBeNull();
  });

  it('decodes once, calls the redraw once, then returns the image', () => {
    vi.stubGlobal('Image', FakeImage);
    const redraw = vi.fn();
    expect(drawingImage('a', redraw)).toBeNull();
    expect(drawingImage('a', redraw)).toBeNull(); // same pending decode, same waiter
    expect(FakeImage.made).toHaveLength(1);
    expect(FakeImage.made[0]!.src).toBe('a');
    FakeImage.made[0]!.finish();
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(drawingImage('a', redraw)).toBe(FakeImage.made[0]);
    expect(drawingImage('', redraw)).toBeNull();
  });

  it('failed decodes redraw once and stay null', () => {
    vi.stubGlobal('Image', FakeImage);
    const redraw = vi.fn();
    drawingImage('bad', redraw);
    FakeImage.made[0]!.finish(false);
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(drawingImage('bad', redraw)).toBeNull();
    expect(FakeImage.made).toHaveLength(1);
  });

  it('evicts the least recently used beyond 32 images', () => {
    vi.stubGlobal('Image', FakeImage);
    const noop = () => undefined;
    for (let i = 0; i < 32; i++) drawingImage(`s${i}`, noop);
    drawingImage('s0', noop); // touch: s1 is now the oldest
    drawingImage('s32', noop);
    expect(FakeImage.made).toHaveLength(33);
    drawingImage('s0', noop);
    expect(FakeImage.made).toHaveLength(33); // kept
    drawingImage('s1', noop);
    expect(FakeImage.made).toHaveLength(34); // evicted, decoded again
  });
});
