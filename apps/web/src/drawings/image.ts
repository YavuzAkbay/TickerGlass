/** Longest side of a stored drawing image, in pixels. */
export const MAX_IMAGE_SIDE = 1024;
/** Data URL budget (API MAX_DRAWING_BYTES is 512_000 for the whole drawing). */
export const MAX_IMAGE_BYTES = 300 * 1024;

const MIN_QUALITY = 0.3;
const MAX_SHRINKS = 6;

function loadImage(file: Blob): Promise<{ img: CanvasImageSource; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ img, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image'));
    };
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL('image/webp', quality);
  // Browsers without WebP encoding silently return a PNG.
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', quality);
}

/**
 * Read an image file as a data URL for a drawing: downscaled so the longest side is
 * at most 1024 px and encoded as WebP (JPEG fallback), lowering quality and then size
 * until it fits 300 KB. Rejects when the file is not a readable image or cannot fit.
 */
export async function imageToDataUrl(
  file: Blob,
  maxSide = MAX_IMAGE_SIDE,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<string> {
  const { img, w, h } = await loadImage(file);
  if (!w || !h) throw new Error('Could not read the image');
  let scale = Math.min(1, maxSide / Math.max(w, h));
  for (let shrink = 0; shrink <= MAX_SHRINKS; shrink++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Image processing is not available');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (let q = 0.9; q >= MIN_QUALITY - 1e-9; q -= 0.15) {
      const url = encode(canvas, q);
      if (url.length <= maxBytes) return url;
    }
    scale *= 0.75;
  }
  throw new Error('The image is too large to store');
}
