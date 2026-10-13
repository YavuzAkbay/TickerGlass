import type { ComponentType } from 'react';

export interface Command {
  id: string;
  title: string;
  category?: string;
  /** e.g. "Mod+K", "Alt+R", "Shift+Mod+Z". Mod = Cmd on macOS, Ctrl elsewhere. */
  shortcut?: string | string[];
  /** Fire the shortcut even while typing in an input. */
  allowInInput?: boolean;
  icon?: ComponentType<{ size?: number }>;
  /** Hidden from the command palette (still runnable by id / shortcut). */
  hidden?: boolean;
  enabled?: () => boolean;
  run: (arg?: unknown) => void | Promise<void>;
}

type Listener = () => void;

/** Single registry for every user action: toolbar buttons, menus, shortcuts
 * and the command palette all execute commands by id. */
class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<Listener>();

  register(cmd: Command | Command[]): () => void {
    const list = Array.isArray(cmd) ? cmd : [cmd];
    for (const c of list) this.commands.set(c.id, c);
    this.notify();
    return () => {
      for (const c of list) if (this.commands.get(c.id) === c) this.commands.delete(c.id);
      this.notify();
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  list(): Command[] {
    return [...this.commands.values()];
  }

  isEnabled(id: string): boolean {
    const c = this.commands.get(id);
    return !!c && (c.enabled?.() ?? true);
  }

  execute(id: string, arg?: unknown): void {
    const c = this.commands.get(id);
    if (!c) {
      console.warn(`unknown command ${id}`);
      return;
    }
    if (c.enabled && !c.enabled()) return;
    void c.run(arg);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

export const commands = new CommandRegistry();

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Human label for a shortcut, e.g. "Mod+K" -> "⌘K" / "Ctrl+K". */
export function formatShortcut(shortcut: string | string[] | undefined): string {
  const s = Array.isArray(shortcut) ? shortcut[0] : shortcut;
  if (!s) return '';
  const parts = s.split('+');
  if (isMac) {
    const map: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' };
    return parts.map((p) => map[p] ?? p.toUpperCase()).join('');
  }
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p.length === 1 ? p.toUpperCase() : p)).join('+');
}
