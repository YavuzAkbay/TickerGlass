/**
 * Diverging colour scale of the heatmap (pure). A value is mapped to a position in [-1, 1] around a
 * metric's centre (clamped at its range), then to a colour: red - graphite - green. The same colours
 * on both themes (tiles carry white text); the palette ends are dark enough for 4.5:1 contrast.
 */

type Rgb = readonly [number, number, number];

const DOWN: Rgb = [196, 54, 58];
const NEUTRAL: Rgb = [66, 72, 84];
const UP: Rgb = [24, 134, 78];

/** Position of `value` on the scale: -1 (full red) .. 0 (centre) .. +1 (full green). */
export function scalePosition(value: number, center: number, range: number): number {
  if (!Number.isFinite(value) || !(range > 0)) return 0;
  return Math.max(-1, Math.min(1, (value - center) / range));
}

const mix = (a: Rgb, b: Rgb, t: number): string =>
  `rgb(${Math.round(a[0] + (b[0] - a[0]) * t)}, ${Math.round(a[1] + (b[1] - a[1]) * t)}, ${Math.round(a[2] + (b[2] - a[2]) * t)})`;

/**
 * Colour at scale position `t` (-1..1). A slight ease keeps small moves visible without washing
 * out the extremes.
 */
export function divergingColor(t: number): string {
  const p = Math.max(-1, Math.min(1, Number.isFinite(t) ? t : 0));
  const eased = Math.sign(p) * Math.pow(Math.abs(p), 0.8);
  return eased < 0 ? mix(NEUTRAL, DOWN, -eased) : mix(NEUTRAL, UP, eased);
}

/** CSS gradient of the whole scale, left (full red) to right (full green). */
export const LEGEND_GRADIENT = `linear-gradient(90deg, ${[-1, -0.66, -0.33, 0, 0.33, 0.66, 1]
  .map((t, i, a) => `${divergingColor(t)} ${Math.round((i / (a.length - 1)) * 100)}%`)
  .join(', ')})`;
