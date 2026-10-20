import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RightPanel =
  'watchlist' | 'alerts' | 'objectTree' | 'dataWindow' | 'details' | 'news' | 'notes';

export type DialogId =
  | 'symbolSearch'
  | 'compare'
  | 'indicators'
  | 'indicatorSettings'
  | 'drawingSettings'
  | 'settings'
  | 'commandPalette'
  | 'goToDate'
  | 'intervalInput'
  | 'shortcuts'
  | 'loadLayout'
  | 'dataTransfer'
  | 'alert'
  | 'scriptEditor';

/** Drawing tool ids are defined by the left toolbar (Phase 6 implements them). */
export type DrawingToolId = string;

interface UiState {
  rightPanel: RightPanel | null;
  rightWidth: number;
  dialog: DialogId | null;
  /** Payload for the open dialog (e.g. initial search text). */
  dialogArg: unknown;
  activeTool: DrawingToolId; // 'cursor' | 'cross' | 'dot' | 'arrow' | drawing tool id
  /** Last used tool per toolbar group, shown on the group button. */
  groupTools: Record<string, DrawingToolId>;
  favoriteTools: DrawingToolId[];
  showFavoritesBar: boolean;
  stayInDrawingMode: boolean;
  /** New drawings are created synced to all symbols (scope 'all'). */
  syncNewDrawings: boolean;
  lockAll: boolean;
  hideAll: boolean;
  /** Legacy (before Phase 7): the general note, now in persist/notes. Read once to seed it. */
  notes: string;
  togglePanel: (panel: RightPanel) => void;
  setRightWidth: (w: number) => void;
  openDialog: (id: DialogId, arg?: unknown) => void;
  closeDialog: () => void;
  set: (patch: Partial<UiState>) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      rightPanel: null,
      rightWidth: 300,
      dialog: null,
      dialogArg: undefined,
      activeTool: 'cross',
      groupTools: {},
      favoriteTools: [],
      showFavoritesBar: false,
      stayInDrawingMode: false,
      syncNewDrawings: false,
      lockAll: false,
      hideAll: false,
      notes: '',
      togglePanel: (panel) => set((s) => ({ rightPanel: s.rightPanel === panel ? null : panel })),
      setRightWidth: (w) => set({ rightWidth: Math.max(220, Math.min(600, w)) }),
      openDialog: (id, arg) => set({ dialog: id, dialogArg: arg }),
      closeDialog: () => set({ dialog: null, dialogArg: undefined }),
      set: (patch) => set(patch),
    }),
    {
      name: 'investopen-ui',
      partialize: ({ dialog: _d, dialogArg: _a, ...rest }) => rest,
    },
  ),
);
