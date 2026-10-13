import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface AppState {
  theme: Theme;
  symbol: string;
  interval: string;
  toggleTheme: () => void;
  setSymbol: (symbol: string) => void;
  setInterval: (interval: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      theme: 'dark',
      symbol: 'AAPL',
      interval: '1D',
      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
      setSymbol: (symbol) => set({ symbol }),
      setInterval: (interval) => set({ interval }),
    }),
    { name: 'investopen-app' },
  ),
);
