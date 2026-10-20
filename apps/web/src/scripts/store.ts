/**
 * User scripts (docs/persistence.md): the list loaded from
 * the API at startup, or the read-only localStorage copy while it is down.
 * Not persisted here: `persist/userScripts.ts` owns loading and the cache.
 */
import { create } from 'zustand';
import type { UserScript } from '../api/types';

interface ScriptsState {
  /** Oldest first, as the API lists them. */
  scripts: UserScript[];
  /** A load (or the offline copy) has been applied; before that nothing is known about scripts. */
  loaded: boolean;
  setScripts: (scripts: UserScript[]) => void;
  /** Insert or replace by id. */
  upsert: (script: UserScript) => void;
  remove: (id: string) => void;
}

export const useScriptsStore = create<ScriptsState>()((set) => ({
  scripts: [],
  loaded: false,
  setScripts: (scripts) => set({ scripts, loaded: true }),
  upsert: (script) =>
    set((s) => ({
      scripts: s.scripts.some((x) => x.id === script.id)
        ? s.scripts.map((x) => (x.id === script.id ? script : x))
        : [...s.scripts, script],
    })),
  remove: (id) => set((s) => ({ scripts: s.scripts.filter((x) => x.id !== id) })),
}));
