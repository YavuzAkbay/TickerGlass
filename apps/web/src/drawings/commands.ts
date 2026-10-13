import { ClipboardCopy, ClipboardPaste, Copy, Trash2 } from 'lucide-react';
import { commands, type Command } from '../commands/registry';
import { getChart } from '../store/chart';
import {
  cloneDrawings,
  copyDrawings,
  pasteDrawings,
  removeDrawings,
  selectAllDrawings,
} from './actions';
import { openDrawingSettings } from './menu';
import { useDrawingRuntime } from './store';

const selection = () => useDrawingRuntime.getState().selection;
const hasSelection = () => selection().length > 0;
const modalOpen = () => !!document.querySelector('[data-modal-open], .io-popover');

/**
 * Mod+C/V/A act on drawings only when the user is not copying/pasting/
 * selecting text: no dialog or popover open, no text selected, and focus on
 * the chart (or nowhere). Otherwise the browser's native behaviour runs.
 */
export function chartClipboardTarget(): boolean {
  if (modalOpen()) return false;
  if (window.getSelection()?.toString()) return false;
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  return !!getChart()?.root.contains(active);
}

/**
 * Keyboard and palette commands for the selected drawings. The engine handles
 * Esc/Delete itself while the chart has focus (and prevents the default), so
 * these cover focus elsewhere (e.g. after clicking the floating toolbar).
 */
export function registerDrawingCommands(): () => void {
  const list: Command[] = [
    {
      id: 'drawings.copy',
      title: 'Copy selected drawings',
      category: 'Drawings',
      shortcut: 'Mod+c',
      icon: ClipboardCopy,
      enabled: () => hasSelection() && chartClipboardTarget(),
      run: () => void copyDrawings(selection()),
    },
    {
      id: 'drawings.paste',
      title: 'Paste drawings',
      category: 'Drawings',
      shortcut: 'Mod+v',
      icon: ClipboardPaste,
      enabled: () =>
        !!useDrawingRuntime.getState().clipboard && !!getChart() && chartClipboardTarget(),
      run: () => void pasteDrawings(),
    },
    {
      id: 'drawings.clone',
      title: 'Clone selected drawings',
      category: 'Drawings',
      icon: Copy,
      enabled: hasSelection,
      run: () => void cloneDrawings(selection()),
    },
    {
      id: 'drawings.removeSelected',
      title: 'Remove selected drawings',
      category: 'Drawings',
      shortcut: ['Delete', 'Backspace'],
      icon: Trash2,
      enabled: () => hasSelection() && !modalOpen(),
      run: () => removeDrawings(selection(), { skipLocked: true }),
    },
    {
      id: 'drawings.selectAll',
      title: 'Select all drawings',
      category: 'Drawings',
      shortcut: 'Mod+a',
      enabled: () => !!getChart() && chartClipboardTarget(),
      run: selectAllDrawings,
    },
    {
      id: 'drawings.deselect',
      title: 'Clear drawing selection',
      category: 'Drawings',
      shortcut: 'Escape',
      hidden: true,
      enabled: () => hasSelection() && !modalOpen(),
      run: () => getChart()?.selectDrawings([]),
    },
    {
      id: 'drawings.settings',
      title: 'Drawing settings',
      hidden: true,
      enabled: () => selection().length === 1,
      run: () => {
        const id = selection()[0];
        if (id) openDrawingSettings(id);
      },
    },
  ];
  return commands.register(list);
}
