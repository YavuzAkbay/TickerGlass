/** Chart grid commands (focus moves between charts). */
import { commands, type Command } from '../commands/registry';
import { Maximize2 } from 'lucide-react';
import { chartCount, focusStep, isMaximized, toggleMaximize } from './actions';

export function registerGridCommands(): () => void {
  const category = 'Layout';
  const list: Command[] = [
    {
      id: 'layout.chart.next',
      title: 'Focus next chart',
      category,
      shortcut: 'Alt+]',
      enabled: () => chartCount() > 1,
      run: () => focusStep(1),
    },
    {
      id: 'layout.chart.prev',
      title: 'Focus previous chart',
      category,
      shortcut: 'Alt+[',
      enabled: () => chartCount() > 1,
      run: () => focusStep(-1),
    },
    {
      id: 'layout.chart.maximize',
      title: 'Maximize or restore focused chart',
      category,
      shortcut: 'Alt+Enter',
      icon: Maximize2,
      enabled: () => chartCount() > 1 || isMaximized(),
      run: toggleMaximize,
    },
    {
      id: 'layout.chart.restore',
      title: 'Restore maximized chart',
      category,
      hidden: true,
      shortcut: 'Escape',
      // Dialogs and menus own Escape while open.
      enabled: () => isMaximized() && !document.querySelector('[data-modal-open], [role="menu"]'),
      run: toggleMaximize,
    },
  ];
  return commands.register(list);
}
