import { Search } from 'lucide-react';
import { commands, formatShortcut } from '../commands/registry';
import { useT } from '../i18n';
import { firstShortcut, useCommand } from './useCommand';

/** Wide search field look that opens the command palette. */
export function PaletteButton() {
  const t = useT();
  const shortcut = firstShortcut(useCommand('view.commandPalette'));
  return (
    <button
      type="button"
      className="tb-palette"
      aria-label={t('topbar.paletteLabel')}
      onClick={() => commands.execute('view.commandPalette')}
    >
      <Search size={14} strokeWidth={2} />
      <span className="tb-palette-text">{t('topbar.palette')}</span>
      {shortcut ? <kbd className="tb-palette-hint">{formatShortcut(shortcut)}</kbd> : null}
    </button>
  );
}
