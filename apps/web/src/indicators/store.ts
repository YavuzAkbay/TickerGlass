import type { InstanceStatus } from '@investopen/indicators';
import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { IndicatorDefaults, IndicatorState } from './model';

/**
 * Indicators on the chart (localStorage for now; Phase 7 moves layouts to the
 * API). Mutate through ./actions so changes are validated and undoable.
 */
interface IndicatorStore {
  instances: IndicatorState[];
  /** Insert at `index` (default: end). */
  add: (inst: IndicatorState, index?: number) => void;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<IndicatorState, 'id' | 'type'>>) => void;
  replaceAll: (list: IndicatorState[]) => void;
}

export const useIndicatorStore = create<IndicatorStore>()(
  persist(
    (set) => ({
      instances: [],
      add: (inst, index) =>
        set((s) => {
          const list = s.instances.filter((i) => i.id !== inst.id);
          const at = index === undefined ? list.length : Math.max(0, Math.min(index, list.length));
          list.splice(at, 0, inst);
          return { instances: list };
        }),
      remove: (id) => set((s) => ({ instances: s.instances.filter((i) => i.id !== id) })),
      update: (id, patch) =>
        set((s) => ({
          instances: s.instances.map((i) => (i.id === id ? { ...i, ...patch } : i)),
        })),
      replaceAll: (list) => set({ instances: list }),
    }),
    { name: 'investopen-indicators', version: 1 },
  ),
);

export type IndicatorPatch = Partial<Omit<IndicatorState, 'id' | 'type'>>;

/**
 * Settings-dialog live preview: transient patches drawn over the persisted
 * instances. Never persisted and never in the undo history; Ok commits one
 * patch to useIndicatorStore (see ./actions), Cancel drops it.
 */
export const useIndicatorPreview = create<{ overrides: Record<string, IndicatorPatch> }>()(() => ({
  overrides: {},
}));

/** Persisted instances with preview patches applied (what the chart shows). */
export function withPreview(
  instances: IndicatorState[],
  overrides: Record<string, IndicatorPatch>,
): IndicatorState[] {
  if (!Object.keys(overrides).length) return instances;
  return instances.map((i) => {
    const o = overrides[i.id];
    return o ? { ...i, ...o } : i;
  });
}

export const effectiveInstances = () =>
  withPreview(useIndicatorStore.getState().instances, useIndicatorPreview.getState().overrides);

/** React: instances as drawn (persisted + live preview). */
export function useEffectiveInstances(): IndicatorState[] {
  const instances = useIndicatorStore((s) => s.instances);
  const overrides = useIndicatorPreview((s) => s.overrides);
  return useMemo(() => withPreview(instances, overrides), [instances, overrides]);
}

/** Per-user picker favourites and "Save as default" settings. */
interface IndicatorPrefs {
  favorites: string[];
  defaults: Record<string, IndicatorDefaults>;
  toggleFavorite: (type: string) => void;
  saveDefaults: (type: string, d: IndicatorDefaults) => void;
  clearDefaults: (type: string) => void;
}

export const useIndicatorPrefs = create<IndicatorPrefs>()(
  persist(
    (set) => ({
      favorites: [],
      defaults: {},
      toggleFavorite: (type) =>
        set((s) => ({
          favorites: s.favorites.includes(type)
            ? s.favorites.filter((t) => t !== type)
            : [...s.favorites, type],
        })),
      saveDefaults: (type, d) => set((s) => ({ defaults: { ...s.defaults, [type]: d } })),
      clearDefaults: (type) =>
        set((s) => {
          const { [type]: _dropped, ...rest } = s.defaults;
          return { defaults: rest };
        }),
    }),
    { name: 'investopen-indicator-prefs', version: 1 },
  ),
);

/** Live (not persisted) per-instance state reported by the chart controller. */
interface IndicatorRuntimeState {
  status: Record<string, InstanceStatus>;
  /** Engine pane of each study. */
  panes: Record<string, string>;
  /** Bumped when results arrive, so legends re-read last-bar values. */
  tick: number;
}

export const useIndicatorRuntime = create<IndicatorRuntimeState>()(() => ({
  status: {},
  panes: {},
  tick: 0,
}));
