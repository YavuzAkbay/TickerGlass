/** Changing the grid: templates, adding a chart, sync flags, moving focus. */
import { normalizeSymbol } from '../store/app';
import { setActiveChart, useChartStore } from '../store/chart';
import { confirmDialog } from '../ui/Prompt';
import { toast } from '../ui/Toast';
import { cycleFocus } from './focus';
import { leaves, replaceTemplate, type SyncFlags, type TemplateChange } from './grid';
import { dropSeed, setSeed } from './seeds';
import { useLayoutGrid } from './store';
import { MAX_CHARTS, template, templateIdFor } from './templates';

export const chartCount = (): number => leaves(useLayoutGrid.getState().grid).length;

export const canAddChart = (): boolean => chartCount() < MAX_CHARTS;

const newId = () => crypto.randomUUID();

/** Make `change` the grid; charts it removes lose their session when their cell unmounts. */
function commitGrid(templateId: string | null, change: TemplateChange): void {
  const keep = leaves(change.grid);
  const { activeId } = useChartStore.getState();
  // Move focus first, to a chart that stays.
  if (activeId !== null && !keep.includes(activeId) && keep[0] !== undefined)
    setActiveChart(keep[0]);
  for (const id of change.removed) dropSeed(id);
  useLayoutGrid.setState((s) => {
    const slots = { ...s.slots };
    for (const id of change.removed) delete slots[id];
    return { template: templateId, grid: change.grid, slots };
  });
}

/**
 * Switch to template `id`. Existing charts fill its cells in order; new cells
 * get charts that copy the focused chart's symbol, interval and settings (no
 * indicators). Charts left over are removed after the user confirms.
 */
export async function applyTemplate(id: string): Promise<boolean> {
  const tree = template(id);
  if (!tree) return false;
  const { grid } = useLayoutGrid.getState();
  const change = replaceTemplate(grid, tree, leaves(grid), newId);
  if (change.removed.length > 0) {
    const n = change.removed.length;
    const ok = await confirmDialog({
      title: 'Remove charts',
      message: `This layout has fewer cells. ${n} chart${n === 1 ? '' : 's'} (with ${n === 1 ? 'its' : 'their'} indicators and settings) will be removed.`,
      okLabel: 'Remove',
      danger: true,
    });
    if (!ok) return false;
  }
  commitGrid(id, change);
  return true;
}

export function setSyncFlag<K extends keyof SyncFlags>(key: K, value: SyncFlags[K]): void {
  useLayoutGrid.setState((s) => ({ sync: { ...s.sync, [key]: value } }));
}

/**
 * Add one chart showing `symbol` (the grid becomes the template for one more
 * chart). Symbol sync would change every chart's symbol, so it is turned off.
 * Returns the new chart's id, or null at the limit.
 */
export function addChartWithSymbol(symbol: string): string | null {
  const { grid, sync } = useLayoutGrid.getState();
  const existing = leaves(grid);
  const next = existing.length + 1;
  const tree = next <= MAX_CHARTS ? template(next) : null;
  if (!tree) {
    toast(`At most ${MAX_CHARTS} charts fit in a layout`, 'error');
    return null;
  }
  if (sync.symbol) {
    setSyncFlag('symbol', false);
    toast('Symbol sync turned off so the new chart can show its own symbol');
  }
  const change = replaceTemplate(grid, tree, existing, newId);
  const id = change.created[0]!;
  setSeed(id, { symbol: normalizeSymbol(symbol) });
  commitGrid(templateIdFor(next), change);
  return id;
}

/** Focus the next (1) or previous (-1) chart in reading order. */
export function focusStep(dir: 1 | -1): void {
  const next = cycleFocus(
    leaves(useLayoutGrid.getState().grid),
    useChartStore.getState().activeId,
    dir,
  );
  if (next !== null) setActiveChart(next);
}
