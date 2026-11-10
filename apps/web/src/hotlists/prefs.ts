import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { DEFAULT_KIND, isHotlistKind, type HotlistKind } from './kinds';

export interface HotlistPrefs {
  kind: HotlistKind;
  /** Chosen universe id; null until the user picks one (then the default applies). */
  universe: string | null;
}

interface PrefsState extends HotlistPrefs {
  setKind: (kind: HotlistKind) => void;
  setUniverse: (universe: string) => void;
}

/** Validate persisted prefs; invalid fields fall back to the defaults. */
export function parseHotlistPrefs(v: unknown): HotlistPrefs {
  const out: HotlistPrefs = { kind: DEFAULT_KIND, universe: null };
  if (!isObj(v)) return out;
  if (isHotlistKind(v.kind)) out.kind = v.kind;
  if (typeof v.universe === 'string' && v.universe.length > 0 && v.universe.length <= 64)
    out.universe = v.universe;
  return out;
}

/** Local to this browser (not synced). */
export const useHotlistPrefs = create<PrefsState>()(
  persist(
    (set) => ({
      kind: DEFAULT_KIND,
      universe: null,
      setKind: (kind) => set({ kind }),
      setUniverse: (universe) => set({ universe }),
    }),
    {
      name: 'tickerglass-hotlist-prefs',
      version: 1,
      partialize: (s) => ({ kind: s.kind, universe: s.universe }),
      merge: (persisted, current) => ({ ...current, ...parseHotlistPrefs(persisted) }),
    },
  ),
);
