import { create } from 'zustand';

/** Where the quick-tools menu is open (viewport px), or null. */
export const useQuickTools = create<{ at: { x: number; y: number } | null }>(() => ({ at: null }));

let pointer: { x: number; y: number } | null = null;
if (typeof window !== 'undefined')
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true, capture: true },
  );

/** Open the quick-tools menu at the pointer when it is over the chart, else mid-chart. */
export function openQuickTools(): void {
  const area = document.querySelector('.chart-area')?.getBoundingClientRect();
  const inside =
    pointer &&
    area &&
    pointer.x >= area.left &&
    pointer.x <= area.right &&
    pointer.y >= area.top &&
    pointer.y <= area.bottom;
  const at = inside
    ? pointer!
    : area
      ? { x: area.left + area.width / 2 - 140, y: area.top + area.height / 3 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  useQuickTools.setState({ at });
}

export function closeQuickTools(): void {
  useQuickTools.setState({ at: null });
}
