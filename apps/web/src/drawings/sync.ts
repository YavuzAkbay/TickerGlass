import { getDrawingTool, type Drawing, type DrawingApi } from '@tickerglass/engine';
import { deepEqual } from './model';

export type DrawingSink = Pick<
  DrawingApi,
  'getDrawing' | 'addDrawing' | 'replaceDrawing' | 'removeDrawings' | 'setDrawings'
>;

/**
 * What the engine was last made to hold, by id: the store's drawing objects
 * (compared by reference, so unchanged drawings cost nothing).
 */
export type SyncedDrawings = Map<string, Drawing>;

/** Replace the engine's list with `wanted` and remember it as synced. */
export function replaceDrawings(
  chart: DrawingSink,
  wanted: readonly Drawing[],
  synced: SyncedDrawings,
): void {
  chart.setDrawings(wanted);
  synced.clear();
  for (const d of wanted) synced.set(d.id, d);
}

/**
 * Make the engine's drawings equal `wanted` with the fewest API calls (API
 * calls emit no mutation events and keep the selection). Only drawings whose
 * store object changed since the last sync are read back from the engine;
 * changed ones are replaced wholesale (`replaceDrawing`), so style keys the
 * store dropped leave the engine too. Unknown tool types cannot be added one
 * by one, so their arrival falls back to `setDrawings`.
 */
export function reconcileDrawings(
  chart: DrawingSink,
  wanted: readonly Drawing[],
  synced: SyncedDrawings,
): void {
  const want = new Set(wanted.map((d) => d.id));
  const missing = wanted.filter((d) => !synced.has(d.id) && !chart.getDrawing(d.id));
  if (missing.some((d) => !getDrawingTool(d.type))) {
    replaceDrawings(chart, wanted, synced);
    return;
  }
  const stale = [...synced.keys()].filter((id) => !want.has(id));
  if (stale.length) {
    chart.removeDrawings(stale);
    for (const id of stale) synced.delete(id);
  }
  for (const d of wanted) {
    if (synced.get(d.id) === d) continue;
    const cur = chart.getDrawing(d.id);
    if (!cur) chart.addDrawing(d);
    else if (!deepEqual(cur, d)) chart.replaceDrawing(d);
    synced.set(d.id, d);
  }
}
