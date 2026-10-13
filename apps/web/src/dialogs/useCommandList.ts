import { useSyncExternalStore } from 'react';
import { commands, type Command } from '../commands/registry';

// Stable snapshot for useSyncExternalStore, refreshed whenever the registry changes.
let snapshot: Command[] = commands.list();
commands.subscribe(() => {
  snapshot = commands.list();
});
const subscribe = (fn: () => void) => commands.subscribe(fn);
const getSnapshot = () => snapshot;

/** All registered commands; re-renders when commands are (un)registered. */
export function useCommandList(): Command[] {
  return useSyncExternalStore(subscribe, getSnapshot);
}
