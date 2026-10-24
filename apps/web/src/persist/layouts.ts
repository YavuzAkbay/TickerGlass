/**
 * The current layout: restore on startup, debounced autosave with optimistic
 * concurrency, offline cache, and the named-layout operations of the layout
 * menu (docs/persistence.md §6).
 */
import { create } from 'zustand';
import { createLayoutAutosaver, type LayoutAutosaver } from '../api/autosave';
import { errorMessage, type ApiError } from '../api/client';
import * as persistence from '../api/persistence';
import type { Layout, LayoutFile, LayoutSummary } from '../api/types';
import {
  LAYOUT_SCHEMA_VERSION,
  applyLayoutState,
  captureLayoutState,
  parseLayoutState,
  rekeyChartIds,
  stateKey,
  type LayoutState,
} from './layoutState';
import { isNotFound, isObj, isTransient, readJson, safeStorage, type SafeStorage } from './net';

/** The state key without any chart's time scale (view position/zoom). */
function viewKey(key: string): string {
  const s = JSON.parse(key) as { charts?: { chart?: { timeScale?: unknown } | null }[] };
  for (const c of s.charts ?? []) if (c.chart) delete c.chart.timeScale;
  return JSON.stringify(s);
}

/** The state key without the focused chart id (focus is view-only: it rides along with the next save). */
function focusKey(key: string): string {
  const s = JSON.parse(key) as { activeChartId?: unknown };
  delete s.activeChartId;
  return JSON.stringify(s);
}

export const LAYOUT_CACHE_KEY = 'tickerglass-layout';
/** Unsaved state of a layout that no longer exists on the server (kept for "Save as new"). */
export const LAYOUT_ORPHAN_KEY = 'tickerglass-layout.orphan';
/** After applying a layout, view-only changes (the chart settling) are not edits for this long. */
const SETTLE_MS = 1500;
export const DEFAULT_LAYOUT_NAME = 'Untitled';

export type LayoutApi = Pick<
  typeof persistence,
  | 'getLastUsedLayout'
  | 'setLastUsedLayout'
  | 'createLayout'
  | 'getLayout'
  | 'saveLayout'
  | 'listLayouts'
  | 'renameLayout'
  | 'deleteLayout'
  | 'exportLayout'
  | 'importLayout'
>;

/** localStorage copy of the current layout (offline cache). */
export interface LayoutCache {
  /** null: never reached the server (created offline). */
  id: string | null;
  name: string;
  /** Server revision `state` is based on (0 when id is null). */
  revision: number;
  /** `state` has changes the server does not have yet. */
  dirty: boolean;
  state: LayoutState;
}

export interface LayoutStatus {
  /** Shown in the top bar; id null while offline without a known layout. */
  current: { id: string | null; name: string } | null;
  /** The last API call reached the server. */
  online: boolean;
  /** Changes not saved to the server yet. */
  dirty: boolean;
  saving: boolean;
  /** Startup restore finished (successfully or offline). */
  ready: boolean;
  /** Drawing changes not on the server yet. */
  drawingsPending: boolean;
}

export const useLayoutStatus = create<LayoutStatus>()(() => ({
  current: null,
  online: true,
  dirty: false,
  saving: false,
  ready: false,
  drawingsPending: false,
}));

export interface Notifier {
  info: (message: string) => void;
  error: (message: string) => void;
  /** A conflict with choices. */
  conflict: (message: string, actions: { label: string; run: () => void }[]) => void;
}

export interface LayoutSessionOptions {
  api?: LayoutApi;
  storage?: SafeStorage;
  capture?: () => LayoutState;
  apply?: (state: LayoutState) => Promise<void>;
  notify: Notifier;
  /** Autosave debounce (ms). */
  delay?: number;
  retryDelay?: number;
  now?: () => number;
}

export function readLayoutCache(storage: SafeStorage): LayoutCache | null {
  const raw = readJson<unknown>(storage.get(LAYOUT_CACHE_KEY));
  if (!isObj(raw) || typeof raw.name !== 'string') return null;
  const state = parseLayoutState(raw.state);
  if (!state) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    name: raw.name,
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    dirty: raw.dirty === true,
    state,
  };
}

/**
 * Download `blob` to the machine this browser runs on. Entirely client-side:
 * nothing is sent to (or stored on) the server.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Download `data` as a JSON file. */
export function downloadJson(data: unknown, filename: string): void {
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}

export const safeFileName = (name: string) => name.replace(/[^\w\- .]+/g, '_').trim() || 'layout';

export class LayoutSession {
  private readonly api: LayoutApi;
  private readonly storage: SafeStorage;
  private readonly capture: () => LayoutState;
  private readonly apply: (state: LayoutState) => Promise<void>;
  private readonly notify: Notifier;
  private readonly delay: number;
  private readonly retryDelay: number;
  private saver: LayoutAutosaver<LayoutState> | null = null;
  private cache: LayoutCache | null;
  private lastKey: string | null = null;
  /** Applying a layout: its own store changes are not edits. */
  private applying = 0;
  private starting: Promise<boolean> | null = null;
  private disposed = false;
  /** Until then, changes that only touch the view (time scale) re-baseline instead of saving. */
  private settleUntil = 0;
  /** The current layout was deleted on the server: saves stop, the state is kept aside. */
  private orphaned = false;
  private readonly now: () => number;

  constructor(opts: LayoutSessionOptions) {
    this.now = opts.now ?? Date.now;
    this.api = opts.api ?? persistence;
    this.storage = opts.storage ?? safeStorage();
    this.capture = opts.capture ?? (() => captureLayoutState());
    this.apply = opts.apply ?? ((s) => applyLayoutState(s));
    this.notify = opts.notify;
    this.delay = opts.delay ?? 1000;
    this.retryDelay = opts.retryDelay ?? 5000;
    this.cache = readLayoutCache(this.storage);
  }

  get revision(): number | null {
    return this.saver?.revision ?? null;
  }

  get connected(): boolean {
    return !!this.saver;
  }

  /**
   * Load the last-used layout (creating "Untitled" when there is none) and
   * apply it. Unsynced local edits of the same layout are pushed instead, so
   * a stale base surfaces as a conflict. Resolves false when the API is
   * unreachable: the cached layout is applied and edits keep being cached.
   * `fromLocal`: id of a layout just made from this browser's state (the
   * migration): it is not re-applied, which would undo what the user did since.
   */
  start(opts: { fromLocal?: string | undefined } = {}): Promise<boolean> {
    // Connected already: reconnect attempts must not re-apply the server state.
    if (this.saver) return Promise.resolve(true);
    this.starting ??= this.doStart(opts.fromLocal).finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(fromLocal?: string): Promise<boolean> {
    try {
      return await this.startOnline(fromLocal);
    } catch (err) {
      if (!isTransient(err)) this.notify.error(`Layout could not be loaded: ${errorMessage(err)}`);
      await this.startOffline();
      return false;
    }
  }

  private async startOnline(fromLocal?: string): Promise<boolean> {
    let layout: Layout | null;
    try {
      layout = await this.api.getLastUsedLayout();
      if (!layout) {
        // A dirty offline cache becomes the first layout.
        const local = this.cache?.dirty ? this.cache.state : this.capture();
        const created = await this.api.createLayout({
          name: this.cache?.id === null ? this.cache.name : DEFAULT_LAYOUT_NAME,
          state: local,
          schemaVersion: LAYOUT_SCHEMA_VERSION,
        });
        await this.api.setLastUsedLayout(created.id);
        await this.open(created, local, created.revision, false);
        return true;
      }
    } catch (err) {
      if (!isTransient(err)) this.notify.error(`Layout could not be loaded: ${errorMessage(err)}`);
      await this.startOffline();
      return false;
    }
    const cache = this.cache;
    if (cache?.dirty && cache.id === null) {
      // Made offline before this browser ever reached the server: a layout of its
      // own, never written over the server's last-used one (another device's).
      const created = await this.api.createLayout({
        name: cache.name === DEFAULT_LAYOUT_NAME ? `${DEFAULT_LAYOUT_NAME} (offline)` : cache.name,
        state: cache.state,
        schemaVersion: LAYOUT_SCHEMA_VERSION,
      });
      await this.api.setLastUsedLayout(created.id);
      await this.open(created, cache.state, created.revision);
      return true;
    }
    if (cache?.dirty && cache.id !== null && cache.id !== layout.id) {
      // Unsaved changes of the layout this browser had open (another device may
      // have switched the last-used one meanwhile): reopen it to push them.
      try {
        layout = await this.api.getLayout(cache.id);
        await this.api.setLastUsedLayout(cache.id);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        this.keepOrphan(cache, false);
      }
    }
    const state = parseLayoutState(layout.state, layout.schemaVersion);
    // A keepalive save sent while the page closed may have landed after all.
    const landed = !!state && cache?.id === layout.id && stateKey(state) === stateKey(cache.state);
    if (cache?.dirty && !landed && (cache.id === null || cache.id === layout.id)) {
      // Local edits made while offline: push them on top of what we based them on.
      const base = cache.id === layout.id ? cache.revision : layout.revision;
      await this.open(layout, cache.state, base);
      this.markDirty(cache.state);
      return true;
    }
    if (!state) {
      this.notify.error(
        `Layout "${layout.name}" was saved by a newer version of the app and cannot be opened.`,
      );
      await this.startOffline();
      return false;
    }
    await this.open(layout, state, layout.revision, layout.id !== fromLocal);
    return true;
  }

  private async startOffline(): Promise<void> {
    const cache = this.cache;
    if (cache && !this.useStatusReady()) await this.withApplying(() => this.apply(cache.state));
    useLayoutStatus.setState({
      online: false,
      ready: true,
      current: cache ? { id: cache.id, name: cache.name } : { id: null, name: DEFAULT_LAYOUT_NAME },
      dirty: !!cache?.dirty,
    });
    this.lastKey = stateKey(this.capture());
  }

  /** Already restored once (reconnect attempts must not re-apply the cache). */
  private useStatusReady(): boolean {
    return useLayoutStatus.getState().ready;
  }

  private async withApplying(fn: () => Promise<void>): Promise<void> {
    this.applying++;
    try {
      await fn();
    } finally {
      this.applying--;
    }
  }

  /**
   * Make `layout` current showing `state`, autosaving on top of `revision`.
   * `apply` false: `state` was captured from this app moments ago; keep what
   * is shown (the user may have panned or zoomed since) and save the difference.
   */
  private async open(
    layout: LayoutSummary,
    state: LayoutState,
    revision: number,
    apply = true,
  ): Promise<void> {
    this.saver?.cancel();
    void this.saver?.dispose();
    this.orphaned = false;
    // Re-applying the state already shown would only reset what the user did meanwhile.
    if (apply && stateKey(state) !== stateKey(this.capture()))
      await this.withApplying(() => this.apply(state));
    const saver = createLayoutAutosaver<LayoutState>(
      { id: layout.id, revision },
      {
        delay: this.delay,
        retryDelay: this.retryDelay,
        schemaVersion: LAYOUT_SCHEMA_VERSION,
        save: this.api.saveLayout,
        onSaved: (saved) => this.onSaved(saver, saved),
        onError: (err) => this.onError(saver, err),
        onConflict: (err) => this.onConflict(saver, err),
        // Recovery copy for a page closed mid-save (the cache is read on next start).
        onHide: (value) => this.recover(value),
      },
    );
    this.saver = saver;
    const current = this.capture();
    this.lastKey = stateKey(current);
    this.settleUntil = this.now() + SETTLE_MS;
    this.writeCache({ id: layout.id, name: layout.name, revision, dirty: false, state: current });
    useLayoutStatus.setState({
      current: { id: layout.id, name: layout.name },
      online: true,
      dirty: false,
      saving: false,
      ready: true,
    });
    if (!apply && stateKey(state) !== this.lastKey) this.markDirty(current);
  }

  private writeCache(cache: LayoutCache): void {
    this.cache = cache;
    this.storage.set(LAYOUT_CACHE_KEY, JSON.stringify(cache));
  }

  /** The app state changed: cache it and schedule a save if it differs. */
  onChange(): void {
    if (this.applying || this.disposed || !useLayoutStatus.getState().ready) return;
    const state = this.capture();
    const key = stateKey(state);
    if (key === this.lastKey) return;
    const prev = this.lastKey;
    this.lastKey = key;
    // Moving focus between charts is not an edit: no dirty flag, no save of its own.
    if (prev !== null && focusKey(key) === focusKey(prev)) return;
    // Right after a layout was applied the chart settles (data loads, the view
    // clamps): view-only differences then are not the user's edits.
    if (this.now() < this.settleUntil && prev !== null && viewKey(key) === viewKey(prev)) return;
    this.markDirty(state);
  }

  private markDirty(state: LayoutState): void {
    const cur = useLayoutStatus.getState().current;
    this.writeCache({
      id: this.saver?.id ?? this.cache?.id ?? null,
      name: cur?.name ?? this.cache?.name ?? DEFAULT_LAYOUT_NAME,
      revision: this.saver?.revision ?? this.cache?.revision ?? 0,
      dirty: true,
      state,
    });
    useLayoutStatus.setState({ dirty: true });
    if (this.orphaned) this.storage.set(LAYOUT_ORPHAN_KEY, JSON.stringify(this.cache));
    else this.saver?.schedule(state);
  }

  private recover(state: LayoutState): void {
    if (!this.cache) return;
    this.writeCache({ ...this.cache, state, dirty: true });
  }

  private onSaved(saver: LayoutAutosaver<LayoutState>, saved: Layout<LayoutState>): void {
    if (saver !== this.saver || !this.cache) return;
    const dirty = saver.pending;
    this.writeCache({ ...this.cache, revision: saved.revision, dirty });
    useLayoutStatus.setState({ online: true, dirty, saving: false });
  }

  private onError(saver: LayoutAutosaver<LayoutState>, err: unknown): void {
    if (saver !== this.saver) return;
    if (isTransient(err)) {
      // The autosaver keeps the state and retries.
      useLayoutStatus.setState({ online: false });
      return;
    }
    saver.cancel();
    if (isNotFound(err)) {
      // Deleted on another device: stop saving, keep the state, offer a new layout.
      if (this.cache) this.keepOrphan({ ...this.cache, dirty: true }, true);
      return;
    }
    // Rejected (e.g. too large): retrying would fail the same way.
    this.notify.error(`Layout could not be saved: ${errorMessage(err)}`);
  }

  /**
   * Keep unsaved state of a layout the server no longer has (LAYOUT_ORPHAN_KEY)
   * and offer it once as a new layout. `current`: it is the open layout.
   */
  private keepOrphan(cache: LayoutCache, current: boolean): void {
    this.storage.set(LAYOUT_ORPHAN_KEY, JSON.stringify(cache));
    if (current) {
      if (this.orphaned) return;
      this.orphaned = true;
    }
    this.notify.conflict(
      current
        ? `Layout "${cache.name}" was deleted elsewhere; your changes are not saved.`
        : `Unsaved changes of layout "${cache.name}" could not be saved (it was deleted elsewhere).`,
      [{ label: 'Save as new layout', run: () => void this.restoreOrphan() }],
    );
  }

  /** Create a layout from the kept orphan state and switch to it. */
  async restoreOrphan(): Promise<void> {
    const raw = readJson<unknown>(this.storage.get(LAYOUT_ORPHAN_KEY));
    const name = isObj(raw) && typeof raw.name === 'string' ? raw.name : DEFAULT_LAYOUT_NAME;
    const state = isObj(raw) ? parseLayoutState(raw.state) : null;
    if (!state) return;
    try {
      const created = await this.api.createLayout({
        name: `${name} (restored)`,
        state,
        schemaVersion: LAYOUT_SCHEMA_VERSION,
      });
      await this.api.setLastUsedLayout(created.id);
      await this.open(created, state, created.revision);
      this.storage.remove(LAYOUT_ORPHAN_KEY);
    } catch (err) {
      this.notify.error(`Layout could not be created: ${errorMessage(err)}`);
    }
  }

  private onConflict(saver: LayoutAutosaver<LayoutState>, err: ApiError): void {
    if (saver !== this.saver) return;
    const server = persistence.layoutConflict<Record<string, unknown>>(err);
    const reload = async () => {
      if (saver !== this.saver) return;
      try {
        const latest = server ?? (await this.api.getLayout(saver.id));
        const state = parseLayoutState(latest.state, latest.schemaVersion);
        if (!state) throw new Error('saved by a newer version of the app');
        saver.cancel();
        saver.setRevision(latest.revision);
        await this.withApplying(() => this.apply(state));
        const current = this.capture();
        this.lastKey = stateKey(current);
        this.writeCache({
          id: saver.id,
          name: latest.name,
          revision: latest.revision,
          dirty: false,
          state: current,
        });
        useLayoutStatus.setState({
          dirty: false,
          current: { id: saver.id, name: latest.name },
        });
      } catch (e) {
        this.notify.error(`Layout could not be reloaded: ${errorMessage(e)}`);
      }
    };
    const overwrite = async () => {
      if (saver !== this.saver) return;
      try {
        const rev = server?.revision ?? (await this.api.getLayout(saver.id)).revision;
        saver.setRevision(rev);
        saver.schedule(this.capture());
        await saver.flush();
      } catch (e) {
        this.notify.error(`Layout could not be saved: ${errorMessage(e)}`);
      }
    };
    this.notify.conflict('This layout was changed in another tab or on another device.', [
      { label: 'Reload', run: () => void reload() },
      { label: 'Overwrite', run: () => void overwrite() },
    ]);
  }

  // ------------------------------------------------------------ menu operations

  private requireOnline(): LayoutAutosaver<LayoutState> {
    if (!this.saver) throw new Error('The server is unreachable; try again when it is back');
    return this.saver;
  }

  /** Save now (Ctrl+S). Resolves true when the server has the current state. */
  async save(): Promise<boolean> {
    const saver = this.requireOnline();
    this.onChange();
    await saver.flush();
    return !saver.pending;
  }

  /** Flush the current layout; false if its changes could not be saved. */
  private async settle(): Promise<boolean> {
    if (!this.saver) return !useLayoutStatus.getState().dirty;
    this.onChange();
    await this.saver.flush();
    return !this.saver.pending;
  }

  /** The current state under a new name, which becomes current. */
  async saveAs(name: string): Promise<void> {
    this.requireOnline();
    await this.settle();
    // Fresh chart ids: chart-bound drawings stay with the source layout.
    const state = rekeyChartIds(this.capture());
    const layout = await this.api.createLayout({
      name,
      state,
      schemaVersion: LAYOUT_SCHEMA_VERSION,
    });
    await this.api.setLastUsedLayout(layout.id);
    await this.open(layout, state, layout.revision);
  }

  async rename(name: string): Promise<void> {
    const saver = this.requireOnline();
    const out = await this.api.renameLayout(saver.id, name);
    if (this.cache) this.writeCache({ ...this.cache, name: out.name });
    useLayoutStatus.setState({ current: { id: saver.id, name: out.name } });
  }

  /** Copy the current layout (after saving it) and switch to the copy. */
  async copy(name: string): Promise<void> {
    this.requireOnline();
    await this.settle();
    // Fresh chart ids: chart-bound drawings stay with the source layout.
    const state = rekeyChartIds(this.capture());
    const layout = await this.api.createLayout({
      name,
      state,
      schemaVersion: LAYOUT_SCHEMA_VERSION,
    });
    await this.api.setLastUsedLayout(layout.id);
    await this.open(layout, state, layout.revision);
  }

  /**
   * Switch to layout `id`. With unsaved changes that could not be saved,
   * `confirmDiscard` decides whether to continue. Resolves false if not switched.
   */
  async load(
    id: string,
    confirmDiscard: () => Promise<boolean> = async () => true,
  ): Promise<boolean> {
    const saver = this.requireOnline();
    if (id === saver.id) return true;
    if (!(await this.settle()) && !(await confirmDiscard())) return false;
    const layout = await this.api.getLayout(id);
    const state = parseLayoutState(layout.state, layout.schemaVersion);
    if (!state) throw new Error('This layout was saved by a newer version of the app');
    // Edits made while the layout loaded belong to the old one: save them too.
    if (!(await this.settle()) && !(await confirmDiscard())) return false;
    await this.api.setLastUsedLayout(id);
    await this.open(layout, state, layout.revision);
    return true;
  }

  /** Delete layout `id`; deleting the current one switches to the newest other (or a new one). */
  async remove(id: string): Promise<void> {
    const saver = this.requireOnline();
    if (id !== saver.id) {
      await this.api.deleteLayout(id);
      return;
    }
    saver.cancel();
    await this.api.deleteLayout(id);
    const next = (await this.api.listLayouts()).find((l) => l.id !== id);
    if (next) {
      const layout = await this.api.getLayout(next.id);
      const state = parseLayoutState(layout.state, layout.schemaVersion) ?? this.capture();
      await this.api.setLastUsedLayout(layout.id);
      await this.open(layout, state, layout.revision);
      return;
    }
    const state = this.capture();
    const layout = await this.api.createLayout({
      name: DEFAULT_LAYOUT_NAME,
      state,
      schemaVersion: LAYOUT_SCHEMA_VERSION,
    });
    await this.api.setLastUsedLayout(layout.id);
    await this.open(layout, state, layout.revision);
  }

  list(): Promise<LayoutSummary[]> {
    return this.api.listLayouts();
  }

  /** Export file of the current layout (saved first). */
  async exportCurrent(): Promise<{ file: LayoutFile; name: string }> {
    const saver = this.requireOnline();
    await this.settle();
    const file = await this.api.exportLayout(saver.id);
    return { file, name: useLayoutStatus.getState().current?.name ?? 'layout' };
  }

  /** Create a layout from an export file and switch to it. */
  async importFile(file: LayoutFile, confirmDiscard?: () => Promise<boolean>): Promise<boolean> {
    this.requireOnline();
    const layout = await this.api.importLayout(file);
    return this.load(layout.id, confirmDiscard);
  }

  /** Unsaved changes that cannot reach the server right now. */
  hasUnsyncedChanges(): boolean {
    return useLayoutStatus.getState().dirty && (!this.saver || !useLayoutStatus.getState().online);
  }

  /** Stop without saving anything more (before an import replaces the server data). */
  async halt(): Promise<void> {
    this.disposed = true;
    this.saver?.cancel();
    await this.saver?.dispose();
    this.saver = null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.saver?.dispose();
    this.saver = null;
  }
}
