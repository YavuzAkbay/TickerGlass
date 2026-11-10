import { useCallback, useEffect, useRef, useState } from 'react';

/** Visible row range; `end` is exclusive. */
export interface VirtualRange {
  start: number;
  end: number;
}

/**
 * Visible (+overscan) row range of a fixed-height virtual list. Pure, so tests
 * can pin the windowing math: rows `start..end` cover the viewport with
 * `overscan` extra rows on each side, clamped to `count`.
 */
export function virtualRange(
  scrollTop: number,
  viewportH: number,
  count: number,
  rowH: number,
  overscan = 6,
): VirtualRange {
  if (count <= 0 || rowH <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowH);
  const visible = Math.ceil(viewportH / rowH) + 1;
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, first + visible + overscan),
  };
}

/**
 * Windowing for the page table: all rows share one fixed height, so the
 * visible slice follows from `scrollTop` alone. Renders only re-run when the
 * range actually changes, not on every scroll tick. Rows stay in normal flow
 * between two height spacers (keeps drop lines and focus rings trivial).
 */
export function useVirtualRows(count: number, rowH: number, overscan = 6) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VirtualRange>({ start: 0, end: 0 });

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = virtualRange(el.scrollTop, el.clientHeight, count, rowH, overscan);
    setRange((r) => (r.start === next.start && r.end === next.end ? r : next));
  }, [count, rowH, overscan]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    measure();
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [measure]);

  /** Keep the row at `index` visible (keyboard navigation). */
  const scrollToRow = useCallback(
    (index: number) => {
      const el = scrollerRef.current;
      if (!el || index < 0) return;
      const top = index * rowH;
      const bottom = top + rowH;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
    [rowH],
  );

  return { scrollerRef, range, scrollToRow };
}
