// Undoable mutations of the drawing store. User gestures on the chart arrive
// as engine events (./attach -> recordGesture); app edits (toolbar, menus,
// dialogs, object tree) call the functions below. The store is the source of
// truth: ./attach reconciles the engine with it after every change, so undo
// and redo only touch the store (docs/drawings.md §5).
import type { Drawing, DrawingPatch, DrawingStyle } from '@tickerglass/engine';
import { useHistory, type UndoEntry } from '../commands/history';
import { useIndicatorStore } from '../indicators/store';
import { useChartView } from '../store/chartView';
import { getActiveSession, getChart } from '../store/chart';
import { toast } from '../ui/Toast';
import { deepEqual, patchDrawing, toolName } from './model';
import { drawingsFor, findStoredDrawing, useDrawingClipboard, useDrawingStore } from './store';

/** One drawing before/after an action; null = absent (created / removed). */
export interface Change {
  before: Drawing | null;
  after: Drawing | null;
}

const store = () => useDrawingStore.getState();
const idOf = (c: Change) => (c.after ?? c.before)!.id;

/** Drawings of the current chart (current symbol + synced, minus those bound to other charts). */
export function currentDrawings(): Drawing[] {
  return drawingsFor(store(), useChartView.getState().symbol, getActiveSession()?.id ?? '');
}

export function findDrawing(id: string): Drawing | undefined {
  return findStoredDrawing(id);
}

/** Collapse changes per id (first `before`, last `after`) and drop no-ops. */
export function mergeChanges(list: readonly Change[]): Change[] {
  const byId = new Map<string, Change>();
  for (const c of list) {
    const id = idOf(c);
    const prev = byId.get(id);
    byId.set(id, prev ? { before: prev.before, after: c.after } : { ...c });
  }
  return [...byId.values()].filter((c) => (c.before || c.after) && !deepEqual(c.before, c.after));
}

/** Put the store in the `after` (redo) or `before` (undo) state of `changes`. */
export function applyChanges(changes: readonly Change[], dir: 'undo' | 'redo'): void {
  const upserts: Drawing[] = [];
  const removes: string[] = [];
  for (const c of changes) {
    const target = dir === 'redo' ? c.after : c.before;
    if (target) upserts.push(structuredClone(target));
    else removes.push(idOf(c));
  }
  store().apply(upserts, removes);
}

// ------------------------------------------------------------ history

const COALESCE_MS = 1000;
let last: { entry: UndoEntry; key: string; at: number; changes: Change[] } | null = null;
/** Changes behind each drawing entry (see `amendCreated`). */
const entryChanges = new WeakMap<UndoEntry, Change[]>();

function entryFor(label: string, changes: Change[]): UndoEntry {
  const entry: UndoEntry = {
    label,
    undo: () => applyChanges(changes, 'undo'),
    redo: () => applyChanges(changes, 'redo'),
  };
  entryChanges.set(entry, changes);
  return entry;
}

/**
 * Push one undo entry for changes already applied to the store. With
 * `coalesceKey`, a repeat of the same action within a second (colour picker
 * drags, typing) extends the previous entry instead.
 */
export function record(label: string, changes: readonly Change[], coalesceKey?: string): void {
  const now = Date.now();
  const history = useHistory.getState();
  // Side effects of an undo/redo are part of that step, not new ones.
  if (history.applying) return;
  if (
    coalesceKey &&
    last &&
    last.key === coalesceKey &&
    now - last.at < COALESCE_MS &&
    history.past.at(-1) === last.entry
  ) {
    const merged = mergeChanges([...last.changes, ...changes]);
    const entry = entryFor(label, merged);
    useHistory.setState((s) => ({ past: [...s.past.slice(0, -1), entry], future: [] }));
    last = { entry, key: coalesceKey, at: now, changes: merged };
    return;
  }
  const merged = mergeChanges(changes);
  if (!merged.length) return;
  const entry = entryFor(label, merged);
  history.push(entry);
  last = coalesceKey ? { entry, key: coalesceKey, at: now, changes: merged } : null;
}

/** Apply changes to the store and record them as one undo step. */
export function commit(label: string, changes: readonly Change[], coalesceKey?: string): void {
  const merged = mergeChanges(changes);
  if (!merged.length) return;
  applyChanges(merged, 'redo');
  record(label, merged, coalesceKey);
}

/** Position in the history for `foldHistorySince`: the newest entry (null = empty). */
export type HistoryMark = UndoEntry | null;

export function historyMark(): HistoryMark {
  return useHistory.getState().past.at(-1) ?? null;
}

/**
 * Fold every history entry pushed after `mark` into one (pane removal:
 * studies + drawings). The mark is an entry, not an index, so it survives
 * the history cap trimming the front. A mark that is gone does nothing.
 */
export function foldHistorySince(mark: HistoryMark, label: string): void {
  const past = useHistory.getState().past;
  const at = mark ? past.lastIndexOf(mark) : -1;
  if (mark && at < 0) return;
  const entries = past.slice(at + 1);
  if (entries.length < 2) return;
  const entry: UndoEntry = {
    label,
    undo: () => [...entries].reverse().forEach((e) => e.undo()),
    redo: () => entries.forEach((e) => e.redo()),
  };
  useHistory.setState({ past: [...past.slice(0, at + 1), entry] });
  last = null;
}

/**
 * Amend the newest history entry when it created `id` (a new text drawing
 * whose editor just closed): `after` replaces the created drawing, null
 * drops it (and the entry when nothing else is in it). The store follows.
 * Returns false (nothing done) when the newest entry did not create `id`.
 */
export function amendCreated(id: string, after: Drawing | null): boolean {
  flushGestures();
  const history = useHistory.getState();
  const top = history.past.at(-1);
  const changes = top && entryChanges.get(top);
  const created = changes?.find((c) => c.before === null && c.after?.id === id);
  if (!top || !changes || !created) return false;
  const merged = mergeChanges(
    after
      ? changes.map((c) => (c === created ? { before: null, after } : c))
      : changes.filter((c) => c !== created),
  );
  if (after) store().apply([structuredClone(after)]);
  else store().apply([], [id]);
  const past = history.past.slice(0, -1);
  useHistory.setState({ past: merged.length ? [...past, entryFor(top.label, merged)] : past });
  last = null;
  return true;
}

/**
 * Apply the editor's result (`text` null = cancelled). For a drawing just
 * created, the result folds into its Create step: left empty, the drawing
 * and the step disappear; typed text is part of the creation.
 */
export function finishTextEdit(id: string, created: boolean, text: string | null): void {
  const d = findDrawing(id);
  if (!d) return;
  const result = text ?? d.text;
  if (created && !result.trim()) {
    if (!amendCreated(id, null)) removeDrawings([id]);
    return;
  }
  if (text === null || text === d.text) return;
  if (created && amendCreated(id, patchDrawing(d, { text }))) return;
  updateDrawings([id], { text }, 'Edit text');
}

// ---------------------------------------------------- engine gestures

let batch: { label: string; changes: Change[] } | null = null;
let labelOverride: string | null = null;

/**
 * A user gesture already applied by the engine (drawingCreated/Changed/
 * Removed). The store follows immediately; the history entry is pushed at the
 * end of the task so multi-event gestures (Alt+drag clone, paste) are one step.
 */
export function recordGesture(label: string, changes: readonly Change[]): void {
  applyChanges(changes, 'redo');
  if (!batch) {
    batch = { label: labelOverride ?? label, changes: [] };
    queueMicrotask(flushGestures);
  }
  batch.changes.push(...changes);
}

/** Push the pending gesture entry now (tests, and before reading history). */
export function flushGestures(): void {
  const b = batch;
  batch = null;
  if (b) record(b.label, b.changes);
}

/** A labelled API gesture (paste, clone in place) is emitting events right now. */
export function inLabelledGesture(): boolean {
  return labelOverride !== null;
}

/** Label gesture events emitted synchronously by `fn` (e.g. 'Paste drawings'). */
function withGestureLabel<T>(label: string, fn: () => T): T {
  const prev = labelOverride;
  labelOverride = label;
  try {
    return fn();
  } finally {
    labelOverride = prev;
  }
}

/** Amend the pending gesture of `id` (e.g. apply the user's default style to a new drawing). */
export function amendGesture(id: string, patch: DrawingPatch): void {
  const d = findDrawing(id);
  if (!d) return;
  const after = patchDrawing(d, patch);
  if (deepEqual(after, d)) return;
  recordGesture(batch?.label ?? 'Edit drawing', [{ before: d, after }]);
}

// ------------------------------------------------------------ actions

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const existing = (ids: readonly string[]): Drawing[] =>
  ids.map((id) => findDrawing(id)).filter((d): d is Drawing => !!d);

/** Patch drawings as one undo step. */
export function updateDrawings(
  ids: readonly string[],
  patch: DrawingPatch | ((d: Drawing) => DrawingPatch),
  label: string,
  coalesceKey?: string,
): void {
  const changes = existing(ids).map((d) => ({
    before: d,
    after: patchDrawing(d, typeof patch === 'function' ? patch(d) : patch),
  }));
  commit(label, changes, coalesceKey);
}

export function setDrawingStyle(
  ids: readonly string[],
  style: DrawingStyle,
  label: string,
  coalesceKey?: string,
): void {
  updateDrawings(ids, { style }, label, coalesceKey);
}

/** Remove drawings (one undo step). `skipLocked` matches the engine's Delete key. */
export function removeDrawings(ids: readonly string[], opts: { skipLocked?: boolean } = {}): void {
  const list = existing(ids).filter((d) => !(opts.skipLocked && d.locked));
  if (!list.length) return;
  commit(
    list.length === 1 ? `Remove ${toolName(list[0]!.type)}` : 'Remove drawings',
    list.map((d) => ({ before: d, after: null })),
  );
}

export function toggleLocked(ids: readonly string[]): void {
  const list = existing(ids);
  const lock = !list.every((d) => d.locked);
  updateDrawings(
    ids,
    { locked: lock },
    lock ? plural(list.length, 'Lock drawing', 'Lock drawings') : 'Unlock drawings',
  );
}

export function toggleHidden(ids: readonly string[]): void {
  const list = existing(ids);
  const hide = !list.every((d) => d.hidden);
  updateDrawings(ids, { hidden: hide }, hide ? 'Hide drawings' : 'Show drawings');
}

/** Patch moving `d` to `scope`: a per-symbol drawing without a symbol takes the current one. */
export function scopePatch(d: Drawing, scope: Drawing['scope']): Pick<Drawing, 'scope' | 'symbol'> {
  const symbol = useChartView.getState().symbol;
  return { scope, symbol: scope === 'symbol' && !d.symbol ? symbol : d.symbol };
}

/** Per-symbol or synced across symbols. Synced drawings follow every symbol switch. */
export function setScope(ids: readonly string[], scope: Drawing['scope']): void {
  updateDrawings(
    ids,
    (d) => scopePatch(d, scope),
    scope === 'all' ? 'Sync drawings to all symbols' : 'Keep drawings on this symbol',
  );
}

export function setVisibility(ids: readonly string[], visibility: Drawing['visibility']): void {
  updateDrawings(ids, { visibility }, 'Change visibility');
}

// ------------------------------------------------------------ z-order

export type ZOrderOp = 'front' | 'forward' | 'backward' | 'back';

/** Drawings in `paneId` bottom-to-top (zIndex, ties in store order). */
export function paneStack(paneId: string): Drawing[] {
  return currentDrawings()
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.paneId === paneId)
    .sort((a, b) => a.d.zIndex - b.d.zIndex || a.i - b.i)
    .map(({ d }) => d);
}

/** Renumber `paneId`'s zIndex to match `order` (ids bottom-to-top) as one undo step. */
export function reorderPane(paneId: string, order: readonly string[], label: string): void {
  const stack = paneStack(paneId);
  const byId = new Map(stack.map((d) => [d.id, d]));
  const ids = [...order.filter((id) => byId.has(id)), ...stack.map((d) => d.id)];
  const seen = new Set<string>();
  const ordered = ids.filter((id) => !seen.has(id) && seen.add(id));
  const base = stack.length ? Math.min(...stack.map((d) => d.zIndex)) : 0;
  commit(
    label,
    ordered.map((id, i) => {
      const d = byId.get(id)!;
      return { before: d, after: { ...structuredClone(d), zIndex: base + i } };
    }),
  );
}

/** New bottom-to-top order after a z-order op on `selected`. */
export function zOrderStack(stack: readonly string[], selected: ReadonlySet<string>, op: ZOrderOp) {
  const sel = stack.filter((id) => selected.has(id));
  const rest = stack.filter((id) => !selected.has(id));
  if (op === 'front') return [...rest, ...sel];
  if (op === 'back') return [...sel, ...rest];
  const out = [...stack];
  if (op === 'forward') {
    for (let i = out.length - 2; i >= 0; i--)
      if (selected.has(out[i]!) && !selected.has(out[i + 1]!))
        [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
  } else {
    for (let i = 1; i < out.length; i++)
      if (selected.has(out[i]!) && !selected.has(out[i - 1]!))
        [out[i], out[i - 1]] = [out[i - 1]!, out[i]!];
  }
  return out;
}

const Z_LABELS: Record<ZOrderOp, string> = {
  front: 'Bring to front',
  forward: 'Bring forward',
  backward: 'Send backward',
  back: 'Send to back',
};

export function zOrder(ids: readonly string[], op: ZOrderOp): void {
  const label = Z_LABELS[op];
  const chart = getChart();
  if (chart) {
    // The engine applies the change without events; record what it returns.
    const changes =
      op === 'front'
        ? chart.bringToFront(ids)
        : op === 'back'
          ? chart.sendToBack(ids)
          : op === 'forward'
            ? chart.bringForward(ids)
            : chart.sendBackward(ids);
    commit(label, changes);
    return;
  }
  const panes = new Set(existing(ids).map((d) => d.paneId));
  const selected = new Set(ids);
  for (const paneId of panes) {
    const stack = paneStack(paneId).map((d) => d.id);
    reorderPane(paneId, zOrderStack(stack, selected, op), label);
  }
}

// ---------------------------------------------------- copy / paste / clone

/** Pastes of the current clipboard so far: each lands one bar further right. */
let pastes = { json: '', count: 0 };

/** Copy drawings to the app clipboard (Ctrl+C). */
export function copyDrawings(ids: readonly string[]): boolean {
  const list = existing(ids);
  const chart = getChart();
  if (!list.length || !chart) return false;
  const json = chart.copyDrawings(list.map((d) => d.id));
  pastes = { json, count: 0 };
  useDrawingClipboard.setState({ clipboard: json });
  return true;
}

/**
 * Paste clipboard JSON on the current chart (a user gesture: the engine emits
 * drawingCreated per copy, recorded as one undo step) and select the copies.
 * Copies from a pane that no longer exists move to the main pane.
 */
function insertCopies(json: string, label: string, offset: number): string[] {
  const chart = getChart();
  if (!chart) return [];
  let pasted: Drawing[];
  try {
    pasted = withGestureLabel(label, () => chart.pasteDrawings(json, { offset }));
  } catch (err) {
    toast(`Cannot paste: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return [];
  }
  const panes = new Set(chart.getState().panes.map((p) => p.id));
  for (const d of pasted) if (!panes.has(d.paneId)) amendGesture(d.id, { paneId: 'main' });
  return pasted.map((d) => d.id);
}

/** Paste the app clipboard (Ctrl+V), one bar right of the previous paste (n bars for the nth). */
export function pasteDrawings(): string[] {
  const json = useDrawingClipboard.getState().clipboard;
  if (!json) return [];
  pastes = pastes.json === json ? { json, count: pastes.count + 1 } : { json, count: 1 };
  return insertCopies(json, 'Paste drawings', pastes.count);
}

/** Clone in place (selected afterwards); leaves the clipboard alone. */
export function cloneDrawings(ids: readonly string[]): string[] {
  const list = existing(ids);
  const chart = getChart();
  if (!list.length || !chart) return [];
  const json = chart.copyDrawings(list.map((d) => d.id));
  return insertCopies(
    json,
    list.length === 1 ? `Clone ${toolName(list[0]!.type)}` : 'Clone drawings',
    0,
  );
}

/** Select every drawing shown on the chart (Ctrl+A). */
export function selectAllDrawings(): void {
  getChart()?.selectAllDrawings();
}

// ------------------------------------------------------------ bulk

/** Remove every drawing on the current chart (current symbol + synced) as one step. */
export function removeAllDrawings(): void {
  const list = currentDrawings();
  if (!list.length) {
    toast('No drawings to remove');
    return;
  }
  commit(
    'Remove drawings',
    list.map((d) => ({ before: d, after: null })),
  );
}

/** Remove all drawings and indicators as one undo step. */
export function removeAllObjects(): void {
  const drawings = currentDrawings();
  const indicators = useIndicatorStore.getState().instances;
  if (!drawings.length && !indicators.length) return;
  const changes = mergeChanges(drawings.map((d) => ({ before: d, after: null })));
  applyChanges(changes, 'redo');
  useIndicatorStore.getState().replaceAll([]);
  useHistory.getState().push({
    label: 'Clear the chart',
    undo: () => {
      applyChanges(changes, 'undo');
      useIndicatorStore.getState().replaceAll(indicators);
    },
    redo: () => {
      applyChanges(changes, 'redo');
      useIndicatorStore.getState().replaceAll([]);
    },
  });
  last = null;
}

/**
 * Drawings of a removed pane on every symbol (indicator panes are shared by
 * all symbols), as part of the pane's undo step (see ./attach).
 */
export function removePaneDrawings(paneId: string): void {
  const s = store();
  const list = [...s.synced, ...Object.values(s.bySymbol).flat()].filter(
    (d) => d.paneId === paneId,
  );
  if (list.length)
    commit(
      'Remove drawings',
      list.map((d) => ({ before: d, after: null })),
    );
}
