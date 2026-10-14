import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  tryParseSymbolExpression,
  type ChartStyle,
  type ChartType,
  type CrosshairMode,
  type DeepPartial,
  type MagnetMode,
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

/**
 * Symbol as the engine stores it (`Chart.getSymbol()`): trimmed, upper case;
 * symbol expressions in canonical form (e.g. ' (aapl+msft)/2 ' -> '(AAPL+MSFT)/2').
 */
export function normalizeSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  const parsed = tryParseSymbolExpression(upper);
  return parsed.ok ? parsed.value.canonical : upper;
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
      showPrevClose: false,
      timezone: 'exchange',
      prepost: false,
      crosshair: 'cross',
      magnet: 'off',
      recentSymbols: [],
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      // Upper-cased like the engine (Chart.setSymbol), so drawing bucket keys
      // match the symbol the engine filters by.
      setSymbol: (raw) => {
        const symbol = normalizeSymbol(raw);
        set((s) => ({
          symbol,
          recentSymbols: [symbol, ...s.recentSymbols.filter((x) => x !== symbol)].slice(0, 12),
        }));
      },
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
      migrate: (s) => ({ chartStyle: {}, showPrevClose: false, ...(s as object) }) as AppState,
      merge: (persisted, current) => {
        // `volume` (built-in volume mode) is legacy: the indicator store migrates
        // it to the Volume indicator (see legacyAppVolume) and the key is dropped
        // on this store's next write.
        const { volume: _legacy, ...p } = (persisted ?? {}) as Partial<AppState> & {
          volume?: unknown;
        };
        return {
          ...current,
          ...p,
          symbol: typeof p.symbol === 'string' ? normalizeSymbol(p.symbol) : current.symbol,
        };
      },
    },
  ),
);
