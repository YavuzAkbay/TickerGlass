import type { CSSProperties } from 'react';

/** Row heat strip: the day's move, deeper for bigger moves (full at ±3%). */
export function heatStyle(pct: number | null | undefined): CSSProperties | undefined {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct === 0) return undefined;
  const k = Math.round(Math.min(1, Math.abs(pct) / 3) * 85) + 15;
  return {
    ['--wl-heat' as string]: `color-mix(in srgb, var(${pct > 0 ? '--up' : '--down'}) ${k}%, transparent)`,
  };
}
