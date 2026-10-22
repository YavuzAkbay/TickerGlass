import { Suspense } from 'react';
import { useUiStore, type DialogId } from '../store/ui';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { retryableLazy, type RetryableLazy } from '../ui/lazyRetry';
import { actionToast } from '../ui/Toast';
import CommandPalette from './CommandPalette';
import IntervalInputDialog from './IntervalInputDialog';
import SymbolSearchDialog from './SymbolSearchDialog';

type DialogComponent = (props: { onClose: () => void; arg?: unknown }) => React.ReactNode;

// Keyboard-first dialogs stay in the main chunk so they open on the first key
// press; the heavier dialogs load on first open (keeps the main chunk small).
const DIALOGS: Record<DialogId, DialogComponent | RetryableLazy<DialogComponent>> = {
  symbolSearch: SymbolSearchDialog,
  commandPalette: CommandPalette,
  intervalInput: IntervalInputDialog,
  compare: retryableLazy(() => import('./CompareDialog')),
  indicators: retryableLazy(() => import('./IndicatorsDialog')),
  settings: retryableLazy(() => import('./SettingsDialog')),
  goToDate: retryableLazy(() => import('../bottombar/GoToDateDialog')),
  shortcuts: retryableLazy(() => import('./ShortcutsDialog')),
  loadLayout: retryableLazy(() => import('./LoadLayoutDialog')),
  dataTransfer: retryableLazy(() => import('./DataTransferDialog')),
  alert: retryableLazy(() => import('./AlertDialog')),
  scriptEditor: retryableLazy(() => import('./ScriptEditorDialog')),
  dataSource: retryableLazy(() => import('../setup/DataSourceDialog')),
};

/** What renders for each dialog now (a lazy one is replaced after a failed load). */
const COMPONENTS = Object.fromEntries(
  Object.entries(DIALOGS).map(([id, e]) => [id, typeof e === 'object' ? e.get() : e]),
) as Record<DialogId, DialogComponent | React.LazyExoticComponent<DialogComponent>>;

/**
 * A dialog failed to load (e.g. its chunk could not be fetched after a
 * deploy or while offline) or crashed: close it and offer a retry, instead
 * of taking the whole app down.
 */
export function reportDialogError(id: DialogId, arg: unknown, error: Error): void {
  const ui = useUiStore.getState();
  if (ui.dialog === id) ui.closeDialog();
  // A failed chunk import stays failed in React.lazy: start over on retry.
  const entry = DIALOGS[id];
  if (typeof entry === 'object') {
    entry.reset();
    COMPONENTS[id] = entry.get();
  }
  actionToast(
    `The dialog could not be opened: ${error.message}`,
    [{ label: 'Retry', run: () => useUiStore.getState().openDialog(id, arg) }],
    'error',
    10_000,
  );
}

/** Renders the single open dialog (one at a time). */
export function DialogHost() {
  const dialog = useUiStore((s) => s.dialog);
  const arg = useUiStore((s) => s.dialogArg);
  const close = useUiStore((s) => s.closeDialog);
  if (!dialog) return null;
  const Component = COMPONENTS[dialog];
  return (
    <ErrorBoundary
      key={dialog}
      fallback={() => null}
      onError={(error) => reportDialogError(dialog, arg, error)}
    >
      <Suspense fallback={null}>
        <Component onClose={close} arg={arg} />
      </Suspense>
    </ErrorBoundary>
  );
}
