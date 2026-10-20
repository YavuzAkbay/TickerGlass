import type { SymbolInfo } from '@investopen/engine';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createActiveFacade } from '../chart/facade';
import type { CompareLayout, CompareState } from './model';

/**
 * Compare overlays on the chart. Saved with the layout (persist/layoutState.ts),
 * not in localStorage of their own. Mutate through ./actions so changes are
 * validated and undoable.
 */
export interface CompareStore extends CompareLayout {
  /** Insert at `index` (default: end). */
  add: (item: CompareState, index?: number) => void;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<CompareState, 'id'>>) => void;
  replaceAll: (layout: CompareLayout) => void;
}

export const createCompareStore = () =>
  createStore<CompareStore>()((set) => ({
    items: [],
    scaleRestore: null,
    add: (item, index) =>
      set((s) => {
        const list = s.items.filter((i) => i.id !== item.id);
        const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
        list.splice(at, 0, item);
        return { items: list };
      }),
    remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
    update: (id, patch) =>
      set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
    replaceAll: (layout) => set({ items: layout.items, scaleRestore: layout.scaleRestore }),
  }));

/** The active chart's compare overlays. */
export const useCompareStore = createActiveFacade((s) => s.compares, createCompareStore);

/** The persisted part of a store. */
export const compareLayoutOf = (store: StoreApi<CompareStore>): CompareLayout => {
  const { items, scaleRestore } = store.getState();
  return { items, scaleRestore };
};

/** The persisted part of the active chart's store. */
export const currentCompareLayout = (): CompareLayout => compareLayoutOf(useCompareStore);

export type CompareStatus =
  { state: 'loading' | 'ready' } | { state: 'error' | 'unavailable'; message: string };

/** Live (not persisted) per-overlay state reported by the chart controller. */
export interface CompareRuntimeState {
  status: Record<string, CompareStatus>;
  /** Resolved symbol of each overlay (precision, exchange, expression info). */
  info: Record<string, SymbolInfo>;
  /** Bumped when overlay data changes, so legends re-read last-bar values. */
  tick: number;
}

export const createCompareRuntimeStore = () =>
  createStore<CompareRuntimeState>()(() => ({
    status: {},
    info: {},
    tick: 0,
  }));

/** The active chart's overlay runtime state. */
export const useCompareRuntime = createActiveFacade(
  (s) => s.compareRuntime,
  createCompareRuntimeStore,
);
