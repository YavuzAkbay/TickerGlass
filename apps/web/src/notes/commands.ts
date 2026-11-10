import { commands, type Command } from '../commands/registry';
import { useUiStore } from '../store/ui';
import { useNotesTarget } from './state';

/** Open the Notes panel on `symbol`'s note (null: the chart's symbol, following it). */
export function openNoteFor(symbol: string | null): void {
  const ui = useUiStore.getState();
  // A full-window screen covers the panel.
  if (ui.screen !== 'charts') ui.closeScreen();
  useNotesTarget.getState().open(symbol);
  // `showNav` opens (never toggles closed) the section.
  useUiStore.getState().showNav('notes');
}

function symbolArg(arg: unknown): string | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const s = (arg as { symbol?: unknown }).symbol;
  return typeof s === 'string' && s.trim() ? s : null;
}

/** Palette / button entry points of the Notes panel. */
export function registerNotesCommands(): () => void {
  const list: Command[] = [
    {
      id: 'notes.openForSymbol',
      title: 'Open note for current symbol',
      category: 'Notes',
      // With a symbol argument the panel is pinned to it; without, it follows the chart.
      run: (arg) => openNoteFor(symbolArg(arg)),
    },
  ];
  return commands.register(list);
}

/** Open the note of `symbol` (used by badges and the detail pane). */
export function openNote(symbol: string): void {
  commands.execute('notes.openForSymbol', { symbol });
}
