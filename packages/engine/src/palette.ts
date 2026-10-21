/**
 * TickerGlass default palette: the single source for series, drawing and
 * indicator default colours. (`packages/indicators` mirrors the values in
 * `builtins/common.ts` because it does not depend on the engine.)
 */
export type PaletteColor =
  'up' | 'down' | 'primary' | 'amber' | 'violet' | 'cyan' | 'pink' | 'lime' | 'slate' | 'neutral';

export const PALETTE: Readonly<Record<PaletteColor, string>> = {
  up: '#7FB069',
  down: '#DE6A4F',
  primary: '#6E9BD6',
  amber: '#E0A93B',
  violet: '#8e5cf6',
  cyan: '#0fb5c9',
  pink: '#e8618c',
  lime: '#8bc34a',
  slate: '#7a8a99',
  /** Neutral line / level colour. */
  neutral: '#A39E8F',
};

const hex = (c: string, o: number): number => parseInt(c.slice(o, o + 2), 16);

function mix(a: string, b: string, t: number): string {
  let out = '#';
  for (const o of [1, 3, 5]) {
    out += Math.round(hex(a, o) + (hex(b, o) - hex(a, o)) * t)
      .toString(16)
      .padStart(2, '0');
  }
  return out;
}

/**
 * Default level colour at position `t` (0..1) of the gradient
 * up -> primary -> violet; used to colour ordered level sets.
 */
export function levelGradient(t: number): string {
  const u = Math.max(0, Math.min(1, t));
  return u < 0.5
    ? mix(PALETTE.up, PALETTE.primary, u * 2)
    : mix(PALETTE.primary, PALETTE.violet, (u - 0.5) * 2);
}

/** Gradient colour of item `i` out of `n` ordered levels. */
export function levelGradientAt(i: number, n: number): string {
  return levelGradient(n > 1 ? i / (n - 1) : 0);
}
