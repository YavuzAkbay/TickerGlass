import { useUiStore, type DialogId } from '../store/ui';
import CommandPalette from './CommandPalette';
import CompareDialog from './CompareDialog';
import IndicatorsDialog from './IndicatorsDialog';
import SettingsDialog from './SettingsDialog';
import ShortcutsDialog from './ShortcutsDialog';
import SymbolSearchDialog from './SymbolSearchDialog';
import GoToDateDialog from '../bottombar/GoToDateDialog';
import IntervalInputDialog from './IntervalInputDialog';

type DialogComponent = (props: { onClose: () => void; arg?: unknown }) => React.ReactNode;

const DIALOGS: Record<DialogId, DialogComponent> = {
  symbolSearch: SymbolSearchDialog,
  compare: CompareDialog,
  indicators: IndicatorsDialog,
  settings: SettingsDialog,
  commandPalette: CommandPalette,
  goToDate: GoToDateDialog,
  intervalInput: IntervalInputDialog,
  shortcuts: ShortcutsDialog,
};

/** Renders the single open dialog (one at a time, like reference). */
export function DialogHost() {
  const dialog = useUiStore((s) => s.dialog);
  const arg = useUiStore((s) => s.dialogArg);
  const close = useUiStore((s) => s.closeDialog);
  if (!dialog) return null;
  const Component = DIALOGS[dialog];
  return <Component key={dialog} onClose={close} arg={arg} />;
}
