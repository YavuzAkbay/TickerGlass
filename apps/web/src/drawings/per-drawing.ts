import type { Drawing, DrawingStyle } from '@investopen/engine';

/**
 * Style keys that belong to one drawing, never to a saved default or template:
 * the icon glyph, the ghost-feed random seed and the embedded image. Saving
 * strips them, applying a default/template keeps the drawing's own.
 */
export const PER_DRAWING_KEYS: Readonly<Record<string, string>> = {
  icon: 'glyph',
  'ghost-feed': 'seed',
  image: 'src',
};

/** `style` without the per-drawing key of `type` (a copy). */
export function stripPerDrawingStyle(type: string, style: DrawingStyle): DrawingStyle {
  const key = PER_DRAWING_KEYS[type];
  if (!key || !(key in style)) return style;
  const { [key]: _own, ...rest } = style;
  return rest;
}

/**
 * The saved default style `style` for a drawing of `type` just created with
 * `own` style: per-drawing keys (icon glyph, ghost-feed seed, image src) stay the drawing's.
 */
export function keepPerDrawingStyle(
  type: string,
  style: DrawingStyle,
  own: DrawingStyle | undefined,
): DrawingStyle {
  if (type === 'icon') return { ...style, glyph: own?.glyph ?? style.glyph ?? '' };
  const key = PER_DRAWING_KEYS[type];
  if (!key) return style;
  const rest = stripPerDrawingStyle(type, style);
  return own && key in own ? { ...rest, [key]: own[key]! } : rest;
}

/** Total embedded-image budget of all drawings in browser storage (string length). */
export const IMAGE_BUDGET_CHARS = 2_000_000;

const srcLength = (d: Drawing): number =>
  d.type === 'image' && typeof d.style.src === 'string' ? d.style.src.length : 0;

/** Whether `src` fits next to every image drawing except `excludeId` (the one being edited). */
export function fitsImageBudget(
  drawings: readonly Drawing[],
  excludeId: string | undefined,
  src: string,
): boolean {
  let total = src.length;
  for (const d of drawings) if (d.id !== excludeId) total += srcLength(d);
  return total <= IMAGE_BUDGET_CHARS;
}
