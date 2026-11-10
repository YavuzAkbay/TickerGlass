/**
 * Destructive and bulk watchlist actions with user feedback: removals show a
 * toast with "Undo", moves report what actually moved. Components and menus
 * call these instead of the store actions so every path behaves the same.
 */
import { normalizeSymbol } from '../store/app';
import { actionToast, toast } from '../ui/Toast';
import { isFlagRef } from './model';
import { useWatchlistStore, type MoveResult, type UndoSnapshot } from './store';
import type { FlagColor, ListRef } from './types';

export const UNDO_TOAST_MS = 8000;

const plural = (n: number, word = 'symbol'): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function undoToast(message: string, undo: () => void): void {
  actionToast(message, [{ label: 'Undo', run: undo }], 'success', UNDO_TOAST_MS);
}

/**
 * Undo a removal. Entries the user already put back count as restored; only entries that
 * are really gone (list full, list deleted) are reported.
 */
function restoreWithReport(snap: UndoSnapshot): void {
  const st = useWatchlistStore.getState();
  const list = st.lists[snap.listId];
  if (!list) {
    toast('List no longer exists', 'error');
    return;
  }
  const syms = new Set(list.items.flatMap((i) => (i.type === 'symbol' ? [i.symbol] : [])));
  const sids = new Set(list.items.flatMap((i) => (i.type === 'section' ? [i.id] : [])));
  const total = snap.entries.length;
  const already = snap.entries.filter(({ item }) =>
    item.type === 'symbol' ? syms.has(item.symbol) : sids.has(item.id),
  ).length;
  const done = already + st.restore(snap);
  if (done < total)
    toast(done ? `Restored ${done} of ${total}` : 'Nothing could be restored', 'error');
}

/**
 * Remove symbols from a list (or unflag them in a flag list) and offer "Undo".
 * Returns how many were removed (0: nothing to do, no toast).
 */
export function removeWithUndo(ref: ListRef, symbols: string[]): number {
  const store = useWatchlistStore.getState();
  if (isFlagRef(ref)) {
    const color = ref.slice(5) as FlagColor;
    const had = [...new Set(symbols.map(normalizeSymbol))].filter(
      (s) => store.flags[s]?.color === color,
    );
    if (!had.length) return 0;
    // Keep the original timestamps: flag lists order by `at`, so undo must not reshuffle them.
    const saved = new Map(had.map((s) => [s, store.flags[s]!.at]));
    for (const s of had) store.setFlag(s, null);
    undoToast(
      had.length === 1 ? `Removed flag from ${had[0]}` : `Removed flags from ${plural(had.length)}`,
      () => {
        const st = useWatchlistStore.getState();
        for (const s of had) if (!st.flags[s]) st.setFlag(s, color, saved.get(s));
      },
    );
    return had.length;
  }
  const snap = store.removeSymbols(ref, symbols);
  if (!snap) return 0;
  const n = snap.entries.length;
  undoToast(
    n === 1
      ? `Removed ${(snap.entries[0]!.item as { symbol: string }).symbol}`
      : `Removed ${plural(n)}`,
    () => restoreWithReport(snap),
  );
  return n;
}

/** Remove a section (and its symbols unless `keepSymbols`) and offer "Undo". */
export function removeSectionWithUndo(listId: string, sid: string, keepSymbols: boolean): boolean {
  const snap = useWatchlistStore.getState().removeSection(listId, sid, keepSymbols);
  if (!snap) return false;
  const symbols = snap.entries.filter((e) => e.item.type === 'symbol').length;
  undoToast(symbols ? `Removed section and ${plural(symbols)}` : 'Removed section', () =>
    restoreWithReport(snap),
  );
  return true;
}

/** Toast text for a move: the actual count, and what stayed behind. */
export function describeMove(r: MoveResult, toName: string): string {
  const base = r.moved
    ? `Moved ${plural(r.moved)} to ${toName}`
    : r.alreadyThere
      ? `${plural(r.alreadyThere)} already in ${toName}`
      : `Nothing moved to ${toName}`;
  const extra: string[] = [];
  if (r.moved && r.alreadyThere) extra.push(`${r.alreadyThere} already there`);
  if (r.leftBehind) extra.push(`${r.leftBehind} didn't fit (list is full)`);
  return extra.length ? `${base}; ${extra.join('; ')}` : base;
}

/** Move symbols between lists and say what happened. */
export function moveWithReport(
  fromId: string,
  toId: string,
  toName: string,
  symbols: string[],
): MoveResult {
  const r = useWatchlistStore.getState().moveSymbolsDetailed(fromId, toId, symbols);
  toast(describeMove(r, toName), r.leftBehind ? 'error' : 'success');
  return r;
}
