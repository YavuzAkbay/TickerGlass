/**
 * Watchlists and flags <-> `/watchlists` and `/flags`. Lists are whole-list
 * revision-checked like notes (conflict: show the saved copy, offer "Keep
 * mine"); flags are last-writer-wins. The zustand store keeps the offline copy
 * with dirty flags, queued deletes and unsent flags, pushed on (re)connect.
 */
import { createAutosaver, type Autosaver } from '../api/autosave';
import { ApiError, errorMessage } from '../api/client';
import * as persistence from '../api/persistence';
import { useAppStore } from '../store/app';
import { DEFAULT_LIST_NAME, useWatchlistStore } from '../watchlist/store';
import type { FlagColor, WatchlistEntry } from '../watchlist/types';
import { isTransient } from './net';

export type WatchlistsApi = Pick<
  typeof persistence,
  | 'listWatchlists'
  | 'createWatchlist'
  | 'updateWatchlist'
  | 'deleteWatchlist'
  | 'getFlags'
  | 'patchFlags'
>;

export interface WatchlistSyncOptions {
  api?: WatchlistsApi;
  delay?: number;
  retryDelay?: number;
  onError: (message: string) => void;
  /** Saving list `id` hit a newer server version, which is now shown; `restore` re-applies mine. */
  onConflict: (id: string, name: string, restore: () => void) => void;
}

function setEntry(entry: WatchlistEntry): void {
  useWatchlistStore.setState((s) => ({ lists: { ...s.lists, [entry.id]: entry } }));
}

const sig = (e: Pick<WatchlistEntry, 'name' | 'items'>): string =>
  JSON.stringify([e.name, e.items]);

export class WatchlistSync {
  private readonly api: WatchlistsApi;
  private readonly opts: WatchlistSyncOptions;
  private saver: Autosaver<void>;
  private off: (() => void) | null = null;
  private loaded = false;
  /** Content the server rejected (permanent error), by list id. */
  private rejected = new Map<string, string>();
  /** Flag values the server rejected, by symbol. */
  private rejectedFlags = new Map<string, FlagColor | null>();
  /**
   * Serializes `load()` and `flushOnce()`: a load never reads the server while
   * a save is in flight (its snapshot would predate the save), and vice versa.
   */
  private lock: Promise<void> = Promise.resolve();

  constructor(opts: WatchlistSyncOptions) {
    this.opts = opts;
    this.api = opts.api ?? persistence;
    this.saver = createAutosaver<void>(() => this.flushOnce(), {
      delay: opts.delay ?? 800,
      retryDelay: opts.retryDelay ?? 5000,
    });
  }

  private hasPending(): boolean {
    const s = useWatchlistStore.getState();
    return (
      s.pendingDeletes.length > 0 ||
      Object.keys(s.flagsDirty).length > 0 ||
      Object.values(s.lists).some((l) => l.dirty)
    );
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  start(): void {
    this.off = useWatchlistStore.subscribe((s, prev) => {
      if (!this.loaded) return;
      if (
        s.lists === prev.lists &&
        s.pendingDeletes === prev.pendingDeletes &&
        s.flagsDirty === prev.flagsDirty
      )
        return;
      if (this.hasPending()) this.saver.schedule();
    });
  }

  /** First run only: one list with the current symbol and the recent ones. */
  private seedIfEmpty(): void {
    const st = useWatchlistStore.getState();
    if (st.seeded) return;
    useWatchlistStore.setState({ seeded: true });
    if (Object.keys(st.lists).length) return;
    const { symbol, recentSymbols } = useAppStore.getState();
    const syms = [...new Set([symbol, ...recentSymbols])];
    useWatchlistStore.getState().createList(
      DEFAULT_LIST_NAME,
      syms.map((s) => ({ type: 'symbol' as const, symbol: s })),
    );
  }

  /**
   * Adopt the server's lists and flags; local edits are kept and pushed.
   * Throws if unreachable (after seeding the default list from an empty cache).
   */
  load(): Promise<void> {
    return this.exclusive(() => this.loadOnce());
  }

  private async loadOnce(): Promise<void> {
    let server: Awaited<ReturnType<WatchlistsApi['listWatchlists']>>;
    let flags: Awaited<ReturnType<WatchlistsApi['getFlags']>>;
    try {
      [server, flags] = await Promise.all([this.api.listWatchlists(), this.api.getFlags()]);
    } catch (err) {
      this.seedIfEmpty();
      throw err;
    }
    const st = useWatchlistStore.getState();
    const lists = { ...st.lists };
    const ids = new Set(server.map((w) => w.id));
    for (const w of server) {
      if (st.pendingDeletes.includes(w.id)) continue; // being deleted here
      const local = lists[w.id];
      if (local?.dirty) continue; // pushed with its base revision (or recreated/retried)
      // Never go back to an older revision than the one this client saved.
      if (local && local.revision !== null && local.revision > w.revision) continue;
      lists[w.id] = {
        id: w.id,
        name: w.name,
        items: w.items,
        revision: w.revision,
        dirty: false,
      };
    }
    for (const [id, local] of Object.entries(lists)) {
      if (ids.has(id) || local.revision === null) continue;
      // Deleted elsewhere: drop a clean copy, re-create an edited one.
      if (local.dirty) lists[id] = { ...local, revision: null };
      else delete lists[id];
    }
    const merged: Record<string, { color: FlagColor; at: string }> = {};
    for (const f of flags) merged[f.symbol] = { color: f.color, at: f.createdAt };
    for (const sym of Object.keys(st.flagsDirty)) {
      const mine = st.flags[sym];
      if (mine) merged[sym] = mine;
      else delete merged[sym];
    }
    useWatchlistStore.setState({ lists, flags: merged });
    this.seedIfEmpty();
    this.loaded = true;
    if (this.hasPending()) this.saver.schedule();
  }

  private flushOnce(): Promise<void> {
    return this.exclusive(() => this.flushAll());
  }

  private async flushAll(): Promise<void> {
    await this.flushDeletes();
    for (const id of Object.keys(useWatchlistStore.getState().lists)) {
      const entry = useWatchlistStore.getState().lists[id];
      if (entry?.dirty && this.rejected.get(id) !== sig(entry)) await this.pushList(entry);
    }
    await this.flushFlags();
  }

  private async flushDeletes(): Promise<void> {
    for (const id of [...useWatchlistStore.getState().pendingDeletes]) {
      try {
        await this.api.deleteWatchlist(id);
      } catch (err) {
        const notFound = err instanceof ApiError && err.status === 404;
        if (!notFound) {
          if (isTransient(err)) throw err;
          this.opts.onError(`Watchlist could not be deleted on the server: ${errorMessage(err)}`);
        }
      }
      useWatchlistStore.setState((s) => ({
        pendingDeletes: s.pendingDeletes.filter((x) => x !== id),
      }));
    }
  }

  private async pushList(entry: WatchlistEntry): Promise<void> {
    let revision = entry.revision;
    let creating = revision === null;
    let created = false; // did a create already run (409 there = it went through earlier)
    let saved: Awaited<ReturnType<WatchlistsApi['createWatchlist']>> | null = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      try {
        saved =
          creating || revision === null
            ? await this.api.createWatchlist({ id: entry.id, name: entry.name, items: entry.items })
            : await this.api.updateWatchlist(entry.id, {
                name: entry.name,
                items: entry.items,
                revision,
              });
      } catch (err) {
        const server = persistence.watchlistConflict(err);
        if (server && creating && !created) {
          // The earlier create went through (response lost): update on top of it.
          created = true;
          creating = false;
          revision = server.revision;
          continue;
        }
        if (server) {
          const mine = { name: entry.name, items: entry.items };
          setEntry({
            id: entry.id,
            name: server.name,
            items: server.items,
            revision: server.revision,
            dirty: false,
          });
          this.opts.onConflict(entry.id, entry.name, () =>
            setEntry({ id: entry.id, ...mine, revision: server.revision, dirty: true }),
          );
          return;
        }
        if (err instanceof ApiError && err.status === 404 && !creating) {
          // Deleted elsewhere: re-create it with its edits.
          setEntry({ ...(useWatchlistStore.getState().lists[entry.id] ?? entry), revision: null });
          creating = true;
          revision = null;
          continue;
        }
        if (isTransient(err)) throw err;
        this.rejected.set(entry.id, sig(entry));
        this.opts.onError(
          `Watchlist “${entry.name}” could not be saved: ${errorMessage(err)}. It is kept in this browser.`,
        );
        return;
      }
    }
    if (!saved) return;
    const now = useWatchlistStore.getState().lists[entry.id];
    if (!now) {
      // Deleted while the create was in flight: remove it from the server too.
      useWatchlistStore.setState((s) =>
        s.pendingDeletes.includes(entry.id)
          ? s
          : { pendingDeletes: [...s.pendingDeletes, entry.id] },
      );
      return;
    }
    // Edited while saving: stays dirty, based on the new revision.
    setEntry({ ...now, revision: saved.revision, dirty: sig(now) !== sig(entry) });
  }

  private async flushFlags(): Promise<void> {
    const st = useWatchlistStore.getState();
    const patch: Record<string, FlagColor | null> = {};
    for (const sym of Object.keys(st.flagsDirty)) {
      const value = st.flags[sym]?.color ?? null;
      if (this.rejectedFlags.has(sym) && this.rejectedFlags.get(sym) === value) continue;
      patch[sym] = value;
    }
    if (!Object.keys(patch).length) return;
    let result: Awaited<ReturnType<WatchlistsApi['patchFlags']>>;
    try {
      result = await this.api.patchFlags(patch);
    } catch (err) {
      if (isTransient(err)) throw err;
      for (const [sym, v] of Object.entries(patch)) this.rejectedFlags.set(sym, v);
      this.opts.onError(`Flags could not be saved: ${errorMessage(err)}`);
      return;
    }
    const now = useWatchlistStore.getState();
    const flagsDirty = { ...now.flagsDirty };
    for (const [sym, sent] of Object.entries(patch))
      if ((now.flags[sym]?.color ?? null) === sent) delete flagsDirty[sym];
    // Server state, overlaid with the flags still unsent (changed while saving).
    const flags: typeof now.flags = {};
    for (const f of result) flags[f.symbol] = { color: f.color, at: f.createdAt };
    for (const sym of Object.keys(flagsDirty)) {
      const mine = now.flags[sym];
      if (mine) flags[sym] = mine;
      else delete flags[sym];
    }
    useWatchlistStore.setState({ flags, flagsDirty });
  }

  flush(): Promise<void> {
    if (this.loaded && this.hasPending()) this.saver.schedule();
    return this.saver.flush();
  }

  /** Stop without sending anything more (before an import replaces the server data). */
  async halt(): Promise<void> {
    this.saver.cancel();
    await this.dispose();
  }

  async dispose(): Promise<void> {
    this.off?.();
    await this.saver.dispose();
  }
}
