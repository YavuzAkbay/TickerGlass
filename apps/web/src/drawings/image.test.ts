import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imageToDataUrl } from './image';

interface FakeCanvas {
  width: number;
  height: number;
  getContext: () => { drawImage: (...a: unknown[]) => void };
  toDataURL: (type: string, q: number) => string;
}

/** Minimal DOM: the image is 4000x2000; data URL length grows with pixels and quality. */
function stubDom(opts: { webp: boolean; bytesPerPixel: number }) {
  const canvases: FakeCanvas[] = [];
  const revoked: string[] = [];
  class FakeImage {
    naturalWidth = 4000;
    naturalHeight = 2000;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:x',
    revokeObjectURL: (u: string) => revoked.push(u),
  });
  vi.stubGlobal('document', {
    createElement: () => {
      const c: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: (type, q) => {
          const mime = type === 'image/webp' && !opts.webp ? 'image/png' : type;
          const n = Math.round(c.width * c.height * opts.bytesPerPixel * q);
          return `data:${mime};base64,${'A'.repeat(n)}`;
        },
      };
      canvases.push(c);
      return c;
    },
  });
  return { canvases, revoked };
}

describe('imageToDataUrl', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('downscales to 1024px on the longest side and encodes WebP', async () => {
    const { canvases, revoked } = stubDom({ webp: true, bytesPerPixel: 0.01 });
    const url = await imageToDataUrl(new Blob(['x']));
    expect(url.startsWith('data:image/webp')).toBe(true);
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([1024, 512]);
    expect(revoked).toEqual(['blob:x']);
  });

  it('falls back to JPEG when WebP encoding is unsupported', async () => {
    stubDom({ webp: false, bytesPerPixel: 0.01 });
    expect((await imageToDataUrl(new Blob(['x']))).startsWith('data:image/jpeg')).toBe(true);
  });

  it('lowers quality and then size until the data URL fits', async () => {
    const { canvases } = stubDom({ webp: true, bytesPerPixel: 2 });
    const url = await imageToDataUrl(new Blob(['x']), 1024, 100_000);
    expect(url.length).toBeLessThanOrEqual(100_000);
    expect(canvases.length).toBeGreaterThan(1);
  });

  it('rejects an image that cannot fit', async () => {
    stubDom({ webp: true, bytesPerPixel: 1000 });
    await expect(imageToDataUrl(new Blob(['x']), 1024, 1000)).rejects.toThrow(/too large/);
  });
});
