import { useEffect, type RefObject } from 'react';

/** Gap kept between the drawing dock's right edge and a legend pushed past it. */
const GAP = 6;

/**
 * The drawing dock floats vertically centred over the chart's left edge, so a lower
 * pane's legend (top-left of its pane) can land underneath it. Every legend whose
 * rows overlap the dock vertically is moved right of the dock; the others keep the
 * engine's default position.
 */
export function useRailClearance(appRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = appRef.current;
    if (!root) return;
    let frame = 0;

    const apply = () => {
      frame = 0;
      const rail = root.querySelector<HTMLElement>('.app-rail');
      const r = rail?.getBoundingClientRect();
      const visible = !!r && r.width > 0 && r.height > 0;
      for (const legend of root.querySelectorAll<HTMLElement>('.center .io-legend')) {
        const host = legend.offsetParent as HTMLElement | null;
        if (!visible || !host) {
          legend.style.left = '';
          continue;
        }
        // Measure from the pane, not the legend: its own left is what we change.
        const pane = host.getBoundingClientRect();
        const top = pane.top + legend.offsetTop;
        const bottom = top + legend.offsetHeight;
        const left = pane.left + 8;
        const under = top < r.bottom && bottom > r.top && left < r.right + GAP;
        legend.style.left = under ? `${Math.ceil(r.right + GAP - pane.left)}px` : '';
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const resize = new ResizeObserver(schedule);
    const watch = () => {
      resize.disconnect();
      const rail = root.querySelector('.app-rail');
      if (rail) resize.observe(rail);
      const center = root.querySelector('.center');
      if (center) resize.observe(center);
      // Pane heights move legends up/down; legend height changes with its rows.
      for (const el of root.querySelectorAll('.center .io-legend')) {
        resize.observe(el);
        if (el.parentElement) resize.observe(el.parentElement);
      }
    };
    // Panes come and go (studies added/removed, layout switches), and the rail toggles.
    // Legend text rewrites on every crosshair move: only structural changes count.
    const structural = (n: Node) =>
      n instanceof Element &&
      (n.matches('.io-pane, .io-legend') || !!n.querySelector('.io-pane, .io-legend'));
    const mutations = new MutationObserver((records) => {
      const hit = records.some((m) =>
        m.type === 'attributes'
          ? (m.target as Element).classList.contains('app-rail')
          : [...m.addedNodes, ...m.removedNodes].some(structural),
      );
      if (!hit) return;
      watch();
      schedule();
    });
    mutations.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    watch();
    schedule();
    return () => {
      mutations.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [appRef]);
}
