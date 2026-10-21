/** Chart grid commands (focus moves between charts). */
import { commands, type Command } from '../commands/registry';
import { Maximize2 } from 'lucide-react';
import { useDrawingRuntime } from '../drawings/store';
import { useUiStore } from '../store/ui';
import { isCursorTool } from '../toolbar/tools';
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
      // Dialogs, menus and popovers own Escape while open; so do a drawing tool in
      // progress and a drawing selection (they step back first).
      enabled: () =>
        isMaximized() &&
        !document.querySelector('[data-modal-open], [role="menu"], .io-popover') &&
        isCursorTool(useUiStore.getState().activeTool) &&
        useDrawingRuntime.getState().selection.length === 0,
      run: toggleMaximize,
    },
  ];
  return commands.register(list);
}
