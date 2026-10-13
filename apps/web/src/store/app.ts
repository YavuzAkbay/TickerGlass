import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  ChartStyle,
  ChartType,
  CrosshairMode,
  DeepPartial,
  MagnetMode,
  VolumeMode,
} from '@investopen/engine';

export type Theme = 'dark' | 'light';
export type { ChartType };

/** Persisted user preferences and the active chart's symbol/interval. */
interface AppState {
  theme: Theme;
  symbol: string;
  interval: string;
  favoriteIntervals: string[];
  customIntervals: string[];
  chartType: ChartType;
  /** Per-type style overrides on top of theme defaults. */
  chartStyle: DeepPartial<ChartStyle>;
  volume: VolumeMode;
  showPrevClose: boolean;
  timezone: string; // 'exchange' | 'local' | 'UTC' | IANA
  prepost: boolean;
  crosshair: CrosshairMode;
  magnet: MagnetMode;
  recentSymbols: string[];
  toggleTheme: () => void;
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
  toggleFavoriteInterval: (interval: string) => void;
  addCustomInterval: (interval: string) => void;
  removeCustomInterval: (interval: string) => void;
  set: (patch: Partial<AppState>) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'dark',
      symbol: 'AAPL',
      interval: '1D',
      favoriteIntervals: ['5m', '1h', '1D', '1W'],
      customIntervals: [],
      chartType: 'candles',
      chartStyle: {},
      volume: 'overlay',
      showPrevClose: false,
      timezone: 'exchange',
      prepost: false,
      crosshair: 'cross',
      magnet: 'off',
      recentSymbols: [],
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setSymbol: (symbol) =>
        set((s) => ({
          symbol,
          recentSymbols: [symbol, ...s.recentSymbols.filter((x) => x !== symbol)].slice(0, 12),
        })),
      setInterval: (interval) => set({ interval }),
      toggleFavoriteInterval: (iv) =>
        set((s) => ({
          favoriteIntervals: s.favoriteIntervals.includes(iv)
            ? s.favoriteIntervals.filter((x) => x !== iv)
            : [...s.favoriteIntervals, iv],
        })),
      addCustomInterval: (iv) =>
        set((s) => ({ customIntervals: [...new Set([...s.customIntervals, iv])] })),
      removeCustomInterval: (iv) =>
        set((s) => ({ customIntervals: s.customIntervals.filter((x) => x !== iv) })),
      set: (patch) => set(patch),
    }),
    {
      name: 'investopen-app',
      version: 3,
      migrate: (s) =>
        ({ chartStyle: {}, volume: 'overlay', showPrevClose: false, ...(s as object) }) as AppState,
    },
  ),
);
