import { resolveDrawingType } from '@investopen/engine';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type RightPanel =
  | 'watchlist'
  | 'alerts'
  | 'objectTree'
  | 'dataWindow'
  | 'details'
  | 'news'
  | 'notes'
  /** Paper trades of the running replay (only while replaying; never saved). */
  | 'replayTrading';

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

/** Persisted `investopen-ui` version: 1 = renamed drawing tool ids. */
export const UI_STORE_VERSION = 1;

/** Map renamed tool ids in stored toolbar preferences to the current ones. */
export function migrateToolIds<T extends object>(state: T): T {
  const s = state as {
    activeTool?: unknown;
    groupTools?: unknown;
    favoriteTools?: unknown;
  };
  const out: typeof s = { ...s };
  if (typeof s.activeTool === 'string') out.activeTool = resolveDrawingType(s.activeTool);
  if (typeof s.groupTools === 'object' && s.groupTools !== null && !Array.isArray(s.groupTools))
    out.groupTools = Object.fromEntries(
      Object.entries(s.groupTools).map(([group, tool]) => [
        group,
        typeof tool === 'string' ? resolveDrawingType(tool) : tool,
      ]),
    );
  if (Array.isArray(s.favoriteTools))
    out.favoriteTools = [
      ...new Set(
        s.favoriteTools.map((tool) => (typeof tool === 'string' ? resolveDrawingType(tool) : tool)),
      ),
    ];
  return out as T;
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
      version: UI_STORE_VERSION,
      // The persisted shape is the `partialize` result; unknown fields pass through untouched.
      migrate: (persisted) => migrateToolIds((persisted ?? {}) as object) as never,
      partialize: ({ dialog: _d, dialogArg: _a, ...rest }) => ({
        ...rest,
        // The trading panel only exists while replaying.
        rightPanel: rest.rightPanel === 'replayTrading' ? null : rest.rightPanel,
      }),
    },
  ),
);
