import { getClassUniverse } from '../server/api';
import type { ScreenerClass, Universe } from './types';

export type { ScreenerClass, Universe, UniverseSymbol } from './types';
export { SCREENER_CLASSES, UNIVERSE_AS_OF } from './types';

const cache = new Map<ScreenerClass, Universe>();

/** Test hook: forget the cached universes. */
export function clearUniverseCache(): void {
  cache.clear();
}

/** A server answer worth using: the `Universe` shape, for this class. */
export function isUniverse(v: unknown, cls: ScreenerClass): v is Universe {
  if (typeof v !== 'object' || v === null) return false;
  const u = v as Partial<Universe>;
  return (
    u.cls === cls &&
    Array.isArray(u.symbols) &&
    u.symbols.length > 0 &&
    Array.isArray(u.groups) &&
    Array.isArray(u.exchanges) &&
    typeof u.groupLabel === 'string' &&
    u.symbols.every((s) => typeof s?.symbol === 'string' && typeof s.name === 'string')
  );
}

/** Drop `null` exchange / cap so consumers can use `?.`/`!== undefined`. */
export function normalizeUniverse(u: Universe): Universe {
  const symbols = u.symbols.map((s) => {
    const { exchange, cap, ...rest } = s as typeof s & {
      exchange?: string | null;
      cap?: number | null;
    };
    return {
      ...rest,
      ...(exchange ? { exchange } : {}),
      ...(typeof cap === 'number' && cap > 0 ? { cap } : {}),
    };
  });
  return { ...u, symbols };
}

/** The API could not supply a usable universe (unreachable, old backend, malformed answer). */
export class UniverseUnavailableError extends Error {
  constructor(
    readonly cls: ScreenerClass,
    options?: ErrorOptions,
  ) {
    super(`Universe unavailable for ${cls}`, options);
    this.name = 'UniverseUnavailableError';
  }
}

/**
 * The symbol universe of a class from `GET /api/screener/universe?cls=` (the server is the
 * single source of truth, shared with the server scan). Loaded universes stay cached for the
 * session. Rejects with `UniverseUnavailableError` when the API cannot answer; nothing is
 * cached then, so a retry asks again.
 */
export async function getUniverse(cls: ScreenerClass): Promise<Universe> {
  const hit = cache.get(cls);
  if (hit) return hit;
  let remote: unknown;
  try {
    remote = await getClassUniverse(cls);
  } catch (e) {
    throw new UniverseUnavailableError(cls, { cause: e });
  }
  if (!isUniverse(remote, cls)) throw new UniverseUnavailableError(cls);
  const universe = normalizeUniverse(remote);
  cache.set(cls, universe);
  return universe;
}
