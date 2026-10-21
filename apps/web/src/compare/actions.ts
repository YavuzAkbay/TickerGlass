// Validated, undoable mutations of the compare store. The compare dialog,
// legend rows and context menus all go through these. Adding the first
// visible 'same' overlay switches the main pane to percent (one undo step
// with the add); removing the last 'same' overlay switches it back.
import type { Chart, PriceScaleMode } from '@tickerglass/engine';
import { useHistory } from '../commands/history';
import { getChart } from '../store/chart';
import { toast } from '../ui/Toast';
import {
  DEFAULT_COMPARE_LINE_WIDTH,
  MAX_COMPARES,
  compareSymbol,
  isCompareColor,
  isCompareLineWidth,
  newCompareId,
  nextCompareColor,
  type CompareLayout,
  type ComparePlacement,
  type CompareState,
} from './model';
import { currentCompareLayout, useCompareStore } from './store';

const store = () => useCompareStore.getState();

const PLACEMENT_LABEL: Record<ComparePlacement, string> = {
  same: 'same % scale',
  own: 'new price scale',
  pane: 'new pane',
};

export function findCompare(id: string): CompareState | undefined {
  return store().items.find((i) => i.id === id);
}

type MainScale = { mode: PriceScaleMode; autoScale: boolean };

interface Snapshot {
  layout: CompareLayout;
  /** Main pane scale; null without a chart. */
  scale: MainScale | null;
}

function mainScale(chart: Chart | null): MainScale | null {
  const ps = chart?.getState().panes.find((p) => p.id === 'main')?.priceScale;
  return ps ? { mode: ps.mode, autoScale: ps.autoScale } : null;
}

function write(s: Snapshot): void {
  const chart = getChart();
  const cur = mainScale(chart);
  // Scale first: its stateChange must not clear the scaleRestore written next.
  if (chart && s.scale && cur) {
    if (cur.mode !== s.scale.mode) chart.setPriceScaleMode('main', s.scale.mode);
    if (mainScale(chart)?.autoScale !== s.scale.autoScale)
      chart.setAutoScale('main', s.scale.autoScale);
  }
  store().replaceAll(s.layout);
}

/**
 * Apply `items` as one undo step, switching the main pane to percent for the
 * first visible 'same' overlay and back when no 'same' overlay is left.
 */
function commit(items: CompareState[], label: string): void {
  const cur = mainScale(getChart());
  const layout = currentCompareLayout();
  let scaleRestore = layout.scaleRestore;
  // Only a step that changes the main scale snapshots it: undoing an unrelated
  // step (colour, width, hide) must not clobber the user's manual scale changes.
  let from: MainScale | null = null;
  let to: MainScale | null = null;
  if (cur) {
    const sameVisible = items.some((i) => i.placement === 'same' && i.visible);
    const same = items.some((i) => i.placement === 'same');
    if (sameVisible && (cur.mode === 'linear' || cur.mode === 'log')) {
      scaleRestore ??= cur.mode;
      from = cur;
      to = { mode: 'percent', autoScale: true };
    } else if (!same && scaleRestore !== null) {
      if (cur.mode === 'percent') {
        from = cur;
        to = { mode: scaleRestore, autoScale: true };
      }
      scaleRestore = null;
    }
  }
  const before: Snapshot = { layout, scale: from };
  const after: Snapshot = { layout: { items, scaleRestore }, scale: to };
  write(after);
  useHistory.getState().push({ label, undo: () => write(before), redo: () => write(after) });
}

const duplicate = (items: readonly CompareState[], symbol: string, p: ComparePlacement) =>
  items.find((i) => i.symbol === symbol && i.placement === p);

/** Adds an overlay of `raw` (symbol or expression). Returns its id, or null with a toast. */
export function addCompare(raw: string, placement: ComparePlacement): string | null {
  const sym = compareSymbol(raw);
  if (!sym.ok) {
    toast(sym.message, 'error');
    return null;
  }
  const items = store().items;
  if (items.length >= MAX_COMPARES) {
    toast(`At most ${MAX_COMPARES} symbols can be compared`, 'error');
    return null;
  }
  if (duplicate(items, sym.symbol, placement)) {
    toast(`${sym.symbol} is already compared on the ${PLACEMENT_LABEL[placement]}`, 'error');
    return null;
  }
  const item: CompareState = {
    id: newCompareId(),
    symbol: sym.symbol,
    placement,
    visible: true,
    color: nextCompareColor(items),
    lineWidth: DEFAULT_COMPARE_LINE_WIDTH,
  };
  commit([...items, item], `Compare ${item.symbol}`);
  return item.id;
}

export function removeCompare(id: string): void {
  removeCompares([id]);
}

/** Removes several overlays as one undo step (e.g. those of a removed pane). */
export function removeCompares(ids: readonly string[]): void {
  const drop = new Set(ids);
  const items = store().items;
  const removed = items.filter((i) => drop.has(i.id));
  if (!removed.length) return;
  commit(
    items.filter((i) => !drop.has(i.id)),
    removed.length === 1 ? `Remove compare ${removed[0]!.symbol}` : 'Remove compares',
  );
}

/** Removes every overlay as one undo step. */
export function removeAllCompares(): void {
  removeCompares(store().items.map((i) => i.id));
}

/** Moves an overlay to another scale/pane. Refused (toast) if that would duplicate one. */
export function setComparePlacement(id: string, placement: ComparePlacement): boolean {
  const items = store().items;
  const item = items.find((i) => i.id === id);
  if (!item || item.placement === placement) return false;
  if (duplicate(items, item.symbol, placement)) {
    toast(`${item.symbol} is already compared on the ${PLACEMENT_LABEL[placement]}`, 'error');
    return false;
  }
  commit(
    items.map((i) => (i.id === id ? { ...i, placement } : i)),
    `Move ${item.symbol} to ${PLACEMENT_LABEL[placement]}`,
  );
  return true;
}

export type ComparePatch = Partial<Pick<CompareState, 'color' | 'lineWidth' | 'visible'>>;

/** Validated, undoable style/visibility patch. */
export function updateCompare(id: string, patch: ComparePatch, label: string): boolean {
  const items = store().items;
  const item = items.find((i) => i.id === id);
  if (!item) return false;
  if (patch.color !== undefined && !isCompareColor(patch.color)) {
    toast(`Invalid colour "${patch.color}"`, 'error');
    return false;
  }
  if (patch.lineWidth !== undefined && !isCompareLineWidth(patch.lineWidth)) {
    toast('Line width must be 1 to 4', 'error');
    return false;
  }
  const next = { ...item, ...patch };
  if (JSON.stringify(next) === JSON.stringify(item)) return false;
  commit(
    items.map((i) => (i.id === id ? next : i)),
    label,
  );
  return true;
}

export function toggleCompareVisible(id: string): void {
  const item = findCompare(id);
  if (!item) return;
  updateCompare(id, { visible: !item.visible }, item.visible ? 'Hide compare' : 'Show compare');
}

/**
 * The main pane scale mode changed from `prev` to `next` (chart stateChange).
 * Leaving percent by hand means the user chose a scale: forget the mode a
 * 'same' overlay would have restored.
 */
export function onMainScaleMode(prev: PriceScaleMode | null, next: PriceScaleMode | null): void {
  if (prev !== 'percent' || next === 'percent') return;
  const { items, scaleRestore } = store();
  if (scaleRestore !== null) store().replaceAll({ items, scaleRestore: null });
}
