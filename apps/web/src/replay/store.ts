import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type ReplayStatus = 'off' | 'picking' | 'loading' | 'paused' | 'playing' | 'ended';

/** Delay between steps in ms, slowest first. Index 1 (1 s per step) is the default. */
export const REPLAY_SPEEDS = [3000, 1000, 500, 300, 100, 30] as const;
export const DEFAULT_SPEED = 1000;

/** Update picker value as persisted: 'auto', 'bars' or an interval string like '5m'. */
export type ReplayUpdateText = 'auto' | 'bars' | (string & {});

interface ReplayStore {
  status: ReplayStatus;
  /** Open time of the last revealed tick (NaN when not replaying). */
  last: number;
  /** Open time of the first unrevealed tick (NaN when not replaying). */
  next: number;
  /** Tick interval text (e.g. "1m"), or null when whole bars are replayed. */
  tick: string | null;
  warning: string | null;
  /** The replay chart (the active chart when replay began), pinned until replay ends. */
  chartId: string | null;
  /** Delay per step in ms (persisted). */
  speed: number;
  /** Update picker (persisted). */
  update: ReplayUpdateText;
  set: (patch: Partial<Omit<ReplayStore, 'set'>>) => void;
}

/** localStorage looked up at call time (absent in some environments; failures are ignored). */
const lazyStorage: StateStorage = {
  getItem: (name) => {
    try {
      return globalThis.localStorage?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      globalThis.localStorage?.setItem(name, value);
    } catch {
      // Quota or privacy mode: the preference just is not remembered.
    }
  },
  removeItem: (name) => {
    try {
      globalThis.localStorage?.removeItem(name);
    } catch {
      // Nothing to remove.
    }
  },
};

export const useReplayStore = create<ReplayStore>()(
  persist(
    (set) => ({
      status: 'off',
      last: NaN,
      next: NaN,
      tick: null,
      warning: null,
      chartId: null,
      speed: DEFAULT_SPEED,
      update: 'auto',
      set: (patch) => set(patch),
    }),
    {
      name: 'investopen-replay',
      storage: createJSONStorage(() => lazyStorage),
      partialize: ({ speed, update }) => ({ speed, update }),
      // Stored values may be stale or hand-edited: keep only valid ones.
      merge: (saved, current) => {
        const p = (saved ?? {}) as { speed?: unknown; update?: unknown };
        return {
          ...current,
          speed: (REPLAY_SPEEDS as readonly unknown[]).includes(p.speed)
            ? (p.speed as number)
            : current.speed,
          update: typeof p.update === 'string' && p.update ? p.update : current.update,
        };
      },
    },
  ),
);
