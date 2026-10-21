import { resolveIndicatorId, type InstanceStatus } from '@tickerglass/indicators';
import { useMemo } from 'react';
import { create, useStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createActiveFacade } from '../chart/facade';
import { isObj, readJson, safeStorage } from '../persist/net';
import { withLegacyVolume, type IndicatorDefaults, type IndicatorState } from './model';

/**
 * Indicators on the chart (localStorage for now; Phase 7 moves layouts to the
 * API). Mutate through ./actions so changes are validated and undoable.
 */
export interface IndicatorStore {
  instances: IndicatorState[];
  /** Insert at `index` (default: end). */
  add: (inst: IndicatorState, index?: number) => void;
  remove: (id: string) => void;
  update: (id: string, patch: Partial<Omit<IndicatorState, 'id' | 'type'>>) => void;
  replaceAll: (list: IndicatorState[]) => void;
}

/**
 * Built-in volume mode the app stored before volume became an indicator
 * (`tickerglass-app` state `volume`; 'overlay', the old default, when unset).
 */
export function legacyAppVolume(raw = safeStorage().get('tickerglass-app')): unknown {
  const app = readJson<unknown>(raw);
  return isObj(app) && isObj(app.state) && 'volume' in app.state ? app.state.volume : 'overlay';
}

/** Instances whose type is a renamed built-in's old id, retyped to the new id. */
export function migrateRenamedTypes(list: IndicatorState[]): IndicatorState[] {
  return list.map((i) => {
    const type = isObj(i) && typeof i.type === 'string' ? resolveIndicatorId(i.type) : i?.type;
    return type === i?.type ? i : { ...i, type };
  });
}

/** Picker prefs with renamed ids mapped; a favourite or default already on the new id wins. */
export function migrateRenamedPrefs(persisted: unknown): IndicatorPrefsData {
  const s = isObj(persisted) ? persisted : {};
  const favorites: string[] = [];
  for (const t of Array.isArray(s.favorites) ? s.favorites : []) {
    if (typeof t !== 'string') continue;
    const id = resolveIndicatorId(t);
    if (!favorites.includes(id)) favorites.push(id);
  }
  const defaults: Record<string, IndicatorDefaults> = {};
  const stored = isObj(s.defaults) ? (s.defaults as Record<string, IndicatorDefaults>) : {};
  for (const [type, d] of Object.entries(stored)) {
    const id = resolveIndicatorId(type);
    if (id === type || !(id in stored)) defaults[id] = d;
  }
  return { favorites, defaults };
}

/** zustand `migrate` of `tickerglass-indicators`. */
export function migrateIndicatorStore(persisted: unknown, version: number): IndicatorStore {
  const s = isObj(persisted) ? persisted : {};
  const stored = Array.isArray(s.instances) ? (s.instances as IndicatorState[]) : [];
  const list = version < 3 ? migrateRenamedTypes(stored) : stored;
  const instances = version < 2 ? withLegacyVolume(list, legacyAppVolume()) : list;
  return { ...s, instances } as unknown as IndicatorStore;
}

type IndicatorSet = StoreApi<IndicatorStore>['setState'];

const indicatorActions = (set: IndicatorSet): Omit<IndicatorStore, 'instances'> => ({
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
});

// A new chart shows Volume (or what the old built-in volume setting said).
const initialInstances = () => withLegacyVolume([], legacyAppVolume()) as IndicatorState[];

/**
 * One chart's indicator instances. With `persistLocal` they also live in
 * localStorage (the primary chart only: the key is a single slot).
 */
export function createIndicatorStore(persistLocal = false): StoreApi<IndicatorStore> {
  if (!persistLocal)
    return createStore<IndicatorStore>()((set) => ({
      instances: initialInstances(),
      ...indicatorActions(set),
    }));
  return createStore<IndicatorStore>()(
    persist((set) => ({ instances: initialInstances(), ...indicatorActions(set) }), {
      name: 'tickerglass-indicators',
      version: 3,
      // v1 -> v2: the engine's built-in volume became the Volume indicator.
      // v2 -> v3: renamed built-ins get their current type id.
      migrate: migrateIndicatorStore,
    }),
  );
}

/** The active chart's indicator instances. */
export const useIndicatorStore = createActiveFacade((s) => s.indicators, createIndicatorStore);

export type IndicatorPatch = Partial<Omit<IndicatorState, 'id' | 'type'>>;

/**
 * Settings-dialog live preview: transient patches drawn over the persisted
 * instances. Never persisted and never in the undo history; Ok commits one
 * patch to useIndicatorStore (see ./actions), Cancel drops it.
 */
export interface IndicatorPreviewState {
  overrides: Record<string, IndicatorPatch>;
}

export const createIndicatorPreviewStore = () =>
  createStore<IndicatorPreviewState>()(() => ({ overrides: {} }));

/** The active chart's settings-dialog preview. */
export const useIndicatorPreview = createActiveFacade(
  (s) => s.preview,
  createIndicatorPreviewStore,
);

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

/** Instances of the given stores as drawn (persisted + live preview). */
export const effectiveInstancesOf = (
  indicators: StoreApi<IndicatorStore>,
  preview: StoreApi<IndicatorPreviewState>,
) => withPreview(indicators.getState().instances, preview.getState().overrides);

export const effectiveInstances = () =>
  effectiveInstancesOf(useIndicatorStore, useIndicatorPreview);

/** React: instances as drawn (persisted + live preview) of the given stores. */
export function useEffectiveInstancesOf(
  indicators: StoreApi<IndicatorStore>,
  preview: StoreApi<IndicatorPreviewState>,
): IndicatorState[] {
  const instances = useStore(indicators, (s) => s.instances);
  const overrides = useStore(preview, (s) => s.overrides);
  return useMemo(() => withPreview(instances, overrides), [instances, overrides]);
}

/** React: the active chart's instances as drawn. */
export function useEffectiveInstances(): IndicatorState[] {
  return useEffectiveInstancesOf(useIndicatorStore, useIndicatorPreview);
}

/** Per-user picker favourites and "Save as default" settings. */
interface IndicatorPrefsData {
  favorites: string[];
  defaults: Record<string, IndicatorDefaults>;
}

interface IndicatorPrefs extends IndicatorPrefsData {
  toggleFavorite: (type: string) => void;
  saveDefaults: (type: string, d: IndicatorDefaults) => void;
  clearDefaults: (type: string) => void;
}

/** zustand `migrate` of `tickerglass-indicator-prefs`. */
export function migrateIndicatorPrefs(persisted: unknown, version: number): IndicatorPrefs {
  const s = isObj(persisted) ? persisted : {};
  return (version < 2 ? { ...s, ...migrateRenamedPrefs(s) } : s) as unknown as IndicatorPrefs;
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
    {
      name: 'tickerglass-indicator-prefs',
      version: 2,
      // v1 -> v2: renamed built-ins get their current id.
      migrate: migrateIndicatorPrefs,
    },
  ),
);

/** Live (not persisted) per-instance state reported by the chart controller. */
export interface IndicatorRuntimeState {
  status: Record<string, InstanceStatus>;
  /** Engine pane of each study. */
  panes: Record<string, string>;
  /** Bumped when results arrive, so legends re-read last-bar values. */
  tick: number;
}

export const createIndicatorRuntimeStore = () =>
  createStore<IndicatorRuntimeState>()(() => ({
    status: {},
    panes: {},
    tick: 0,
  }));

/** The active chart's indicator runtime state. */
export const useIndicatorRuntime = createActiveFacade(
  (s) => s.indicatorRuntime,
  createIndicatorRuntimeStore,
);
