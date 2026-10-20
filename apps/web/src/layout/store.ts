/**
 * The multi-chart arrangement of the current layout: the grid, sync flags,
 * which chart is active, and the last applied state of every chart slot.
 * Slots without a mounted chart session keep their saved state here, so a
 * layout round-trips even while only some of its charts are on screen.
 */
import { create } from 'zustand';
import { PRIMARY_CHART_ID } from '../chart/ids';
import type { ChartSlotState } from '../persist/layoutState';
import { DEFAULT_SYNC_FLAGS, leaf, type GridNode, type SyncFlags } from './grid';

export interface LayoutGridState {
  /** Picker label of the template the grid came from (null: edited or unknown). */
  template: string | null;
  grid: GridNode;
  sync: SyncFlags;
  /** The layout's active chart (the one the single mounted chart shows until the grid UI exists). */
  activeId: string;
  /** Saved state of each chart, by id. */
  slots: Record<string, ChartSlotState>;
}

export const defaultLayoutGrid = (): LayoutGridState => ({
  template: '1',
  grid: leaf(PRIMARY_CHART_ID),
  sync: { ...DEFAULT_SYNC_FLAGS },
  activeId: PRIMARY_CHART_ID,
  slots: {},
});

export const useLayoutGrid = create<LayoutGridState>()(defaultLayoutGrid);
