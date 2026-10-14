import type { SymbolInfo } from '@investopen/engine';
import { create } from 'zustand';
import type { CompareLayout, CompareState } from './model';

/**
 * Compare overlays on the chart. Saved with the layout (persist/layoutState.ts),
 * not in localStorage of their own. Mutate through ./actions so changes are
 * validated and undoable.
 */
interface CompareStore extends CompareLayout {
  /** Insert at `index` (default: end). */
  add: (item: CompareState, index?: number) => void;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<CompareState, 'id'>>) => void;
  replaceAll: (layout: CompareLayout) => void;
}

export const useCompareStore = create<CompareStore>()((set) => ({
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

/** The persisted part of the store. */
export const currentCompareLayout = (): CompareLayout => {
  const { items, scaleRestore } = useCompareStore.getState();
  return { items, scaleRestore };
};

export type CompareStatus =
  { state: 'loading' | 'ready' } | { state: 'error' | 'unavailable'; message: string };

/** Live (not persisted) per-overlay state reported by the chart controller. */
interface CompareRuntimeState {
  status: Record<string, CompareStatus>;
  /** Resolved symbol of each overlay (precision, exchange, expression info). */
  info: Record<string, SymbolInfo>;
  /** Bumped when overlay data changes, so legends re-read last-bar values. */
  tick: number;
}

export const useCompareRuntime = create<CompareRuntimeState>()(() => ({
  status: {},
  info: {},
  tick: 0,
}));
