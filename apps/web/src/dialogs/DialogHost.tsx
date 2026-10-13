import { lazy, Suspense } from 'react';
import { useUiStore, type DialogId } from '../store/ui';
import CommandPalette from './CommandPalette';
import IntervalInputDialog from './IntervalInputDialog';
import SymbolSearchDialog from './SymbolSearchDialog';

type DialogComponent = (props: { onClose: () => void; arg?: unknown }) => React.ReactNode;

// Keyboard-first dialogs stay in the main chunk so they open on the first key
// press; the heavier dialogs load on first open (keeps the main chunk small).
const DIALOGS: Record<DialogId, DialogComponent | React.LazyExoticComponent<DialogComponent>> = {
  symbolSearch: SymbolSearchDialog,
  commandPalette: CommandPalette,
  intervalInput: IntervalInputDialog,
  compare: lazy(() => import('./CompareDialog')),
  indicators: lazy(() => import('./IndicatorsDialog')),
  indicatorSettings: lazy(() => import('./IndicatorSettingsDialog')),
  drawingSettings: lazy(() => import('./DrawingSettingsDialog')),
  settings: lazy(() => import('./SettingsDialog')),
  goToDate: lazy(() => import('../bottombar/GoToDateDialog')),
  shortcuts: lazy(() => import('./ShortcutsDialog')),
};

/** Renders the single open dialog (one at a time, like reference). */
export function DialogHost() {
  const dialog = useUiStore((s) => s.dialog);
  const arg = useUiStore((s) => s.dialogArg);
  const close = useUiStore((s) => s.closeDialog);
  if (!dialog) return null;
  const Component = DIALOGS[dialog];
  return (
    <Suspense fallback={null}>
      <Component key={dialog} onClose={close} arg={arg} />
    </Suspense>
  );
}
