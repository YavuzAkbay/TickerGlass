/**
 * Chart picture for vision models: the screenshot cropped to the focus, scaled down and encoded
 * as base64 (no `data:` prefix) small enough for the server's image limit.
 */
import type { BriefFocus } from '@tickerglass/ai-context';
import type { Chart } from '@tickerglass/engine';

/** A selection crop is at least this wide relative to its height (bars around it show too). */
const MIN_ASPECT = 0.9;

/** Longest side sent; vision encoders downscale further anyway. */
export const MAX_IMAGE_SIDE = 1280;

/** Width and height of `w`×`h` scaled to fit `max` on its longest side (never enlarged). */
export function fitSize(w: number, h: number, max: number): { width: number; height: number } {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

function scaled(src: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const { width, height } = fitSize(src.width, src.height, max);
  if (width === src.width && height === src.height) return src;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  return out;
}

/**
 * The chart as base64 PNG (JPEG when the PNG is too big), cropped to a selection focus, or
 * null when it cannot be made within `maxBytes`.
 */
export async function chartImage(
  chart: Chart,
  focus: BriefFocus,
  maxBytes: number,
): Promise<string | null> {
  const shot =
    focus.kind === 'selection'
      ? chart.takeScreenshot({ from: focus.from, to: focus.to, minAspect: MIN_ASPECT })
      : chart.takeScreenshot();
  for (const side of [MAX_IMAGE_SIDE, 960, 720]) {
    const canvas = scaled(shot, side);
    const png = await toBlob(canvas, 'image/png');
    if (png && png.size <= maxBytes) return base64(png);
    const jpeg = await toBlob(canvas, 'image/jpeg', 0.85);
    if (jpeg && jpeg.size <= maxBytes) return base64(jpeg);
  }
  return null;
}
