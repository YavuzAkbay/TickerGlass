import { resolveDrawingType, type Drawing, type DrawingStyle } from '@tickerglass/engine';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createActiveFacade } from '../chart/facade';
import { stripPerDrawingStyle } from './per-drawing';

/**
 * Drawings of every symbol (docs/drawings.md §6). The app owns them; the
 * engine only holds the current chart's list (see ./attach). Mutate through
 * ./actions so changes are undoable.
 */
export const STORAGE_KEY = 'tickerglass-drawings';

export interface DrawingBuckets {
  /** Scope 'symbol' drawings by `Drawing.symbol`. */
  bySymbol: Record<string, Drawing[]>;
  /** Scope 'all' drawings (shown on every symbol). */
  synced: Drawing[];
}

/** localStorage shape. Phase 7 moves the same JSON to the API. */
export interface PersistedDrawings extends DrawingBuckets {
  version: 1;
}

interface DrawingStore extends DrawingBuckets {
  /** Insert or replace by id (routed to its bucket by scope/symbol) and remove `removeIds`, in one update. */
  apply: (upserts: readonly Drawing[], removeIds?: readonly string[]) => void;
  replaceAll: (data: DrawingBuckets) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isDrawing(v: unknown): v is Drawing {
  return (
    isObj(v) &&
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    Array.isArray(v.points) &&
    isObj(v.style) &&
    typeof v.paneId === 'string'
  );
}

/** Fill fields older or hand-edited data may lack; renamed tool ids map to the current one. */
function normalize(d: Drawing): Drawing {
  return {
    ...d,
    type: resolveDrawingType(d.type),
    text: typeof d.text === 'string' ? d.text : '',
    locked: !!d.locked,
    hidden: !!d.hidden,
    zIndex: Number.isFinite(d.zIndex) ? d.zIndex : 0,
    visibility: d.visibility ?? null,
    scope: d.scope === 'all' ? 'all' : 'symbol',
    symbol: typeof d.symbol === 'string' ? d.symbol : '',
  };
}

/** A drawing from untrusted JSON (API, import), normalized; null if invalid. */
export function sanitizeDrawing(v: unknown): Drawing | null {
  return isDrawing(v) ? normalize(v) : null;
}

let remoteDepth = 0;

/**
 * Run `fn`, marking the store changes it makes as coming from elsewhere
 * (another tab, the server): the API sync does not push them back.
 */
export function withRemoteApply<T>(fn: () => T): T {
  remoteDepth++;
  try {
    return fn();
  } finally {
    remoteDepth--;
  }
}

export const isRemoteApply = (): boolean => remoteDepth > 0;

/** `parseStoredDrawings` result. */
export interface ParsedDrawings {
  data: DrawingBuckets;
  /** Why some or all of the input was not read (null: everything was). */
  problem: string | null;
}

/** Parse the stored JSON, reporting anything it could not read. */
export function parseStoredDrawings(raw: string | null): ParsedDrawings {
  const empty: DrawingBuckets = { bySymbol: {}, synced: [] };
  if (!raw) return { data: empty, problem: null };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { data: empty, problem: 'unreadable data' };
  }
  if (!isObj(data)) return { data: empty, problem: 'unreadable data' };
  if (data.version !== 1)
    return { data: empty, problem: `unknown version ${String(data.version)}` };
  let dropped = 0;
  const list = (v: unknown): Drawing[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      dropped++;
      return [];
    }
    const ok = v.filter(isDrawing);
    dropped += v.length - ok.length;
    return ok.map(normalize);
  };
  const bySymbol: Record<string, Drawing[]> = {};
  if (isObj(data.bySymbol)) {
    for (const [sym, entries] of Object.entries(data.bySymbol)) {
      const ds = list(entries);
      if (ds.length) bySymbol[sym] = ds;
    }
  } else if (data.bySymbol !== undefined) dropped++;
  const synced = list(data.synced);
  return {
    data: { bySymbol, synced },
    problem: dropped ? `${dropped} invalid entr${dropped === 1 ? 'y' : 'ies'} skipped` : null,
  };
}

/** Parse the stored JSON; anything unreadable is left out. */
export function parseDrawings(raw: string | null): DrawingBuckets {
  return parseStoredDrawings(raw).data;
}

export function serializeDrawings({ bySymbol, synced }: DrawingBuckets): string {
  const out: PersistedDrawings = { version: 1, bySymbol: {}, synced };
  for (const [sym, list] of Object.entries(bySymbol)) if (list.length) out.bySymbol[sym] = list;
  return JSON.stringify(out);
}

/** Bucket key of a drawing: null = synced. */
const bucketOf = (d: Drawing): string | null => (d.scope === 'all' ? null : d.symbol);

/** Pure `apply`: replaces in place when the bucket is unchanged, else moves. */
export function applyToBuckets(
  s: DrawingBuckets,
  upserts: readonly Drawing[],
  removeIds: readonly string[] = [],
): DrawingBuckets {
  const drop = new Set(removeIds);
  const byId = new Map(upserts.map((d) => [d.id, d]));
  const placed = new Set<string>();
  const mapList = (list: Drawing[], key: string | null): Drawing[] => {
    const out: Drawing[] = [];
    for (const d of list) {
      if (drop.has(d.id) && !byId.has(d.id)) continue;
      const next = byId.get(d.id);
      if (!next) out.push(d);
      else if (bucketOf(next) === key) {
        out.push(next);
        placed.add(d.id);
      }
    }
    return out;
  };
  const bySymbol: Record<string, Drawing[]> = {};
  for (const [sym, list] of Object.entries(s.bySymbol)) bySymbol[sym] = mapList(list, sym);
  let synced = mapList(s.synced, null);
  for (const d of byId.values()) {
    if (placed.has(d.id)) continue;
    const key = bucketOf(d);
    if (key === null) synced = [...synced, d];
    else bySymbol[key] = [...(bySymbol[key] ?? []), d];
  }
  for (const sym of Object.keys(bySymbol)) if (!bySymbol[sym]!.length) delete bySymbol[sym];
  return { bySymbol, synced };
}

/** Key of a backup of stored drawings that could not be (fully) read. */
export const backupKey = (now: number) => `${STORAGE_KEY}.backup-${now}`;

/** `loadDrawings` result. */
export interface LoadedDrawings {
  data: DrawingBuckets;
  /** Message for the user (once), or null when everything loaded. */
  warning: string | null;
  /** False when unread data could not be backed up: saving would destroy it. */
  writable: boolean;
}

/**
 * Read the stored drawings. Data that cannot be fully read (bad JSON, an
 * unknown version, invalid entries) is first copied to `backupKey(now)`, so
 * the next save never overwrites it blindly; if even that fails, saving is
 * disabled for this session.
 */
export function loadDrawings(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  now = Date.now(),
): LoadedDrawings {
  let raw: string | null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch (err) {
    return {
      data: { bySymbol: {}, synced: [] },
      warning: `Drawings could not be read: ${err instanceof Error ? err.message : String(err)}`,
      writable: false,
    };
  }
  const { data, problem } = parseStoredDrawings(raw);
  if (!problem || !raw || !storage) return { data, warning: null, writable: true };
  try {
    storage.setItem(backupKey(now), raw);
    return {
      data,
      warning: `Some saved drawings could not be loaded (${problem}). The original data was kept as "${backupKey(now)}".`,
      writable: true,
    };
  } catch {
    return {
      data,
      warning: `Some saved drawings could not be loaded (${problem}) and could not be backed up; drawing changes will not be saved this session.`,
      writable: false,
    };
  }
}

const initial = loadDrawings(globalThis.localStorage);
/** Outcome of the initial load, reported once by `startDrawingPersistence`. */
let loadState = { warning: initial.warning, writable: initial.writable };

/** Tests: the outcome of a load as if it had happened at startup. */
export function setLoadState(state: { warning: string | null; writable: boolean }): void {
  loadState = { ...state };
}

export const useDrawingStore = create<DrawingStore>()((set) => ({
  ...initial.data,
  apply: (upserts, removeIds) => set((s) => applyToBuckets(s, upserts, removeIds)),
  replaceAll: (data) => set({ bySymbol: data.bySymbol, synced: data.synced }),
}));

/**
 * Drawings shown on chart `chartId` for `symbol`: its own plus the synced
 * ones, minus those bound to another chart (`Drawing.chartId`, set when
 * drawing sync is off). Unbound drawings show on every chart.
 */
export function drawingsFor(s: DrawingBuckets, symbol: string, chartId: string): Drawing[] {
  return [...(s.bySymbol[symbol] ?? []), ...s.synced].filter(
    (d) => d.chartId === undefined || d.chartId === chartId,
  );
}

export function findStoredDrawing(id: string): Drawing | undefined {
  const s = useDrawingStore.getState();
  for (const list of [s.synced, ...Object.values(s.bySymbol)]) {
    const d = list.find((x) => x.id === id);
    if (d) return d;
  }
  return undefined;
}

type StorageLike = Pick<Storage, 'setItem'>;
type EventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>;

const pick = (s: DrawingBuckets): DrawingBuckets => ({ bySymbol: s.bySymbol, synced: s.synced });

export const allDrawings = (s: DrawingBuckets): Drawing[] => [
  ...s.synced,
  ...Object.values(s.bySymbol).flat(),
];

/**
 * Three-way merge by id: the changes from `base` to `local` (this tab's
 * unsaved edits) applied on top of `incoming` (another tab's save).
 */
export function mergeBuckets(
  base: DrawingBuckets,
  local: DrawingBuckets,
  incoming: DrawingBuckets,
): DrawingBuckets {
  const before = new Map(allDrawings(base).map((d) => [d.id, d]));
  const now = allDrawings(local);
  const nowIds = new Set(now.map((d) => d.id));
  const upserts = now.filter((d) => before.get(d.id) !== d);
  const removes = [...before.keys()].filter((id) => !nowIds.has(id));
  return upserts.length || removes.length ? applyToBuckets(incoming, upserts, removes) : incoming;
}

/**
 * Debounced save of the store on every change. Returns `flush` (save now if
 * pending) and `stop`. A failing storage (quota, disabled) reports once, as
 * does a problem of the initial load. Saves by other tabs (`storage` events
 * on `events`) are merged in: this tab's unsaved edits are re-applied on top.
 */
export function startDrawingPersistence(
  storage: StorageLike | undefined = globalThis.localStorage,
  delay = 300,
  onError: (message: string) => void = () => {},
  events: EventSource | undefined = globalThis.window,
): { flush: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reported = false;
  /** Store state last written / read: the merge base for other tabs' saves. */
  let saved: DrawingBuckets = pick(useDrawingStore.getState());
  if (loadState.warning) {
    onError(loadState.warning);
    loadState = { ...loadState, warning: null };
  }
  const save = () => {
    timer = null;
    if (!storage || !loadState.writable) return;
    const state = pick(useDrawingStore.getState());
    try {
      storage.setItem(STORAGE_KEY, serializeDrawings(state));
      saved = state;
      reported = false;
    } catch (err) {
      if (reported) return;
      reported = true;
      onError(`Drawings could not be saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const off = useDrawingStore.subscribe((s) => {
    // Adopting another tab's save needs no write back.
    if (s.bySymbol === saved.bySymbol && s.synced === saved.synced) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, delay);
  });
  const onStorage = (e: Event) => {
    const { key, newValue } = e as StorageEvent;
    // key null: the other tab cleared the storage.
    if (key !== STORAGE_KEY && key !== null) return;
    const parsed = parseStoredDrawings(newValue ?? null);
    if (parsed.problem) {
      // Not ours to interpret (newer version?): keep this tab's data.
      onError(`Drawings saved in another tab could not be read (${parsed.problem}).`);
      return;
    }
    const local = pick(useDrawingStore.getState());
    const merged = mergeBuckets(saved, local, parsed.data);
    saved = parsed.data;
    // The other tab syncs its own edits to the API.
    withRemoteApply(() => useDrawingStore.getState().replaceAll(merged));
  };
  events?.addEventListener('storage', onStorage);
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    save();
  };
  return {
    flush,
    stop: () => {
      off();
      events?.removeEventListener('storage', onStorage);
      flush();
    },
  };
}

// ------------------------------------------------------------ runtime state

export interface TextEdit {
  id: string;
  x: number;
  y: number;
  /** Opened right after creation (an empty result removes the drawing). */
  created: boolean;
}

/** Live UI state of one chart's drawing layer (not persisted). */
export interface DrawingRuntime {
  /** Engine selection. */
  selection: string[];
  /** A drawing drag is in progress (the mini-toolbar hides). */
  dragging: boolean;
  /** Last pointer release over the chart (viewport px): mini-toolbar anchor. */
  pointer: { x: number; y: number } | null;
  textEdit: TextEdit | null;
}

export const createDrawingRuntimeStore = (): StoreApi<DrawingRuntime> =>
  createStore<DrawingRuntime>()(() => ({
    selection: [],
    dragging: false,
    pointer: null,
    textEdit: null,
  }));

/**
 * The active chart's drawing runtime (selection, drag, text editor). Each
 * chart has its own, so a gesture on one never leaks to another. Per-chart
 * code uses `session.drawingRuntime` instead.
 */
export const useDrawingRuntime = createActiveFacade(
  (s) => s.drawingRuntime,
  createDrawingRuntimeStore,
);

/** Copied drawings (Ctrl+C), as JSON: shared by all charts. */
export const useDrawingClipboard = create<{ clipboard: string | null }>()(() => ({
  clipboard: null,
}));

// ------------------------------------------------------------ templates

export interface DrawingTemplate {
  name: string;
  style: DrawingStyle;
}

/** Per-tool named style templates and "default" styles for new drawings. */
interface DrawingTemplates {
  byType: Record<string, DrawingTemplate[]>;
  defaults: Record<string, DrawingStyle>;
  saveTemplate: (type: string, name: string, style: DrawingStyle) => void;
  removeTemplate: (type: string, name: string) => void;
  saveDefault: (type: string, style: DrawingStyle) => void;
  clearDefault: (type: string) => void;
}

/**
 * Key tool-keyed records by current tool id: entries stored under a renamed id
 * move to the new one (an entry already under the new id wins).
 */
export function mapToolKeys<V>(record: Record<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [type, v] of Object.entries(record)) {
    const now = resolveDrawingType(type);
    if (now === type || !(now in record)) out[now] = v;
  }
  return out;
}

/** Stored templates and default styles with their tool ids mapped to the current ones. */
export function migrateTemplates(
  persisted: unknown,
): Pick<DrawingTemplates, 'byType' | 'defaults'> {
  const p = isObj(persisted) ? persisted : {};
  return {
    byType: isObj(p.byType) ? mapToolKeys(p.byType as DrawingTemplates['byType']) : {},
    defaults: isObj(p.defaults) ? mapToolKeys(p.defaults as DrawingTemplates['defaults']) : {},
  };
}

/** Persisted `tickerglass-drawing-templates` version: 2 = renamed tool ids. */
export const TEMPLATES_STORE_VERSION = 2;

export const useDrawingTemplates = create<DrawingTemplates>()(
  persist(
    (set) => ({
      byType: {},
      defaults: {},
      saveTemplate: (type, name, style) =>
        set((s) => ({
          byType: {
            ...s.byType,
            [type]: [
              ...(s.byType[type] ?? []).filter((t) => t.name !== name),
              { name, style: stripPerDrawingStyle(type, style) },
            ],
          },
        })),
      removeTemplate: (type, name) =>
        set((s) => ({
          byType: { ...s.byType, [type]: (s.byType[type] ?? []).filter((t) => t.name !== name) },
        })),
      saveDefault: (type, style) =>
        set((s) => ({ defaults: { ...s.defaults, [type]: stripPerDrawingStyle(type, style) } })),
      clearDefault: (type) =>
        set((s) => {
          const { [type]: _dropped, ...rest } = s.defaults;
          return { defaults: rest };
        }),
    }),
    {
      name: 'tickerglass-drawing-templates',
      version: TEMPLATES_STORE_VERSION,
      migrate: (persisted) => migrateTemplates(persisted) as DrawingTemplates,
    },
  ),
);

/** The stored drawing with this id (any symbol bucket), if any. */
export function lookupDrawing(s: DrawingBuckets, id: unknown): Drawing | undefined {
  if (typeof id !== 'string') return undefined;
  return allDrawings(s).find((d) => d.id === id);
}
