/**
 * Drawing store <-> API (docs/persistence.md §3, docs/drawings.md §6). The
 * store stays the source of truth for the UI and keeps its localStorage copy
 * (offline cache). Every store change marks the touched ids pending with the
 * server revision they are based on; a debounced flush sends one
 * `POST /drawings/batch`. On 409 the server copies of the conflicting ids are
 * adopted and the rest is retried.
 */
import type { Drawing } from '@investopen/engine';
import { createAutosaver, type Autosaver } from '../api/autosave';
import { errorMessage, isRetryable } from '../api/client';
import * as persistence from '../api/persistence';
import type { DrawingBatch, StoredDrawing } from '../api/types';
import { deepEqual } from '../drawings/model';
import {
  allDrawings,
  isRemoteApply,
  sanitizeDrawing,
  useDrawingStore,
  withRemoteApply,
  type DrawingBuckets,
} from '../drawings/store';
import { isObj, readJson, safeStorage, type SafeStorage } from './net';

export const DRAWING_SYNC_KEY = 'investopen-drawings-sync';
export const DRAWING_SCHEMA_VERSION = 1;

export type DrawingApi = Pick<typeof persistence, 'getDrawings' | 'batchDrawings'>;

/**
 * Base revision of a pending change: a number (the server revision it is
 * based on), null (created here, not on the server yet) or 'unknown' (a
 * drawing this tab never synced, e.g. one that arrived from another tab: its
 * revision is fetched before sending, so it is never mistaken for a create).
 */
export type BaseRevision = number | null | 'unknown';

/** Persisted next to the drawing cache (shared by all tabs). */
export interface DrawingSyncMeta {
  /** Server revision of each synced drawing. */
  revisions: Record<string, number>;
  /** Unsynced ids -> the revision the local change is based on. */
  pending: Record<string, BaseRevision>;
  /** Tab that owns each pending id (absent: a closed tab, claimed on start). */
  owners: Record<string, string>;
}

export interface DrawingSyncOptions {
  api?: DrawingApi;
  storage?: SafeStorage;
  /** `storage` events of other tabs (default `window`). */
  events?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  delay?: number;
  retryDelay?: number;
  onError: (message: string) => void;
  /** The API became reachable / unreachable. */
  onOnline?: (online: boolean) => void;
  /** Pending (unsynced) state changed. */
  onPending?: (pending: boolean) => void;
}

const isBase = (r: unknown): r is BaseRevision =>
  typeof r === 'number' || r === null || r === 'unknown';

export function parseSyncMeta(raw: unknown): DrawingSyncMeta {
  const meta: DrawingSyncMeta = { revisions: {}, pending: {}, owners: {} };
  if (!isObj(raw)) return meta;
  if (isObj(raw.revisions))
    for (const [id, r] of Object.entries(raw.revisions))
      if (typeof r === 'number') meta.revisions[id] = r;
  if (isObj(raw.pending))
    for (const [id, r] of Object.entries(raw.pending)) if (isBase(r)) meta.pending[id] = r;
  if (isObj(raw.owners))
    for (const [id, t] of Object.entries(raw.owners))
      if (typeof t === 'string' && id in meta.pending) meta.owners[id] = t;
  return meta;
}

export const readSyncMeta = (storage: SafeStorage): DrawingSyncMeta =>
  parseSyncMeta(readJson<unknown>(storage.get(DRAWING_SYNC_KEY)));

const byId = (s: DrawingBuckets) => new Map(allDrawings(s).map((d) => [d.id, d]));

let tabSeq = 0;

export class DrawingSync {
  private readonly api: DrawingApi;
  private readonly storage: SafeStorage;
  private readonly opts: DrawingSyncOptions;
  /** This tab's view: all revisions it knows, and its own pending ids. */
  readonly meta: { revisions: Record<string, number>; pending: Record<string, BaseRevision> };
  readonly tab = `t${Date.now().toString(36)}${(++tabSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  /** Bumped per local change of an id, to spot edits made while a batch was in flight. */
  private gen = new Map<string, number>();
  private saver: Autosaver<void>;
  private offs: (() => void)[] = [];
  /** Server reachable (a batch or fetch succeeded since the last failure). */
  private online: boolean | null = null;
  /** A pull succeeded: revisions are known, so sends can be based on them. */
  private pulled = false;
  private disposed = false;
  /** Pulls and batches run one at a time, so a pull never merges a stale snapshot. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: DrawingSyncOptions) {
    this.opts = opts;
    this.api = opts.api ?? persistence;
    this.storage = opts.storage ?? safeStorage();
    // Pending ids of every tab: a tab that closed with unsynced edits leaves
    // them here, and this tab sends them (a live tab sending them too only
    // costs a conflict that resolves to the same content).
    const stored = readSyncMeta(this.storage);
    this.meta = { revisions: stored.revisions, pending: stored.pending };
    this.saver = createAutosaver<void>(() => this.serial(() => this.doFlush()), {
      delay: opts.delay ?? 500,
      retryDelay: opts.retryDelay ?? 5000,
      // Only retryable errors reach the autosaver (doFlush handles the rest).
      onError: () => this.setOnline(false),
      // The store's own localStorage copy and the pending ids are the recovery copy.
      onHide: () => this.saveMeta(),
    });
  }

  /** Track store changes and other tabs. Call `pull()` afterwards to adopt the server's drawings. */
  start(): void {
    this.offs.push(useDrawingStore.subscribe((next, prev) => this.onStoreChange(next, prev)));
    const events = this.opts.events ?? (globalThis.window as DrawingSyncOptions['events']);
    if (events) {
      const onStorage = (e: Event) => {
        const { key, newValue } = e as StorageEvent;
        if (key === DRAWING_SYNC_KEY && newValue) this.mergeOtherTab(readJson(newValue));
      };
      events.addEventListener('storage', onStorage);
      this.offs.push(() => events.removeEventListener('storage', onStorage));
    }
  }

  /** Another tab saved its metadata: learn the revisions it got (newest wins). */
  mergeOtherTab(raw: unknown): void {
    const other = parseSyncMeta(raw);
    for (const [id, r] of Object.entries(other.revisions)) {
      if ((this.meta.revisions[id] ?? 0) < r) this.meta.revisions[id] = r;
      // My change to a drawing I only knew from that tab can now be based on it.
      if (this.meta.pending[id] === 'unknown') this.meta.pending[id] = r;
    }
  }

  get hasPending(): boolean {
    return Object.keys(this.meta.pending).length > 0;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.opts.onOnline?.(online);
  }

  /** Write my metadata, keeping the pending ids other live tabs own. */
  private saveMeta(): void {
    const stored = readSyncMeta(this.storage);
    const pending: Record<string, BaseRevision> = {};
    const owners: Record<string, string> = {};
    for (const [id, base] of Object.entries(stored.pending)) {
      const owner = stored.owners[id];
      if (owner && owner !== this.tab && !(id in this.meta.pending)) {
        pending[id] = base;
        owners[id] = owner;
      }
    }
    for (const [id, base] of Object.entries(this.meta.pending)) {
      pending[id] = base;
      owners[id] = this.tab;
    }
    this.storage.set(
      DRAWING_SYNC_KEY,
      JSON.stringify({ revisions: this.meta.revisions, pending, owners }),
    );
    this.opts.onPending?.(this.hasPending);
  }

  /** Pending in another live tab (it will send it). */
  private pendingElsewhere(id: string): boolean {
    const stored = readSyncMeta(this.storage);
    const owner = stored.owners[id];
    return id in stored.pending && !!owner && owner !== this.tab;
  }

  private markPending(id: string, existed: boolean): void {
    if (!(id in this.meta.pending)) {
      const known = this.meta.revisions[id];
      this.meta.pending[id] = known !== undefined ? known : existed ? 'unknown' : null;
    }
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1);
  }

  private onStoreChange(next: DrawingBuckets, prev: DrawingBuckets): void {
    if (this.disposed || isRemoteApply()) return;
    if (next.bySymbol === prev.bySymbol && next.synced === prev.synced) return;
    const before = byId(prev);
    const after = byId(next);
    let changed = false;
    for (const [id, d] of after)
      if (before.get(id) !== d) {
        this.markPending(id, before.has(id));
        changed = true;
      }
    for (const id of before.keys())
      if (!after.has(id)) {
        this.markPending(id, true);
        changed = true;
      }
    if (!changed) return;
    this.saveMeta();
    this.saver.schedule();
  }

  /** Build the batch for the pending ids (null when there is nothing to send). */
  buildBatch(): { batch: DrawingBatch<Drawing>; sent: Map<string, number> } | null {
    const local = byId(useDrawingStore.getState());
    const batch: Required<Pick<DrawingBatch<Drawing>, 'upserts' | 'deletes'>> = {
      upserts: [],
      deletes: [],
    };
    const sent = new Map<string, number>();
    let skipped = 0;
    for (const [id, base] of Object.entries(this.meta.pending)) {
      if (base === 'unknown') continue; // resolved by a pull first
      const d = local.get(id);
      if (d && d.scope !== 'all' && !d.symbol.trim()) {
        // The server rejects (422) symbol drawings without a symbol, and a batch is
        // all-or-nothing: keep it local only instead of blocking every other change.
        delete this.meta.pending[id];
        skipped++;
        continue;
      }
      if (d) batch.upserts.push({ drawing: d, baseRevision: base });
      else if (base !== null) batch.deletes.push({ id, baseRevision: base });
      else {
        // Created and removed here before it ever reached the server.
        delete this.meta.pending[id];
        continue;
      }
      sent.set(id, this.gen.get(id) ?? 0);
    }
    if (skipped)
      this.opts.onError(
        `${skipped} drawing${skipped === 1 ? ' has' : 's have'} no symbol and stay${skipped === 1 ? 's' : ''} in this browser only.`,
      );
    if (!sent.size) return null;
    return { batch: { ...batch, schemaVersion: DRAWING_SCHEMA_VERSION }, sent };
  }

  /** Send pending changes; conflicts are resolved and the rest re-sent. Throws only retryable errors. */
  private async doFlush(): Promise<void> {
    if (this.disposed) return;
    // Base revisions must be known: before the first pull every base would read
    // "new" (409 on existing drawings), and 'unknown' ones need the server's.
    if (!this.pulled || Object.values(this.meta.pending).includes('unknown')) {
      try {
        await this.doPull();
      } catch (err) {
        if (isRetryable(err)) throw err;
        this.opts.onError(`Drawings could not be loaded: ${errorMessage(err)}`);
        return;
      }
    }
    for (let round = 0; round < 5 && !this.disposed; round++) {
      const built = this.buildBatch();
      if (!built) {
        this.saveMeta();
        return;
      }
      try {
        const res = await this.api.batchDrawings<Drawing>(built.batch);
        for (const row of res.drawings) this.meta.revisions[row.id] = row.revision;
        for (const id of res.deleted) delete this.meta.revisions[id];
        this.settleSent(built.sent);
        this.setOnline(true);
        this.saveMeta();
        return;
      } catch (err) {
        const conflicts = persistence.drawingConflicts<Drawing>(err);
        if (conflicts) {
          this.setOnline(true);
          const changed = this.adoptServer(conflicts.map((c) => ({ id: c.id, row: c.drawing })));
          // Same content (e.g. another tab sent the same change): nothing to report.
          if (changed)
            this.opts.onError(
              `${changed} drawing${changed === 1 ? ' was' : 's were'} changed elsewhere; the saved version was loaded.`,
            );
          continue;
        }
        if (persistence.isConflict(err) || !isRetryable(err)) {
          // Rejected (e.g. too large): keep the drawings locally, stop resending them.
          for (const id of built.sent.keys()) delete this.meta.pending[id];
          this.saveMeta();
          this.opts.onError(`Drawings could not be saved: ${errorMessage(err)}`);
          return;
        }
        throw err;
      }
    }
  }

  /** Clear ids that were not edited again while their batch was in flight. */
  private settleSent(sent: Map<string, number>): void {
    for (const [id, g] of sent) {
      if ((this.gen.get(id) ?? 0) === g) delete this.meta.pending[id];
      // Edited again meanwhile: rebase the next send on the new revision.
      else this.meta.pending[id] = this.meta.revisions[id] ?? null;
    }
  }

  /**
   * Make the store hold the server's copy (null = deleted there) of these ids.
   * Returns how many differed from the local copy.
   */
  private adoptServer(rows: { id: string; row: StoredDrawing<Drawing> | null }[]): number {
    const local = byId(useDrawingStore.getState());
    const upserts: Drawing[] = [];
    const removes: string[] = [];
    let changed = 0;
    for (const { id, row } of rows) {
      delete this.meta.pending[id];
      const d = row ? sanitizeDrawing(row.data) : null;
      const cur = local.get(id);
      if (d && row) {
        this.meta.revisions[id] = row.revision;
        if (!cur || !deepEqual(cur, d)) {
          upserts.push(d);
          changed++;
        }
      } else {
        delete this.meta.revisions[id];
        if (cur) {
          removes.push(id);
          changed++;
        }
      }
    }
    if (upserts.length || removes.length)
      withRemoteApply(() => useDrawingStore.getState().apply(upserts, removes));
    return changed;
  }

  /**
   * Fetch the server's drawings (all, or `symbol`'s plus the synced ones) and
   * merge them into the store. Runs after any batch in flight. Local pending
   * edits win (they are sent with their base revision, so a stale base
   * becomes a conflict). Rows older than a revision already known are
   * ignored. Only drawings whose revision was known before the request are
   * removed when the server lacks them; never-synced ones are sent.
   * Throws when the API is unreachable.
   */
  pull(symbol?: string): Promise<void> {
    return this.serial(() => this.doPull(symbol));
  }

  private async doPull(symbol?: string): Promise<void> {
    const knownBefore = { ...this.meta.revisions };
    let rows: StoredDrawing<Drawing>[];
    try {
      rows = await this.api.getDrawings<Drawing>(symbol ? { symbol } : {});
    } catch (err) {
      this.setOnline(false);
      throw err;
    }
    this.setOnline(true);
    if (this.disposed) return;
    // Read the store after the response: edits made meanwhile are in it (and pending).
    const state = useDrawingStore.getState();
    const local = byId(state);
    const upserts: Drawing[] = [];
    const removes: string[] = [];
    const remote = new Set<string>();
    for (const row of rows) {
      remote.add(row.id);
      const known = this.meta.revisions[row.id];
      if (row.id in this.meta.pending) {
        if (this.meta.pending[row.id] === 'unknown') this.meta.pending[row.id] = row.revision;
        continue;
      }
      // Older than what this tab already saw (e.g. a batch landed after the read).
      if (known !== undefined && row.revision <= known) continue;
      const d = sanitizeDrawing(row.data);
      if (!d) continue;
      this.meta.revisions[row.id] = row.revision;
      const cur = local.get(row.id);
      if (!cur || !deepEqual(cur, d)) upserts.push(d);
    }
    const scope = symbol
      ? [...(state.bySymbol[symbol] ?? []), ...state.synced]
      : allDrawings(state);
    let push = false;
    for (const d of scope) {
      if (remote.has(d.id) || d.id in this.meta.pending) continue;
      const before = knownBefore[d.id];
      if (before !== undefined) {
        // Deleted on the server (unless a newer revision arrived meanwhile).
        if (this.meta.revisions[d.id] === before) {
          delete this.meta.revisions[d.id];
          removes.push(d.id);
        }
      } else if (this.meta.revisions[d.id] === undefined && !this.pendingElsewhere(d.id)) {
        // Never synced (e.g. an offline tab closed before sending): send it.
        this.markPending(d.id, false);
        push = true;
      }
    }
    // 'unknown' ids the server does not have: a create if it exists here, else nothing to do.
    if (!symbol)
      for (const [id, base] of Object.entries(this.meta.pending))
        if (base === 'unknown' && !remote.has(id)) {
          if (local.has(id)) this.meta.pending[id] = null;
          else delete this.meta.pending[id];
        }
    if (upserts.length || removes.length)
      withRemoteApply(() => useDrawingStore.getState().apply(upserts, removes));
    this.pulled = true;
    this.saveMeta();
    if (push || this.hasPending) this.saver.schedule();
  }

  /** Send pending changes now. */
  flush(): Promise<void> {
    if (this.hasPending) this.saver.schedule();
    return this.saver.flush();
  }

  /** Stop tracking changes; pending ones are sent once more (and kept for the next start). */
  async dispose(): Promise<void> {
    this.offs.forEach((off) => off());
    this.offs = [];
    this.saveMeta();
    await this.saver.dispose();
    this.disposed = true;
  }

  /** Stop without sending anything (before an import replaces the server data). */
  async halt(): Promise<void> {
    this.disposed = true;
    this.offs.forEach((off) => off());
    this.offs = [];
    this.saver.cancel();
    await this.saver.dispose();
  }
}
