/** Which detail sections are open, remembered in this browser. */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SectionId = 'performance' | 'keyStats' | 'moreStats' | 'events' | 'news' | 'alerts';

/** Open by default, except "More stats": opening it is what asks for `/fundamentals`. */
export const DEFAULT_OPEN: Record<SectionId, boolean> = {
  performance: true,
  keyStats: true,
  moreStats: false,
  events: true,
  news: true,
  alerts: true,
};

/** Booleans of known sections only: whatever else storage holds is dropped. */
export function sanitizeOpen(raw: unknown): Partial<Record<SectionId, boolean>> {
  const out: Partial<Record<SectionId, boolean>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of Object.keys(DEFAULT_OPEN) as SectionId[]) {
    const v = (raw as Record<string, unknown>)[id];
    if (typeof v === 'boolean') out[id] = v;
  }
  return out;
}

interface PrefsState {
  /** Only the sections the user toggled. */
  open: Partial<Record<SectionId, boolean>>;
  toggle: (id: SectionId) => void;
}

export const useSymbolInfoPrefs = create<PrefsState>()(
  persist(
    (set) => ({
      open: {},
      toggle: (id) =>
        set((s) => ({ open: { ...s.open, [id]: !(s.open[id] ?? DEFAULT_OPEN[id]) } })),
    }),
    {
      name: 'tickerglass-symbolinfo',
      version: 1,
      partialize: (s) => ({ open: s.open }),
      merge: (persisted, current) => ({
        ...current,
        open: sanitizeOpen((persisted as { open?: unknown } | null | undefined)?.open),
      }),
    },
  ),
);

/** Open state of a section and its toggle. */
export function useSectionOpen(id: SectionId): [boolean, () => void] {
  const open = useSymbolInfoPrefs((s) => s.open[id] ?? DEFAULT_OPEN[id]);
  const toggle = useSymbolInfoPrefs((s) => s.toggle);
  return [open, () => toggle(id)];
}
