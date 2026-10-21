/** What replay paper trading draws on the chart (setting `replay.trading`). */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { isObj } from '../persist/net';

export interface TradingPrefs {
  /** Arrows on the bars where orders were filled. */
  tradeMarkers: boolean;
  /** Dashed line at the average price of the open position. */
  positionLine: boolean;
  /** Unrealized profit and loss in the position line label. */
  pnlLabel: boolean;
}

export const DEFAULT_TRADING_PREFS: TradingPrefs = {
  tradeMarkers: true,
  positionLine: true,
  pnlLabel: true,
};

/** Validate a value from the server or an import; invalid fields are left out. */
export function parseTradingPrefs(v: unknown): Partial<TradingPrefs> {
  const out: Partial<TradingPrefs> = {};
  if (!isObj(v)) return out;
  if (typeof v.tradeMarkers === 'boolean') out.tradeMarkers = v.tradeMarkers;
  if (typeof v.positionLine === 'boolean') out.positionLine = v.positionLine;
  if (typeof v.pnlLabel === 'boolean') out.pnlLabel = v.pnlLabel;
  return out;
}

interface PrefsState extends TradingPrefs {
  set: (patch: Partial<TradingPrefs>) => void;
}

const pick = (s: TradingPrefs): TradingPrefs => ({
  tradeMarkers: s.tradeMarkers,
  positionLine: s.positionLine,
  pnlLabel: s.pnlLabel,
});

export const useTradingPrefs = create<PrefsState>()(
  persist<PrefsState, [], [], TradingPrefs>(
    (set) => ({
      ...DEFAULT_TRADING_PREFS,
      set: (patch) => set(parseTradingPrefs({ ...patch })),
    }),
    {
      name: 'tickerglass-trading-prefs',
      version: 1,
      partialize: pick,
      merge: (persisted, current) => ({ ...current, ...parseTradingPrefs(persisted) }),
    },
  ),
);

export const readTradingPrefs = (): TradingPrefs => pick(useTradingPrefs.getState());
