import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';
import { isColorMetric, isSizeMetric, type ColorMetricId, type SizeMetricId } from './metrics';

/** How the watchlist heatmap groups its tiles: by its sections, by sector, or not at all. */
export type WatchlistHeatGroup = 'none' | 'section' | 'sector';
export const WATCHLIST_HEAT_GROUPS: readonly WatchlistHeatGroup[] = ['none', 'section', 'sector'];

export interface HeatmapPrefs {
  /** What a tile's area means (shared by the watchlist and screener heatmaps). */
  sizeBy: SizeMetricId;
  /** What a tile's colour means. */
  colorBy: ColorMetricId;
  /** Grouping of the watchlist heatmap (the screener's lives in the screener prefs). */
  watchlistGroup: WatchlistHeatGroup;
}

export const DEFAULT_HEATMAP_PREFS: HeatmapPrefs = {
  sizeBy: 'marketCap',
  colorBy: 'change1d',
  watchlistGroup: 'none',
};

/** Validated persisted prefs; unknown or stale fields fall back to the defaults. */
export function parseHeatmapPrefs(v: unknown): Partial<HeatmapPrefs> {
  const out: Partial<HeatmapPrefs> = {};
  if (!isObj(v)) return out;
  if (isSizeMetric(v.sizeBy)) out.sizeBy = v.sizeBy;
  if (isColorMetric(v.colorBy)) out.colorBy = v.colorBy;
  if (
    typeof v.watchlistGroup === 'string' &&
    (WATCHLIST_HEAT_GROUPS as readonly string[]).includes(v.watchlistGroup)
  )
    out.watchlistGroup = v.watchlistGroup as WatchlistHeatGroup;
  return out;
}

interface HeatmapPrefsState extends HeatmapPrefs {
  setSizeBy: (m: SizeMetricId) => void;
  setColorBy: (m: ColorMetricId) => void;
  setWatchlistGroup: (g: WatchlistHeatGroup) => void;
}

/** Heatmap preferences (kept on this device only). */
export const useHeatmapPrefs = create<HeatmapPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_HEATMAP_PREFS,
      setSizeBy: (sizeBy) => set({ sizeBy }),
      setColorBy: (colorBy) => set({ colorBy }),
      setWatchlistGroup: (watchlistGroup) => set({ watchlistGroup }),
    }),
    {
      name: 'tickerglass-heatmap',
      version: 1,
      partialize: (s) => ({
        sizeBy: s.sizeBy,
        colorBy: s.colorBy,
        watchlistGroup: s.watchlistGroup,
      }),
      merge: (persisted, current) => ({ ...current, ...parseHeatmapPrefs(persisted) }),
    },
  ),
);
