import { resolveDrawingType } from '@investopen/engine';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Locale } from '../i18n';

/** Sections of the Navigator panel, in rail order. */
export const NAV_SECTIONS = [
  'watchlist',
  'alerts',
  'events',
  'news',
  'notes',
  'objectTree',
  'dataWindow',
  /** Paper trades of the running replay (only while replaying; never saved). */
  'replayTrading',
] as const;
export type NavSection = (typeof NAV_SECTIONS)[number];
/** @deprecated Alias of `NavSection`, kept for one phase. */
export type RightPanel = NavSection;

/** Content of the Inspector (transient; never saved). */
export interface InspectorState {
  view: 'symbol' | 'drawing';
  id?: string;
}

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
  /** Interface language (messages in i18n/; only English for now). */
  locale: Locale;
  /** The Navigator panel is expanded (its rail is always visible). */
  navOpen: boolean;
  /** Section shown by the Navigator (remembered while collapsed). */
  navSection: NavSection;
  /** Width of the expanded Navigator panel in px. */
  navWidth: number;
  /** Width of the Inspector in px. */
  inspectorWidth: number;
  /** What the Inspector shows; null while it is hidden. Not saved. */
  inspector: InspectorState | null;
  /** The drawing tool rail on the right edge is collapsed to zero width. */
  toolRailHidden: boolean;
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
  /** Open `section`, or collapse the Navigator if it is the open one. */
  toggleNav: (section: NavSection) => void;
  /** Open the Navigator on `section`. */
  showNav: (section: NavSection) => void;
  setNavOpen: (open: boolean) => void;
  setNavWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  openInspector: (view: InspectorState['view'], id?: string) => void;
  closeInspector: () => void;
  toggleToolRail: () => void;
  openDialog: (id: DialogId, arg?: unknown) => void;
  closeDialog: () => void;
  set: (patch: Partial<UiState>) => void;
}

/** Persisted `investopen-ui` version: 1 = renamed drawing tool ids, 2 = bottom dock and tool rail, 3 = Navigator. */
export const UI_STORE_VERSION = 3;

export const DEFAULT_NAV_WIDTH = 260;
export const MIN_NAV_WIDTH = 200;
export const MAX_NAV_WIDTH = 480;
export const DEFAULT_INSPECTOR_WIDTH = 300;
export const MIN_INSPECTOR_WIDTH = 260;
export const MAX_INSPECTOR_WIDTH = 480;

export const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** Add the tool rail field to preferences saved before version 2. */
export function migrateDockDefaults<T extends object>(state: T): T {
  const s = state as { toolRailHidden?: unknown; [k: string]: unknown };
  return {
    ...s,
    toolRailHidden: typeof s.toolRailHidden === 'boolean' ? s.toolRailHidden : false,
  } as unknown as T;
}

const isNavSection = (v: unknown): v is NavSection =>
  typeof v === 'string' && (NAV_SECTIONS as readonly string[]).includes(v);

/**
 * Replace the bottom dock fields (`rightPanel`, `dockTab`, `dockHeight`, `rightWidth`)
 * with the Navigator ones. The removed details panel and the replay trading panel
 * (which only exists while replaying) fall back to the watchlist. Idempotent.
 */
export function migrateNavigator<T extends object>(
  state: T,
  /** Settings sync: never inject a width, so the local one survives a payload without nav keys. */
  keepWidth = false,
): T {
  const {
    rightPanel,
    dockTab,
    dockHeight: _h,
    rightWidth: _w,
    ...s
  } = state as {
    rightPanel?: unknown;
    dockTab?: unknown;
    dockHeight?: unknown;
    rightWidth?: unknown;
    [k: string]: unknown;
  };
  if (typeof s.navSection === 'string') return s as unknown as T;
  const src = rightPanel ?? dockTab ?? 'watchlist';
  return {
    ...s,
    navSection: isNavSection(src) && src !== 'replayTrading' ? src : 'watchlist',
    navOpen: 'rightPanel' in state ? rightPanel != null : true,
    ...(keepWidth ? {} : { navWidth: DEFAULT_NAV_WIDTH }),
  } as unknown as T;
}

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

/** The saved part of the store: no dialog or Inspector state, no replay trading section. */
export function partializeUi({
  dialog: _d,
  dialogArg: _a,
  inspector: _i,
  ...rest
}: UiState): Omit<UiState, 'dialog' | 'dialogArg' | 'inspector'> {
  return {
    ...rest,
    // The trading panel only exists while replaying.
    navSection: rest.navSection === 'replayTrading' ? 'watchlist' : rest.navSection,
  };
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      locale: 'en',
      navOpen: true,
      navSection: 'watchlist',
      navWidth: DEFAULT_NAV_WIDTH,
      inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
      inspector: null,
      toolRailHidden: false,
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
      toggleNav: (section) =>
        set((s) =>
          s.navOpen && s.navSection === section
            ? { navOpen: false }
            : { navOpen: true, navSection: section },
        ),
      showNav: (section) => set({ navOpen: true, navSection: section }),
      setNavOpen: (open) => set({ navOpen: open }),
      setNavWidth: (w) => set({ navWidth: clamp(w, MIN_NAV_WIDTH, MAX_NAV_WIDTH) }),
      setInspectorWidth: (w) =>
        set({ inspectorWidth: clamp(w, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH) }),
      openInspector: (view, id) => set({ inspector: id === undefined ? { view } : { view, id } }),
      closeInspector: () => set({ inspector: null }),
      toggleToolRail: () => set((s) => ({ toolRailHidden: !s.toolRailHidden })),
      openDialog: (id, arg) => set({ dialog: id, dialogArg: arg }),
      closeDialog: () => set({ dialog: null, dialogArg: undefined }),
      set: (patch) => set(patch),
    }),
    {
      name: 'investopen-ui',
      version: UI_STORE_VERSION,
      // The persisted shape is the `partialize` result; unknown fields pass through untouched.
      migrate: (persisted) =>
        migrateNavigator(migrateDockDefaults(migrateToolIds((persisted ?? {}) as object))) as never,
      partialize: partializeUi,
    },
  ),
);
