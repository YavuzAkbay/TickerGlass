/** What importing a share payload does to the local data (the dialog adds the confirmation and toasts). */
import type { MessageKey, MessageParams } from '../i18n';
import type { Group, ScreenSpec } from '../screener/server/types';
import { useWatchlistPrefs } from '../watchlist/prefs';
import { DEFAULT_LIST_NAME, useWatchlistStore } from '../watchlist/store';
import { fromShareItems, MAX_NAME, symbolCount, type WatchlistShare } from './codec';

/** `base`, or `base (2)`, `base (3)`, ... when the name is taken (case-insensitive). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.trim().toLowerCase()));
  const name = base.trim().slice(0, MAX_NAME) || DEFAULT_LIST_NAME;
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Rules in a filter, groups not counted. */
export function countRules(group: Group | null): number {
  if (!group) return 0;
  return group.rules.reduce((n, r) => n + ('rules' in r ? countRules(r) : 1), 0);
}

export const sectionCount = (items: WatchlistShare['items']): number =>
  items.length - symbolCount(items);

export type WatchlistTarget = { mode: 'new'; name: string } | { mode: 'existing'; id: string };

export interface WatchlistImportResult {
  id: string;
  name: string;
  /** Symbols now in the list that came from the payload. */
  added: number;
  /** Symbols of the payload left out (already in the target, or the list is full). */
  skipped: number;
}

/**
 * Create a list from the payload, or add its symbols to an existing list (sections are only
 * brought along into a new list). The list becomes the active one.
 */
export function importWatchlist(
  payload: WatchlistShare,
  target: WatchlistTarget,
): WatchlistImportResult | null {
  const store = useWatchlistStore.getState();
  const total = symbolCount(payload.items);
  let id: string;
  let name: string;
  let added: number;
  if (target.mode === 'new') {
    name = uniqueName(
      target.name,
      Object.values(store.lists).map((l) => l.name),
    );
    id = store.createList(name, fromShareItems(payload.items));
    added = useWatchlistStore
      .getState()
      .lists[id]!.items.reduce((n, i) => n + (i.type === 'symbol' ? 1 : 0), 0);
  } else {
    const entry = store.lists[target.id];
    if (!entry) return null;
    id = entry.id;
    name = entry.name;
    added = store.addSymbols(
      id,
      payload.items.filter((i): i is string => typeof i === 'string'),
    ).length;
  }
  useWatchlistPrefs.getState().setActive(id);
  return { id, name, added, skipped: total - added };
}

export interface SpecSummary {
  universe: { kind: 'class' | 'list' | 'symbols'; value: string };
  rules: number;
  sort: string;
  columns: number;
}

export function summarizeSpec(spec: ScreenSpec): SpecSummary {
  const u = spec.universe;
  return {
    universe:
      u.kind === 'class'
        ? { kind: 'class', value: u.cls }
        : u.kind === 'list'
          ? { kind: 'list', value: u.id }
          : { kind: 'symbols', value: u.kind === 'symbols' ? String(u.symbols.length) : '' },
    rules: countRules(spec.filter),
    sort: `${spec.sort.field} ${spec.sort.dir === 'asc' ? '↑' : '↓'}`,
    columns: spec.columns?.length ?? 0,
  };
}

/** Universe of a screen in words. */
export function universeText(
  t: (key: MessageKey, params?: MessageParams) => string,
  spec: ScreenSpec,
): string {
  const u = summarizeSpec(spec).universe;
  return t(`share.import.universe.${u.kind}` as const, { value: u.value });
}
