import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { tryParseSymbolExpression, type CrosshairMode, type MagnetMode } from '@tickerglass/engine';
import type { ChartViewData } from './chartView';
import { DEFAULT_FAVORITE_INTERVALS } from '../topbar/intervals';

export type Theme = 'dark' | 'light';
export type { ChartType } from '@tickerglass/engine';

/** Persisted user preferences (a chart's symbol and settings live in its chart view). */
interface AppState {
  theme: Theme;
  favoriteIntervals: string[];
  customIntervals: string[];
  crosshair: CrosshairMode;
  magnet: MagnetMode;
  recentSymbols: string[];
  toggleTheme: () => void;
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

/** Chart view values the app store held before v4 (null once migrated or on a fresh start). */
let legacy: Record<string, unknown> | null = null;

/**
 * The symbol, interval and chart settings a pre-v4 app store held, validated,
 * for the first chart to start from. Does not consume them (React StrictMode
 * mounts the chart twice).
 */
export function legacyChartView(): Partial<ChartViewData> | null {
  if (!legacy) return null;
  const out: Partial<ChartViewData> = {};
  const l = legacy;
  if (typeof l.symbol === 'string') out.symbol = normalizeSymbol(l.symbol);
  if (typeof l.interval === 'string') out.interval = l.interval;
  if (typeof l.chartType === 'string') out.chartType = l.chartType as ChartViewData['chartType'];
  if (typeof l.chartStyle === 'object' && l.chartStyle !== null)
    out.chartStyle = l.chartStyle as ChartViewData['chartStyle'];
  if (typeof l.showPrevClose === 'boolean') out.showPrevClose = l.showPrevClose;
  if (typeof l.timezone === 'string') out.timezone = l.timezone;
  if (typeof l.prepost === 'boolean') out.prepost = l.prepost;
  return Object.keys(out).length ? out : null;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'dark',
      favoriteIntervals: [...DEFAULT_FAVORITE_INTERVALS],
      customIntervals: [],
      crosshair: 'cross',
      magnet: 'off',
      recentSymbols: [],
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
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
      name: 'tickerglass-app',
      version: 4,
      // v3 -> v4: symbol, interval and chart settings moved to the per-chart view;
      // the old values seed the first chart (see legacyChartView).
      migrate: (s, version) => {
        const {
          symbol,
          interval,
          chartType,
          chartStyle,
          showPrevClose,
          timezone,
          prepost,
          ...rest
        } = (s ?? {}) as Record<string, unknown>;
        if (version < 4)
          legacy = { symbol, interval, chartType, chartStyle, showPrevClose, timezone, prepost };
        return rest as unknown as AppState;
      },
      merge: (persisted, current) => {
        // `volume` (built-in volume mode) is legacy: the indicator store migrates
        // it to the Volume indicator (see legacyAppVolume) and the key is dropped
        // on this store's next write.
        const { volume: _legacy, ...p } = (persisted ?? {}) as Partial<AppState> & {
          volume?: unknown;
        };
        return { ...current, ...p };
      },
    },
  ),
);
