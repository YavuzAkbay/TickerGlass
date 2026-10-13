interface CachedGradient {
  y0: number;
  y1: number;
  c0: string;
  c1: string;
  gradient: CanvasGradient;
}

const cache = new WeakMap<CanvasRenderingContext2D, Map<string, CachedGradient>>();

/**
 * Vertical linear gradient from `c0` at y0 to `c1` at y1 (device px). Reused while
 * the inputs stay the same, so a static view allocates no gradients per frame.
 */
export function verticalGradient(
  ctx: CanvasRenderingContext2D,
  slot: string,
  y0: number,
  y1: number,
  c0: string,
  c1: string,
): CanvasGradient {
  let slots = cache.get(ctx);
  if (!slots) {
    slots = new Map();
    cache.set(ctx, slots);
  }
  const hit = slots.get(slot);
  if (hit && hit.y0 === y0 && hit.y1 === y1 && hit.c0 === c0 && hit.c1 === c1) return hit.gradient;
  const gradient = ctx.createLinearGradient(0, y0, 0, y1);
  gradient.addColorStop(0, c0);
  gradient.addColorStop(1, c1);
  slots.set(slot, { y0, y1, c0, c1, gradient });
  return gradient;
}
