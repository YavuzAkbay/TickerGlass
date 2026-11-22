import { describe, expect, it } from 'vitest';
import { canClaimLegacyCache, parseAuthState, type AuthState } from '../api/auth';
import {
  CACHE_USER_KEY,
  cacheOwner,
  clearUserCache,
  guardCache,
  ownerMatchesUser,
  type KeyValueStorage,
} from './cacheGuard';

function mem(init: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const cache = (owner?: string) =>
  mem({
    ...(owner ? { [CACHE_USER_KEY]: owner } : {}),
    'tickerglass-layout': '{}',
    'tickerglass-watchlists': '{}',
    'tickerglass-migration.local': '{}',
    'other-app-key': 'keep',
  });

describe('guardCache', () => {
  it('skips without a user id (unreachable or older API)', () => {
    const local = cache('u1');
    expect(guardCache(undefined, true, local, mem())).toBe('skipped');
    expect(guardCache(null, true, local, mem())).toBe('skipped');
    expect(local.data.size).toBe(5);
  });

  it('keeps the cache of the same user', () => {
    const local = cache('u1');
    expect(guardCache('u1', false, local, mem())).toBe('kept');
    expect(local.data.has('tickerglass-layout')).toBe(true);
  });

  it('clears every tickerglass-* key and the tg. session keys on another user, then claims it', () => {
    const local = cache('u1');
    const session = mem({ 'tg.oidcAutoRedirectAt': '1', 'x.keep': '1' });
    expect(guardCache('u2', true, local, session)).toBe('cleared');
    expect([...local.data.keys()].sort()).toEqual([CACHE_USER_KEY, 'other-app-key'].sort());
    expect(cacheOwner(local)).toBe('u2');
    expect([...session.data.keys()]).toEqual(['x.keep']);
  });

  it('legacy cache + owner (or open mode): claimed without clearing', () => {
    const local = cache();
    expect(guardCache('u1', true, local, mem())).toBe('adopted');
    expect(local.data.get('tickerglass-layout')).toBe('{}');
    expect(cacheOwner(local)).toBe('u1');
  });

  it('legacy cache + non-owner: cleared (local and session), then claimed by that user', () => {
    const local = cache();
    const session = mem({ 'tg.oidcAutoRedirectAt': '1', 'x.keep': '1' });
    expect(guardCache('u2', false, local, session)).toBe('cleared');
    expect([...local.data.keys()].sort()).toEqual([CACHE_USER_KEY, 'other-app-key'].sort());
    expect(cacheOwner(local)).toBe('u2');
    expect([...session.data.keys()]).toEqual(['x.keep']);
  });

  it('a mismatched owner is cleared even for the Owner account', () => {
    const local = cache('u1');
    expect(guardCache('owner', true, local, mem())).toBe('cleared');
    expect(local.data.has('tickerglass-layout')).toBe(false);
    expect(cacheOwner(local)).toBe('owner');
  });

  it('survives storage that throws', () => {
    const broken: KeyValueStorage = {
      length: 1,
      key: () => {
        throw new Error('blocked');
      },
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => guardCache('u1', true, broken, broken)).not.toThrow();
    expect(() => clearUserCache(broken, broken)).not.toThrow();
  });
});

describe('clearUserCache', () => {
  it('sign-out clears the data but can keep the owner id', () => {
    const local = cache('u1');
    clearUserCache(local, mem(), true);
    expect([...local.data.keys()].sort()).toEqual([CACHE_USER_KEY, 'other-app-key'].sort());
    clearUserCache(local, mem());
    expect([...local.data.keys()]).toEqual(['other-app-key']);
  });
});

describe('ownerMatchesUser', () => {
  it('matches unowned caches and the same user only; an unknown user never owns a cache', () => {
    expect(ownerMatchesUser('u1', null)).toBe(false);
    expect(ownerMatchesUser('u1', undefined)).toBe(false);
    expect(ownerMatchesUser(null, 'u1')).toBe(true);
    expect(ownerMatchesUser('u1', 'u1')).toBe(true);
    expect(ownerMatchesUser('u1', 'u2')).toBe(false);
  });

  it('an unowned cache needs canClaim', () => {
    expect(ownerMatchesUser(null, 'u1', true)).toBe(true);
    expect(ownerMatchesUser(null, 'u1', false)).toBe(false);
    expect(ownerMatchesUser('u1', 'u1', false)).toBe(true);
    // Unknown user: only an unowned cache that may be claimed (open mode), never otherwise.
    expect(ownerMatchesUser(null, null, true)).toBe(true);
    expect(ownerMatchesUser(null, null, false)).toBe(false);
  });
});

describe('canClaimLegacyCache', () => {
  const state = (over: Record<string, unknown>): AuthState =>
    parseAuthState({ enabled: true, authed: true, ...over });
  const user = (extra: object = {}) => ({ id: 'u1', name: 'Ada', ...extra });

  it('owner or open mode only; a missing isOwner fails closed when auth is on', () => {
    expect(canClaimLegacyCache(state({ user: user({ isOwner: true }) }))).toBe(true);
    expect(canClaimLegacyCache(state({ user: user({ isOwner: false }) }))).toBe(false);
    expect(canClaimLegacyCache(state({ user: user() }))).toBe(false);
    expect(canClaimLegacyCache(state({ enabled: false, user: null }))).toBe(true);
  });
});
