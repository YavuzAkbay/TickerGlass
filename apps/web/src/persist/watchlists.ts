/**
 * Watchlists and flags <-> `/watchlists` and `/flags`. Lists are whole-list
 * revision-checked; a 409 is merged three-way at item level (base = the last
 * synced copy, kept in the entry) and only a true conflict shows the saved
 * copy and offers "Keep mine"; flags are last-writer-wins. The zustand store keeps the offline copy
 * with dirty flags, queued deletes and unsent flags, pushed on (re)connect.
 */
import { createAutosaver, type Autosaver } from '../api/autosave';
import { ApiError, bodyBytes, errorMessage, keepaliveBytesLeft } from '../api/client';
import * as persistence from '../api/persistence';
import { useAppStore } from '../store/app';
import { useChartView } from '../store/chartView';
import { useWatchlistPrefs } from '../watchlist/prefs';
import { DEFAULT_LIST_NAME, useWatchlistStore } from '../watchlist/store';
import type { PendingSeed } from '../watchlist/store';
import { mergeLists, sharedBase } from '../watchlist/merge';
import { STARTER_LISTS } from '../watchlist/starters';
import type { FlagColor, WatchlistEntry, WatchlistItem } from '../watchlist/types';
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
  /**
   * Saving list `id` hit a newer server version that could not be merged with
   * the local edits (`reasons` says why); the server's copy is now shown and
   * `restore` re-applies the local state as of the conflict.
   */
  onConflict: (id: string, name: string, restore: () => void, reasons: string[]) => void;
}

/** Request options for a save: `keepalive` lets it outlive a closing page. */
type SaveOpts = [] | [{ keepalive: true }];
const saveOpts = (keepalive: boolean): SaveOpts => (keepalive ? [{ keepalive: true }] : []);

/** Merge round trips per list and flush (each needs the server to change in between). */
const MAX_PUSH_ATTEMPTS = 5;

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
   * Serializes `load()` and normal flushes: a load never reads the server while
   * a save is in flight (its snapshot would predate the save), and vice versa.
   * Waiting flushes start before a waiting load, and at most one load waits:
   * `load()` while one is waiting returns that one, whose GET is sent later and
   * so is fresh enough. Keepalive (page hide) flushes bypass this: see
   * `flushKeepalive`.
   */
  private busy = false;
  private waiting: { kind: 'load' | 'flush'; start: () => void }[] = [];
  private queuedLoad: Promise<void> | null = null;
  /** Lists with a keepalive push in flight (count by id): normal flushes leave them be. */
  private keepalivePushes = new Map<string, number>();

  constructor(opts: WatchlistSyncOptions) {
    this.opts = opts;
    this.api = opts.api ?? persistence;
    // When the page is hidden the autosaver flushes with `keepalive` so the
    // save outlives the page, at once even while a save is in flight.
    this.saver = createAutosaver<void>((_v, ctx) => this.flushOnce(ctx.keepalive), {
      delay: opts.delay ?? 800,
      retryDelay: opts.retryDelay ?? 5000,
      overlapOnHide: true,
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

  private exclusive(kind: 'load' | 'flush', fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiting.push({
        kind,
        start: () => {
          this.busy = true;
          void Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              this.busy = false;
              this.next();
            });
        },
      });
      this.next();
    });
  }

  private next(): void {
    if (this.busy) return;
    const i = this.waiting.findIndex((t) => t.kind === 'flush');
    const [task] = this.waiting.splice(i === -1 ? 0 : i, 1);
    task?.start();
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

  /**
   * First run only: the default list with the current symbol and the recent
   * ones, plus the starter watchlists for beginners.
   *
   * Seeding is final only once a load succeeded. With the server unreachable
   * (`serverCount` null) the lists are created locally for the UX and remembered
   * in `pendingSeed`, but `seeded` stays false and nothing is pushed (pushes
   * start after a successful load). On the first successful load: if the
   * server already has lists (e.g. made by another browser), seeds the user
   * did not edit are dropped; if the server has none, they are pushed. Either
   * way `seeded` is then set, so lists deleted later are never re-seeded.
   */
  private seedIfEmpty(serverCount: number | null): void {
    const st = useWatchlistStore.getState();
    if (st.seeded) return;
    if (serverCount === null) {
      if (st.pendingSeed || Object.keys(st.lists).length) return;
      useWatchlistStore.setState({ pendingSeed: this.createSeed() });
      return;
    }
    const pending = st.pendingSeed;
    useWatchlistStore.setState({ seeded: true, pendingSeed: null });
    if (pending) {
      if (serverCount > 0) this.dropUntouchedSeeds(pending);
      return;
    }
    if (!Object.keys(st.lists).length) this.createSeed();
  }

  /** Untouched seeds are dropped: the server's lists come from another browser. */
  private dropUntouchedSeeds(pending: PendingSeed): void {
    const { lists } = useWatchlistStore.getState();
    const drop = pending.ids.filter((id) => {
      const seed = lists[id];
      return seed && seed.revision === null && sig(seed) === pending.sigs[id];
    });
    if (!drop.length) return;
    const keep = { ...lists };
    for (const id of drop) delete keep[id];
    useWatchlistStore.setState({ lists: keep });
    // The offline seed made the default list active; don't leave (and sync) a dead id.
    const prefs = useWatchlistPrefs.getState();
    if (prefs.activeId && drop.includes(prefs.activeId)) prefs.setActive(null);
  }

  private createSeed(): PendingSeed {
    const ids: string[] = [];
    const sigs: Record<string, string> = {};
    const seedOne = (name: string, items: WatchlistItem[]): void => {
      const id = useWatchlistStore.getState().createList(name, items);
      const entry = useWatchlistStore.getState().lists[id];
      if (!entry) return;
      ids.push(id);
      sigs[id] = sig(entry);
    };
    const { recentSymbols } = useAppStore.getState();
    const { symbol } = useChartView.getState();
    seedOne(
      DEFAULT_LIST_NAME,
      [...new Set([symbol, ...recentSymbols])].map((s) => ({ type: 'symbol' as const, symbol: s })),
    );
    for (const starter of STARTER_LISTS) seedOne(starter.name, starter.items);
    // First-run UX: open on the default list, not the alphabetically first starter.
    const prefs = useWatchlistPrefs.getState();
    if (!prefs.activeId && ids.length) prefs.setActive(ids[0]!);
    return { ids, sigs };
  }

  /**
   * Adopt the server's lists and flags; local edits are kept and pushed.
   * Throws if unreachable (after seeding the default list from an empty cache).
   */
  load(): Promise<void> {
    if (this.queuedLoad) return this.queuedLoad;
    const run = this.exclusive('load', () => {
      this.queuedLoad = null; // started: a later load() queues a new one
      return this.loadOnce();
    });
    this.queuedLoad = run;
    return run;
  }

  private async loadOnce(): Promise<void> {
    let server: Awaited<ReturnType<WatchlistsApi['listWatchlists']>>;
    let flags: Awaited<ReturnType<WatchlistsApi['getFlags']>>;
    try {
      [server, flags] = await Promise.all([this.api.listWatchlists(), this.api.getFlags()]);
    } catch (err) {
      this.seedIfEmpty(null);
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
        base: { name: w.name, items: w.items },
      };
    }
    for (const [id, local] of Object.entries(lists)) {
      if (ids.has(id) || local.revision === null) continue;
      // Deleted elsewhere: drop a clean copy, re-create an edited one.
      if (local.dirty) lists[id] = { ...local, revision: null, base: null };
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
    this.seedIfEmpty(server.length);
    this.loaded = true;
    if (this.hasPending()) this.saver.schedule();
  }

  private flushOnce(keepalive = false): Promise<void> {
    // The page may be closing: send now, not behind a save or load in flight.
    if (keepalive) return this.flushKeepalive();
    return this.exclusive('flush', () => this.flushAll());
  }

  private needsPush(entry: WatchlistEntry | undefined): entry is WatchlistEntry {
    return !!entry?.dirty && this.rejected.get(entry.id) !== sig(entry);
  }

  private async flushAll(): Promise<void> {
    for (const id of [...useWatchlistStore.getState().pendingDeletes])
      await this.deleteOne(id, false);
    for (const id of Object.keys(useWatchlistStore.getState().lists)) {
      const entry = useWatchlistStore.getState().lists[id];
      // A keepalive push of it is in flight; its result reschedules if still dirty.
      if (this.keepalivePushes.has(id)) continue;
      if (this.needsPush(entry)) await this.pushList(entry, false);
    }
    const patch = this.flagPatch();
    if (patch) await this.sendFlags(patch, false);
  }

  /**
   * Page closing: issue every request at once (the page may be gone before a
   * response), as keepalive and within the shared keepalive byte budget. What
   * does not fit stays in the store (and so in localStorage) and is retried
   * shortly if the page lives on, else on the next load. Responses that do
   * arrive are handled as usual.
   */
  private async flushKeepalive(): Promise<void> {
    let budget = keepaliveBytesLeft();
    let skipped = false;
    const fits = (bytes: number): boolean => {
      if (bytes < budget) {
        budget -= bytes;
        return true;
      }
      skipped = true;
      return false;
    };
    const sent: Promise<void>[] = [];
    const st = useWatchlistStore.getState();
    for (const id of st.pendingDeletes) if (fits(0)) sent.push(this.deleteOne(id, true));
    for (const entry of Object.values(st.lists)) {
      if (!this.needsPush(entry)) continue;
      const { id, name, items, revision } = entry;
      const body = revision === null ? { id, name, items } : { name, items, revision };
      if (fits(bodyBytes(body))) sent.push(this.pushKeepalive(entry));
    }
    const patch = this.flagPatch();
    if (patch && fits(bodyBytes(patch))) sent.push(this.sendFlags(patch, true));
    if (skipped) this.saver.schedule();
    const failed = (await Promise.allSettled(sent)).find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  private pushKeepalive(entry: WatchlistEntry): Promise<void> {
    const { id } = entry;
    this.keepalivePushes.set(id, (this.keepalivePushes.get(id) ?? 0) + 1);
    return this.pushList(entry, true).finally(() => {
      const left = (this.keepalivePushes.get(id) ?? 1) - 1;
      if (left > 0) this.keepalivePushes.set(id, left);
      else this.keepalivePushes.delete(id);
    });
  }

  private async deleteOne(id: string, keepalive: boolean): Promise<void> {
    try {
      await this.api.deleteWatchlist(id, ...saveOpts(keepalive));
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

  private async pushList(entry: WatchlistEntry, keepalive: boolean): Promise<void> {
    const o = saveOpts(keepalive);
    // What this push sends; replaced by the merged content after a clean 409 merge.
    let payload: { name: string; items: WatchlistItem[] } = {
      name: entry.name,
      items: entry.items,
    };
    let base = entry.base ?? null;
    let revision = entry.revision;
    let creating = revision === null;
    let created = false; // did a create already run (409 there = it went through earlier)
    let merges = 0;
    let saved: Awaited<ReturnType<WatchlistsApi['createWatchlist']>> | null = null;
    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS && !saved; attempt++) {
      try {
        saved =
          creating || revision === null
            ? await this.api.createWatchlist({ id: entry.id, ...payload }, ...o)
            : await this.api.updateWatchlist(entry.id, { ...payload, revision }, ...o);
      } catch (err) {
        const server = persistence.watchlistConflict(err);
        if (server && creating && !created) {
          // The earlier create went through (response lost): continue on top of it.
          created = true;
          creating = false;
          if (sig(server) === sig(payload)) {
            // Unchanged since: update on top of it; later server changes merge against it.
            base = payload;
            revision = server.revision;
            continue;
          }
          // Edited elsewhere since: merge like any other 409 (below). What that
          // create stored is unknown (it may predate edits made here since), so
          // merge against what both copies share: no side's additions are lost.
          base = sharedBase(payload, server);
        }
        // Deleted here meanwhile (its delete is queued): don't bring it back.
        const current = useWatchlistStore.getState().lists[entry.id];
        if (server) {
          if (!current) return;
          const theirs = { name: server.name, items: server.items };
          const mine = { name: current.name, items: current.items }; // incl. edits made while saving
          const merged = base
            ? mergeLists(base, mine, theirs)
            : { ok: false as const, reasons: ['No common version to merge with'] };
          if (merged.ok) {
            // Nothing clashes: keep both sides' changes and save on top of the server's version.
            merges++;
            base = theirs;
            revision = server.revision;
            payload = { name: merged.name, items: merged.items };
            setEntry({
              id: entry.id,
              ...payload,
              revision: server.revision,
              dirty: true,
              base: theirs,
            });
            continue;
          }
          setEntry({
            id: entry.id,
            ...theirs,
            revision: server.revision,
            dirty: false,
            base: theirs,
          });
          this.opts.onConflict(
            entry.id,
            mine.name,
            () =>
              setEntry({
                id: entry.id,
                ...mine,
                revision: server.revision,
                dirty: true,
                base: theirs,
              }),
            merged.reasons,
          );
          return;
        }
        if (err instanceof ApiError && err.status === 404 && !creating) {
          if (!current) return;
          // Deleted elsewhere: re-create it with its edits.
          setEntry({ ...current, revision: null, base: null });
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
    if (!saved) {
      // Kept losing the race against another writer: try again shortly.
      if (merges) this.saver.schedule();
      return;
    }
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
    // A push that overlapped this one (page hide) already stored a newer revision.
    if (now.revision !== null && now.revision > saved.revision) return;
    // Edited while saving: stays dirty, based on the new revision.
    setEntry({
      ...now,
      revision: saved.revision,
      dirty: sig(now) !== sig(payload),
      base: { name: saved.name, items: saved.items },
    });
  }

  /** The unsent flags (except values the server rejected), or null if none. */
  private flagPatch(): Record<string, FlagColor | null> | null {
    const st = useWatchlistStore.getState();
    const patch: Record<string, FlagColor | null> = {};
    for (const sym of Object.keys(st.flagsDirty)) {
      const value = st.flags[sym]?.color ?? null;
      if (this.rejectedFlags.has(sym) && this.rejectedFlags.get(sym) === value) continue;
      patch[sym] = value;
    }
    return Object.keys(patch).length ? patch : null;
  }

  private async sendFlags(
    patch: Record<string, FlagColor | null>,
    keepalive: boolean,
  ): Promise<void> {
    let result: Awaited<ReturnType<WatchlistsApi['patchFlags']>>;
    try {
      result = await this.api.patchFlags(patch, ...saveOpts(keepalive));
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

  /** Save what is pending now (`keepalive`: the page is closing, see `Autosaver`). */
  flush(keepalive = false): Promise<void> {
    if (this.loaded && this.hasPending()) this.saver.schedule();
    return this.saver.flush({ keepalive });
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
