/** Chart grid commands (focus moves between charts). */
import { commands, type Command } from '../commands/registry';
import { chartCount, focusStep } from './actions';

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
  ];
  return commands.register(list);
}
