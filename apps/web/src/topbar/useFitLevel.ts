import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/**
 * How far the top bar has to fold itself to fit, from 0 (everything shown) to
 * `FIT_MAX`. Each step hides less important content, in order:
 *
 * 1. keyboard hint in the command box, collapsible button text
 * 2. button labels and the layout name
 * 3. command box shrinks to a search icon
 * 4. interval favorites fold into the active interval and its dropdown
 * 5. replay, undo/redo and theme move into "More"
 */
export const FIT_MAX = 5;

export interface Fit {
  level: number;
  /** Still too wide at the last level: the bar scrolls instead of overlapping. */
  overflow: boolean;
}

interface Parts {
  bar: RefObject<HTMLElement | null>;
  /** Content-sized wrappers of the left and right groups. */
  left: RefObject<HTMLElement | null>;
  right: RefObject<HTMLElement | null>;
  palette: RefObject<HTMLElement | null>;
}

const px = (v: string) => parseFloat(v) || 0;

interface Need {
  /** Width the bar needs at the level currently rendered. */
  total: number;
  /** Width of the wider group: each side keeps at least this much. */
  side: number;
}

function measure({ bar, left, right, palette }: Parts): Need | null {
  const b = bar.current;
  const l = left.current;
  const r = right.current;
  const p = palette.current;
  if (!b || !l || !r || !p) return null;
  const bs = getComputedStyle(b);
  const ps = getComputedStyle(p);
  const side = Math.max(l.getBoundingClientRect().width, r.getBoundingClientRect().width);
  return {
    // The sides share the space equally so the command box stays centered.
    total:
      px(bs.paddingLeft) +
      px(bs.paddingRight) +
      px(bs.columnGap) * 2 +
      2 * side +
      px(ps.minWidth) +
      px(ps.marginLeft) +
      px(ps.marginRight),
    side,
  };
}

/**
 * Measures the bar's groups and picks the lowest fit level whose content fits.
 * The width each level needed is remembered, so growing the window steps back
 * down without trial renders; a stale value (content changed meanwhile) costs
 * one extra layout pass, all before paint.
 */
export function useFitLevel({ bar, left, right, palette }: Parts): Fit {
  const [fit, setFit] = useState<Fit>({ level: 0, overflow: false });
  const [tick, setTick] = useState(0);
  const need = useRef<number[]>([]);

  // Re-measure when the bar resizes, or a group's content changes width (a
  // longer layout name, a new favorite interval, fonts finishing loading).
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    for (const el of [bar.current, left.current, right.current]) if (el) ro.observe(el);
    return () => ro.disconnect();
  }, [bar, left, right]);

  useLayoutEffect(() => {
    const m = measure({ bar, left, right, palette });
    if (m === null || !bar.current) return;
    // Sides never shrink below their content, so the command box gives way first.
    bar.current.style.setProperty('--tb-side-min', `${Math.ceil(m.side)}px`);
    const w = m.total;
    const avail = bar.current.clientWidth;
    need.current[fit.level] = w;
    // Half a pixel of slack for sub-pixel rounding.
    const fits = (n: number | undefined) => n !== undefined && n <= avail + 0.5;
    let next: Fit;
    if (!fits(w) && fit.level < FIT_MAX) next = { level: fit.level + 1, overflow: false };
    else if (fit.level > 0 && fits(need.current[fit.level - 1]))
      next = { level: fit.level - 1, overflow: false };
    else next = { level: fit.level, overflow: !fits(w) };
    if (next.level !== fit.level || next.overflow !== fit.overflow) setFit(next);
  }, [bar, left, right, palette, fit.level, fit.overflow, tick]);

  return fit;
}
