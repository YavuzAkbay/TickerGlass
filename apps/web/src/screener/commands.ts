import { commands, type Command } from '../commands/registry';
import { useUiStore } from '../store/ui';

/** Palette/shortcut entry points of the screener screen. */
export function registerScreenerCommands(): () => void {
  const category = 'Screener';
  const list: Command[] = [
    {
      id: 'view.screener',
      title: 'Open market screener',
      category,
      shortcut: 'Alt+Shift+S',
      run: () => useUiStore.getState().openScreen('screener'),
    },
    {
      id: 'view.screener.close',
      title: 'Close market screener',
      category,
      enabled: () => useUiStore.getState().screen === 'screener',
      run: () => useUiStore.getState().closeScreen(),
    },
  ];
  return commands.register(list);
}
