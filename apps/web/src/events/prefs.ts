/** Which event markers show on the chart (setting `events.prefs`). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';

export interface EventPrefs {
  dividends: boolean;
  splits: boolean;
  earnings: boolean;
}

export const DEFAULT_EVENT_PREFS: EventPrefs = {
  dividends: true,
  splits: true,
  earnings: true,
};

/** Validate a value from the server or an import; invalid fields are left out. */
export function parseEventPrefs(v: unknown): Partial<EventPrefs> {
  const out: Partial<EventPrefs> = {};
  if (!isObj(v)) return out;
  if (typeof v.dividends === 'boolean') out.dividends = v.dividends;
  if (typeof v.splits === 'boolean') out.splits = v.splits;
  if (typeof v.earnings === 'boolean') out.earnings = v.earnings;
  return out;
}

interface PrefsState extends EventPrefs {
  set: (patch: Partial<EventPrefs>) => void;
}

const pick = (s: EventPrefs): EventPrefs => ({
  dividends: s.dividends,
  splits: s.splits,
  earnings: s.earnings,
});

export const useEventPrefs = create<PrefsState>()(
  persist<PrefsState, [], [], EventPrefs>(
    (set) => ({
      ...DEFAULT_EVENT_PREFS,
      set: (patch) => set(parseEventPrefs({ ...patch })),
    }),
    {
      name: 'tickerglass-event-prefs',
      version: 1,
      partialize: pick,
      merge: (persisted, current) => ({ ...current, ...parseEventPrefs(persisted) }),
    },
  ),
);

export const readEventPrefs = (): EventPrefs => pick(useEventPrefs.getState());
