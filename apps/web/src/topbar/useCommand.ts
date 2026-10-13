import { useSyncExternalStore } from 'react';
import { commands, type Command } from '../commands/registry';

const subscribe = (fn: () => void) => commands.subscribe(fn);

/** Live lookup of a registered command (commands register after first render). */
export function useCommand(id: string): Command | undefined {
  return useSyncExternalStore(subscribe, () => commands.get(id));
}

/** First shortcut of a command, for tooltips. */
export function firstShortcut(cmd: Command | undefined): string | undefined {
  const s = cmd?.shortcut;
  return Array.isArray(s) ? s[0] : s;
}
