import { commands, isMac } from './registry';

function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // e.code keeps Alt/Shift combos layout-stable (Alt+R on macOS types "®").
  let key = e.key;
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

function normalize(shortcut: string): string {
  const parts = shortcut.split('+');
  const key = parts.pop()!;
  const mods = ['Mod', 'Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m));
  return [...mods, key.length === 1 ? key.toLowerCase() : key].join('+');
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

type TypeToSearch = (initial: string) => void;

/**
 * Global keyboard handling. Resolves shortcuts declared on commands; a bare
 * printable key outside inputs opens symbol search ("type anywhere").
 */
export function installShortcuts(onTypeToSearch: TypeToSearch): () => void {
  const handler = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const typing = isTyping(e.target);
    const combo = comboFromEvent(e);
    for (const cmd of commands.list()) {
      const list = Array.isArray(cmd.shortcut) ? cmd.shortcut : cmd.shortcut ? [cmd.shortcut] : [];
      if (!list.some((s) => normalize(s) === combo)) continue;
      if (typing && !cmd.allowInInput) continue;
      if (cmd.enabled && !cmd.enabled()) continue;
      e.preventDefault();
      void cmd.run();
      return;
    }
    if (
      !typing &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key.length === 1 &&
      /[\p{L}\p{N}^.=-]/u.test(e.key) &&
      !document.querySelector('[data-modal-open]')
    ) {
      e.preventDefault();
      onTypeToSearch(e.key.toUpperCase());
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
