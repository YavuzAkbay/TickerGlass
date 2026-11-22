/**
 * Strategy tester state (docs/backtest.md §5). Strategies are a synced user
 * setting (`backtest.strategies`, see persist/settingsSync.ts) with a
 * localStorage copy; the selected strategy and the last run are local.
 */
import {
  newStrategy,
  parseStrategies,
  type BacktestResult,
  type IndicatorOperand,
  type Strategy,
} from '@tickerglass/backtest';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type StrategyPatch = Partial<Omit<Strategy, 'id' | 'schemaVersion'>>;

interface StrategyStore {
  strategies: Strategy[];
  activeId: string | null;
  create: (name?: string) => Strategy;
  update: (id: string, patch: StrategyPatch | ((s: Strategy) => StrategyPatch)) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  /** Replace the list (from the server or an import). */
  adopt: (value: unknown) => void;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function uniqueName(base: string, list: readonly Strategy[]): string {
  const names = new Set(list.map((s) => s.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

export const useStrategies = create<StrategyStore>()(
  persist(
    (set, get) => ({
      strategies: [],
      activeId: null,
      create: (name) => {
        const s = newStrategy(uid(), uniqueName(name ?? 'My strategy', get().strategies));
        set((st) => ({ strategies: [...st.strategies, s], activeId: s.id }));
        return s;
      },
      update: (id, patch) =>
        set((st) => ({
          strategies: st.strategies.map((s) =>
            s.id === id
              ? {
                  ...s,
                  ...(typeof patch === 'function' ? patch(s) : patch),
                  updatedAt: new Date().toISOString(),
                }
              : s,
          ),
        })),
      duplicate: (id) => {
        const src = get().strategies.find((s) => s.id === id);
        if (!src) return;
        const copy: Strategy = {
          ...structuredClone(src),
          id: uid(),
          name: uniqueName(`${src.name} copy`, get().strategies),
          updatedAt: new Date().toISOString(),
        };
        set((st) => ({ strategies: [...st.strategies, copy], activeId: copy.id }));
      },
      remove: (id) =>
        set((st) => {
          const strategies = st.strategies.filter((s) => s.id !== id);
          return {
            strategies,
            activeId: st.activeId === id ? (strategies[0]?.id ?? null) : st.activeId,
          };
        }),
      setActive: (activeId) => set({ activeId }),
      adopt: (value) =>
        set((st) => {
          const strategies = parseStrategies(value);
          const activeId = strategies.some((s) => s.id === st.activeId)
            ? st.activeId
            : (strategies[0]?.id ?? null);
          return { strategies, activeId };
        }),
    }),
    {
      name: 'tickerglass-strategies',
      version: 1,
      partialize: (s) => ({ strategies: s.strategies, activeId: s.activeId }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as { strategies?: unknown; activeId?: unknown };
        const strategies = parseStrategies(p.strategies);
        const activeId =
          typeof p.activeId === 'string' && strategies.some((s) => s.id === p.activeId)
            ? p.activeId
            : (strategies[0]?.id ?? null);
        return { ...current, strategies, activeId };
      },
    },
  ),
);

/** Synced value of `backtest.strategies`. */
export const readStrategies = (): Strategy[] => useStrategies.getState().strategies;

export const activeStrategy = (
  s: Pick<StrategyStore, 'strategies' | 'activeId'>,
): Strategy | null => s.strategies.find((x) => x.id === s.activeId) ?? null;

// ------------------------------------------------------------- last run

export interface BacktestRun {
  strategyId: string;
  symbol: string;
  interval: string;
  /** Wall clock, ms. */
  ranAt: number;
  result: BacktestResult;
  /** Indicator operands not found on the chart (their conditions never held). */
  missing: IndicatorOperand[];
  /** Price decimals of the symbol. */
  decimals: number;
  timezone: string;
}

interface RunStore {
  run: BacktestRun | null;
  error: string | null;
  set: (patch: Partial<Pick<RunStore, 'run' | 'error'>>) => void;
}

export const useBacktestRun = create<RunStore>()((set) => ({
  run: null,
  error: null,
  set: (patch) => set(patch),
}));
