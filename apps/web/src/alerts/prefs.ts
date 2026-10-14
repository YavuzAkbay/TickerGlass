/** Alert display and notification preferences (setting `alerts.prefs`, docs/alerts.md §5.5, §5.6). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';

export const SOUND_NAMES = ['beep', 'chime', 'ding', 'alarm'] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

export interface AlertPrefs {
  sound: SoundName;
  /** 0..1 */
  volume: number;
  /** Toast auto-hide in ms; 0 keeps it until dismissed. */
  toastMs: number;
  /** Dashed lines for active price alerts. */
  lines: boolean;
  /** Markers for fired alerts. */
  markers: boolean;
}

export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  sound: 'chime',
  volume: 0.6,
  toastMs: 10_000,
  lines: true,
  markers: true,
};

export const MAX_TOAST_MS = 600_000;

/** Validate a value from the server or an import; invalid fields are left out. */
export function parseAlertPrefs(v: unknown): Partial<AlertPrefs> {
  const out: Partial<AlertPrefs> = {};
  if (!isObj(v)) return out;
  if (typeof v.sound === 'string' && (SOUND_NAMES as readonly string[]).includes(v.sound))
    out.sound = v.sound as SoundName;
  if (typeof v.volume === 'number' && Number.isFinite(v.volume))
    out.volume = Math.min(1, Math.max(0, v.volume));
  if (typeof v.toastMs === 'number' && Number.isFinite(v.toastMs))
    out.toastMs = Math.min(MAX_TOAST_MS, Math.max(0, Math.round(v.toastMs)));
  if (typeof v.lines === 'boolean') out.lines = v.lines;
  if (typeof v.markers === 'boolean') out.markers = v.markers;
  return out;
}

interface PrefsState extends AlertPrefs {
  set: (patch: Partial<AlertPrefs>) => void;
}

const pick = (s: AlertPrefs): AlertPrefs => ({
  sound: s.sound,
  volume: s.volume,
  toastMs: s.toastMs,
  lines: s.lines,
  markers: s.markers,
});

export const useAlertPrefs = create<PrefsState>()(
  persist<PrefsState, [], [], AlertPrefs>(
    (set) => ({
      ...DEFAULT_ALERT_PREFS,
      set: (patch) => set(parseAlertPrefs({ ...patch })),
    }),
    {
      name: 'investopen-alert-prefs',
      version: 1,
      partialize: pick,
      merge: (persisted, current) => ({ ...current, ...parseAlertPrefs(persisted) }),
    },
  ),
);

export const readAlertPrefs = (): AlertPrefs => pick(useAlertPrefs.getState());
