import { useCallback, useState } from 'react';
import { useContextMenuOpen } from '../../ui/ContextMenu';
import type { HoldKind } from './ResultsTable';

/**
 * Freeze the live row order while the user is reading: pointer over the rows, the keyboard in
 * the grid, a context menu open, or the manual Paused toggle.
 */
export function useHold() {
  const [hold, setHold] = useState({ pointer: false, focus: false });
  const menuOpen = useContextMenuOpen();
  const [manualPause, setManualPause] = useState(false);
  const onHold = useCallback((kind: HoldKind, on: boolean) => {
    setHold((h) => (h[kind] === on ? h : { ...h, [kind]: on }));
  }, []);
  const held = hold.pointer || hold.focus || menuOpen;
  return {
    onHold,
    manualPause,
    togglePause: () => setManualPause((p) => !p),
    frozen: manualPause || held,
    holdReason: (menuOpen ? 'menu' : hold.focus ? 'focus' : hold.pointer ? 'pointer' : null) as
      'menu' | 'focus' | 'pointer' | null,
  };
}
