/**
 * User scripts <-> `/user-scripts*` (docs/plans/user-scripts.md section 5).
 * The server is the source of truth; localStorage holds a read-only copy that
 * is shown while the API is down. Mutations are explicit (save, delete) and
 * need the API, like alerts: no offline queue. A stale save rejects with
 * `UserScriptConflict` carrying the stored script, so the caller can offer
 * "Reload" (adopt it) or "Overwrite" (`save(..., { overwrite: true })`).
 */
import * as persistence from '../api/persistence';
import { ApiError } from '../api/client';
import type { UserScript, UserScriptIn } from '../api/types';
import { useScriptsStore } from '../scripts/store';
import { isObj, readJson, safeStorage, type SafeStorage } from './net';

export const USER_SCRIPTS_CACHE_KEY = 'investopen-user-scripts';

export type UserScriptsApi = Pick<
  typeof persistence,
  'listUserScripts' | 'createUserScript' | 'updateUserScript' | 'deleteUserScript'
>;

export interface UserScriptsOptions {
  api?: UserScriptsApi;
  storage?: SafeStorage;
}

/** The script changed elsewhere (or the id is taken); `current` is the stored version. */
export class UserScriptConflict extends Error {
  constructor(readonly current: UserScript) {
    super(`Script "${current.name}" was changed elsewhere`);
    this.name = 'UserScriptConflict';
  }
}

const isScript = (v: unknown): v is UserScript =>
  isObj(v) &&
  typeof v.id === 'string' &&
  typeof v.name === 'string' &&
  typeof v.source === 'string' &&
  (v.manifest === null || isObj(v.manifest)) &&
  typeof v.apiVersion === 'number' &&
  typeof v.revision === 'number';

export class UserScriptsSync {
  private readonly api: UserScriptsApi;
  private readonly storage: SafeStorage;

  constructor(opts: UserScriptsOptions = {}) {
    this.api = opts.api ?? persistence;
    this.storage = opts.storage ?? safeStorage();
  }

  /**
   * Show the offline copy and mark the store loaded. With no (readable) copy
   * nothing is shown and the store stays unloaded: restored script instances
   * must not read "Script deleted" before the first API load answers
   * (`load` sets it, or `settle` when the API cannot be reached).
   */
  loadCache(): void {
    const raw = readJson<unknown>(this.storage.get(USER_SCRIPTS_CACHE_KEY));
    if (Array.isArray(raw)) useScriptsStore.getState().setScripts(raw.filter(isScript));
  }

  /** No more scripts are coming (API unreachable, no offline copy): let missing scripts show as such. */
  settle(): void {
    const { loaded, setScripts, scripts } = useScriptsStore.getState();
    if (!loaded) setScripts(scripts);
  }

  /** Adopt the server's scripts and refresh the offline copy. Throws if unreachable (the cached copy stays). */
  async load(): Promise<void> {
    let scripts: UserScript[];
    try {
      scripts = await this.api.listUserScripts();
    } catch (err) {
      this.settle();
      throw err;
    }
    useScriptsStore.getState().setScripts(scripts);
    this.writeCache();
  }

  /**
   * Create (unknown id) or update (with the stored revision) a script. Throws
   * `UserScriptConflict` on a stale revision or a taken id, unless `overwrite`
   * (then the update carries no revision). Other errors (offline: transient
   * ApiError) propagate; nothing is queued.
   */
  async save(
    id: string,
    input: UserScriptIn,
    opts: { overwrite?: boolean } = {},
  ): Promise<UserScript> {
    const known = useScriptsStore.getState().scripts.find((s) => s.id === id);
    let saved: UserScript;
    try {
      saved =
        known || opts.overwrite
          ? await this.api.updateUserScript(id, {
              ...input,
              ...(opts.overwrite ? {} : { revision: known!.revision }),
            })
          : await this.api.createUserScript({ id, ...input });
    } catch (err) {
      const current = err instanceof ApiError ? persistence.userScriptConflict(err) : null;
      if (current) throw new UserScriptConflict(current);
      throw err;
    }
    useScriptsStore.getState().upsert(saved);
    this.writeCache();
    return saved;
  }

  /** Delete on the server, then locally. A script already gone (404) counts as deleted. */
  async delete(id: string): Promise<void> {
    try {
      await this.api.deleteUserScript(id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    useScriptsStore.getState().remove(id);
    this.writeCache();
  }

  /** Adopt a conflict's stored version into the store ("Reload"). */
  adopt(current: UserScript): void {
    useScriptsStore.getState().upsert(current);
    this.writeCache();
  }

  private writeCache(): void {
    this.storage.set(USER_SCRIPTS_CACHE_KEY, JSON.stringify(useScriptsStore.getState().scripts));
  }
}
