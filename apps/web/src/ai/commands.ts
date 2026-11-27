/** Ask AI commands (palette, shortcut, menus); enabled only when the server has AI on. */
import { MessageSquareText, ScanSearch } from 'lucide-react';
import { commands, type Command } from '../commands/registry';
import { getChart } from '../store/chart';
import { useUiStore } from '../store/ui';
import { startRangeSelect } from './attach';
import { useAiChat, useAiStatus } from './store';

const aiOn = () => useAiStatus.getState().status?.enabled === true;

export function registerAiCommands(): () => void {
  const list: Command[] = [
    {
      id: 'ai.selectRange',
      title: 'Ask AI about a range…',
      category: 'Chart',
      shortcut: 'Alt+Q',
      icon: ScanSearch,
      enabled: () => aiOn() && !!getChart(),
      run: () => {
        startRangeSelect();
      },
    },
    {
      id: 'ai.open',
      title: 'Ask AI about the chart',
      category: 'Panels',
      icon: MessageSquareText,
      enabled: aiOn,
      run: () => {
        useUiStore.getState().showNav('ai');
        useAiChat.getState().requestFocus();
      },
    },
  ];
  return commands.register(list);
}
