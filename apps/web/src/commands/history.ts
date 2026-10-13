import { create } from 'zustand';

export interface UndoEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

interface HistoryState {
  past: UndoEntry[];
  future: UndoEntry[];
  /** Record an action that has already been applied. */
  push: (entry: UndoEntry) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

const LIMIT = 200;

/** Undo/redo stack shared by chart, drawings and panels. */
export const useHistory = create<HistoryState>()((set, get) => ({
  past: [],
  future: [],
  push: (entry) => set((s) => ({ past: [...s.past.slice(-LIMIT + 1), entry], future: [] })),
  undo: () => {
    const entry = get().past.at(-1);
    if (!entry) return;
    entry.undo();
    set((s) => ({ past: s.past.slice(0, -1), future: [entry, ...s.future] }));
  },
  redo: () => {
    const entry = get().future[0];
    if (!entry) return;
    entry.redo();
    set((s) => ({ past: [...s.past, entry], future: s.future.slice(1) }));
  },
  clear: () => set({ past: [], future: [] }),
}));
