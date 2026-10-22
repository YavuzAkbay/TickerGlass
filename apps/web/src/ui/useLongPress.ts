import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

const DELAY = 450;
const SLOP = 10;

/**
 * Touch long-press -> `onLongPress(x, y)`. iOS never fires `contextmenu` on a
 * long press, so rows with a context menu use this to be reachable on touch.
 * Mouse/pen are ignored (they have right-click). The click that follows a
 * long press is swallowed (capture phase) so it does not also activate the row.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const cbRef = useRef(onLongPress);
  useEffect(() => {
    cbRef.current = onLongPress;
  });

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return {
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        cbRef.current(start.current.x, start.current.y);
      }, DELAY);
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (!timer.current) return;
      if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
      if (!fired.current) return;
      fired.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}
