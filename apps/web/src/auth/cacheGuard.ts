/**
 * Browser cache guard (docs/design/multi-user.md, Web). localStorage holds an offline copy of
 * one user's data under `tickerglass-*` keys. When another user signs in on the same browser
 * (or the owner of the cache is unknown to differ), that copy must not be shown or synced into
 * the new account: it is cleared before any store hydrates.
 *
 * Pure over the storage objects so it runs before the app modules load (see main.tsx) and
 * is testable without a DOM.
 */

/** localStorage key holding the id of the user the cached data belongs to. */
export const CACHE_USER_KEY = 'tickerglass-user';
/** Every localStorage key of the app's cache starts with this. */
export const CACHE_PREFIX = 'tickerglass-';
/** sessionStorage keys of the app start with this. */
export const SESSION_PREFIX = 'tg.';

/** The part of `Storage` the guard needs. */
export interface KeyValueStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type GuardResult =
  /** No signed-in user id to compare with (unreachable or older API): nothing touched. */
  | 'skipped'
  /** The cache already belongs to this user. */
  | 'kept'
  /** A legacy cache (no owner yet) was claimed by the install's owner or in open mode, not cleared. */
  | 'adopted'
  /** The cache belonged to someone else, or was a legacy cache of a non-owner: cleared, then claimed. */
  | 'cleared';

const storageOrNull = (name: 'localStorage' | 'sessionStorage'): KeyValueStorage | null => {
  try {
    return globalThis[name] ?? null;
  } catch {
    return null; // access itself can throw when storage is blocked
  }
};

function removeByPrefix(storage: KeyValueStorage, prefix: string, keep?: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k !== null && k.startsWith(prefix) && k !== keep) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Storage that cannot be enumerated holds nothing we can clear.
  }
}

/**
 * Remove the cached user data: every `tickerglass-*` key of `local` and every `tg.` key of
 * `session`. `keepOwner` leaves the owner id in place (sign-out: the next sign-in still
 * learns whose cache, if any, is left over).
 */
export function clearUserCache(
  local: KeyValueStorage | null = storageOrNull('localStorage'),
  session: KeyValueStorage | null = storageOrNull('sessionStorage'),
  keepOwner = false,
): void {
  if (local) removeByPrefix(local, CACHE_PREFIX, keepOwner ? CACHE_USER_KEY : undefined);
  if (session) removeByPrefix(session, SESSION_PREFIX);
}

/** The user id the cache belongs to, or null (none recorded / unreadable). */
export function cacheOwner(
  local: KeyValueStorage | null = storageOrNull('localStorage'),
): string | null {
  try {
    return local?.getItem(CACHE_USER_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare the cache owner with the signed-in user and clear the cache on a mismatch.
 * A cache without an owner is the single-user data of an install that predates multi-user
 * (its one-time server import is still pending). Only `canClaim` (the user is the migrated
 * Owner, or auth is off so there is a single user) adopts it; anyone else on a shared browser
 * gets it cleared, so they never receive the owner's drawings, layouts or scripts.
 */
export function guardCache(
  userId: string | null | undefined,
  canClaim: boolean,
  local: KeyValueStorage | null = storageOrNull('localStorage'),
  session: KeyValueStorage | null = storageOrNull('sessionStorage'),
): GuardResult {
  if (!userId) return 'skipped';
  const owner = cacheOwner(local);
  let result: GuardResult = 'kept';
  if (owner === null && canClaim) result = 'adopted';
  else if (owner !== userId) {
    clearUserCache(local, session);
    result = 'cleared';
  }
  if (result !== 'kept') {
    try {
      local?.setItem(CACHE_USER_KEY, userId);
    } catch {
      // Blocked or full storage: the guard repeats on the next load.
    }
  }
  return result;
}

/**
 * Whether a cache owned by `owner` may be imported into the account of `userId` (the one-time
 * localStorage → server migration): it is theirs, or it is unowned and `canClaim` (owner
 * account or open mode). An unknown user (`/auth/state` failed, or an API without user ids)
 * matches only an unowned cache that may be claimed: a cache owned by someone cannot be shown
 * to belong to nobody, so it is left alone until a load that knows the user.
 */
export function ownerMatchesUser(
  owner: string | null,
  userId: string | null | undefined,
  canClaim = true,
): boolean {
  if (!userId) return owner === null && canClaim;
  return owner === userId || (owner === null && canClaim);
}
