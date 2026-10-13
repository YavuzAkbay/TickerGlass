import { create } from 'zustand';

export interface UndoEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

interface HistoryState {
  past: UndoEntry[];
  future: UndoEntry[];
  /** An undo/redo is running: side effects it triggers (e.g. an engine
   * `paneRemoved`) must not record new entries; `push` ignores them. */
  applying: boolean;
  /** Record an action that has already been applied. */
  push: (entry: UndoEntry) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
}

const LIMIT = 200;

/** Undo/redo stack shared by chart, drawings and panels. */
export const useHistory = create<HistoryState>()((set, get) => {
  const applying = (fn: () => void) => {
    set({ applying: true });
    try {
      fn();
    } finally {
      set({ applying: false });
    }
  };
  return {
    past: [],
    future: [],
    applying: false,
    push: (entry) => {
      if (get().applying) return;
      set((s) => ({ past: [...s.past.slice(-LIMIT + 1), entry], future: [] }));
    },
    undo: () => {
      const entry = get().past.at(-1);
      if (!entry || get().applying) return;
      applying(() => entry.undo());
      set((s) => ({ past: s.past.slice(0, -1), future: [entry, ...s.future] }));
    },
    redo: () => {
      const entry = get().future[0];
      if (!entry || get().applying) return;
      applying(() => entry.redo());
      set((s) => ({ past: [...s.past, entry], future: s.future.slice(1) }));
    },
    clear: () => set({ past: [], future: [] }),
  };
});
