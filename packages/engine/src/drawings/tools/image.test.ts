import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drawingImage } from '../images';
import { isEmbeddedImage } from './image';
import { geometryOf, IDLE, makeDrawing, pt, recordingContext, tool } from './test-utils';

vi.mock('../images', () => ({
  drawingImage: vi.fn(() => ({ naturalWidth: 10, naturalHeight: 10 })),
}));

const render = (src: string) => {
  const d = makeDrawing('image', [pt(30, 80), pt(50, 40)], { src });
  const r = recordingContext();
  tool('image').render(r.rc, geometryOf(d), d.style, IDLE);
  return r;
};

describe('image source whitelist', () => {
  beforeEach(() => vi.mocked(drawingImage).mockClear());

  it('only data:image/ URLs count as embedded', () => {
    expect(isEmbeddedImage('data:image/webp;base64,AAAA')).toBe(true);
    for (const bad of [
      '',
      'https://example.com/a.png',
      'http://x/y.png',
      '//x/y.png',
      'data:text/html,hi',
      'javascript:1',
    ])
      expect(isEmbeddedImage(bad)).toBe(false);
    expect(isEmbeddedImage(42)).toBe(false);
  });

  it('draws and loads a data:image/ source', () => {
    const r = render('data:image/png;base64,AAAA');
    expect(drawingImage).toHaveBeenCalledTimes(1);
    expect(r.calls).toContain('drawImage');
  });

  it('shows the unavailable placeholder for any other source without loading it', () => {
    for (const src of ['https://example.com/a.png', 'data:text/html,hi', 'file:///etc/passwd']) {
      const r = render(src);
      expect(r.texts).toEqual(['Image unavailable']);
      expect(r.calls).not.toContain('drawImage');
    }
    expect(drawingImage).not.toHaveBeenCalled();
  });
});
