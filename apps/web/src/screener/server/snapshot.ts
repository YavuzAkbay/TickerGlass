import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ApiError, requestJson } from '../../api/client';

/**
 * Batched loader of the server screener's nightly snapshot rows
 * (`GET /api/screener/snapshot?symbols=A,B`, docs/design/server-screener.md section 4), behind the
 * watchlist snapshot columns. Rows ask for one symbol each; requests made within BATCH_MS go out
 * together (at most CHUNK symbols per call), concurrent requests for a symbol share one promise.
 *
 * - A row stays cached while the response `asOf` it came with is still the newest one seen, for at
 *   most TTL_MS.
 * - Symbols the server omits (not tracked) are remembered as absent for NEGATIVE_TTL_MS.
 * - When the endpoint is missing (404/501) or the API is unreachable the feature is switched off for
 *   the session: no further requests, every answer is null (`snapshotsDisabled()`).
 * - Any other failure (5xx, 429) answers null for FAILURE_TTL_MS and is then retried.
 */

/** Frozen field ids of the screener (camelCase), see `GET /api/screener/fields`. */
export type FieldId = string;
export type SnapshotRow = Record<FieldId, number | string | boolean | null>;

/** Requests arriving within this window share one HTTP call. */
export const BATCH_MS = 50;
/** Server cap on symbols per call. */
export const CHUNK = 200;
export const TTL_MS = 30 * 60 * 1000;
/** Symbols the server does not track. */
export const NEGATIVE_TTL_MS = 30 * 60 * 1000;
/** A failed call (rate limit, outage) is retried sooner. */
export const FAILURE_TTL_MS = 30 * 1000;
export const MAX_ENTRIES = 3000;

interface Entry {
  expires: number;
  value: SnapshotRow | null;
  /** `asOf` of the response; null for failures. */
  asOf: string | null;
}
interface SnapshotPayload {
  asOf?: string | null;
  rows?: Record<string, SnapshotRow | null | undefined>;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<SnapshotRow | null>>();
const queue = new Map<string, Array<(v: SnapshotRow | null) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let disabled = false;
/** Newest `asOf` any response carried; rows of an older one are stale. */
let latestAsOf: string | null = null;

// ------------------------------------------------------------ change notification

let version = 0;
const listeners = new Set<() => void>();
const bump = () => {
  version++;
  for (const l of [...listeners]) l();
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Test hook: forget cached and queued state and re-enable the feature. */
export function clearSnapshots(): void {
  cache.clear();
  inflight.clear();
  queue.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  disabled = false;
  latestAsOf = null;
  bump();
}

/** True once the endpoint proved absent or unreachable (for the rest of the session). */
export const snapshotsDisabled = (): boolean => disabled;

function remember(symbol: string, value: SnapshotRow | null, asOf: string | null, ttl: number) {
  cache.delete(symbol);
  cache.set(symbol, { expires: Date.now() + ttl, value, asOf });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

const norm = (symbol: string) => symbol.trim().toUpperCase();

/** Cached row for `symbol`; undefined when nothing fresh is known (does not fetch), null = absent. */
export function peekSnapshot(symbol: string): SnapshotRow | null | undefined {
  const sym = norm(symbol);
  const hit = cache.get(sym);
  if (!hit) return undefined;
  const superseded = hit.asOf !== null && latestAsOf !== null && hit.asOf !== latestAsOf;
  if (hit.expires <= Date.now() || superseded) {
    cache.delete(sym);
    return undefined;
  }
  cache.delete(sym); // most recently used goes last
  cache.set(sym, hit);
  return hit.value;
}

/** Cached rows of `symbols` (absent and unknown ones left out); does not fetch. */
export function peekSnapshots(symbols: readonly string[]): Record<string, SnapshotRow> {
  const out: Record<string, SnapshotRow> = {};
  for (const s of symbols) {
    const row = peekSnapshot(s);
    if (row) out[norm(s)] = row;
  }
  return out;
}

/** 404 / 501 / unreachable: the endpoint will not appear during this session. */
const isAbsent = (e: unknown): boolean =>
  e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 0);

type Waiters = Map<string, Array<(v: SnapshotRow | null) => void>>;

/** Resolve the waiters of `symbols` with `answer(symbol)` and tell subscribers. */
function settle(
  symbols: string[],
  waiters: Waiters,
  answer: (s: string) => SnapshotRow | null,
): void {
  for (const s of symbols) {
    const value = answer(s);
    inflight.delete(s);
    for (const resolve of waiters.get(s) ?? []) resolve(value);
  }
  bump();
}

async function fetchChunk(symbols: string[], waiters: Waiters): Promise<void> {
  let body: SnapshotPayload | undefined;
  try {
    body = await requestJson<SnapshotPayload>('GET', '/screener/snapshot', undefined, {
      query: { symbols: symbols.join(',') },
    });
  } catch (e) {
    if (isAbsent(e)) disabled = true;
    else for (const s of symbols) remember(s, null, null, FAILURE_TTL_MS);
    settle(symbols, waiters, () => null);
    return;
  }
  const asOf = typeof body?.asOf === 'string' ? body.asOf : null;
  const rows = body?.rows ?? {};
  if (asOf !== null) latestAsOf = asOf;
  settle(symbols, waiters, (s) => {
    const row = rows[s];
    const value = row && typeof row === 'object' ? row : null;
    remember(s, value, asOf, value ? TTL_MS : NEGATIVE_TTL_MS);
    return value;
  });
}

function flush(): void {
  timer = null;
  const waiters = new Map(queue);
  queue.clear();
  const symbols = [...waiters.keys()];
  if (disabled) {
    settle(symbols, waiters, () => null);
    return;
  }
  for (let i = 0; i < symbols.length; i += CHUNK) {
    void fetchChunk(symbols.slice(i, i + CHUNK), waiters);
  }
}

/**
 * Snapshot row of `symbol`, or null when the server has none (untracked, no data, feature off).
 * Never rejects. Cached; calls within 50 ms are merged into one request of up to 200 symbols.
 */
export function requestSnapshot(symbol: string): Promise<SnapshotRow | null> {
  const sym = norm(symbol);
  if (!sym || disabled) return Promise.resolve(null);
  const cached = peekSnapshot(sym);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(sym);
  if (pending) return pending;
  const promise = new Promise<SnapshotRow | null>((resolve) => {
    queue.set(sym, [resolve]);
    timer ??= setTimeout(flush, BATCH_MS);
  });
  inflight.set(sym, promise);
  return promise;
}

// ------------------------------------------------------------ hooks

export interface UseSnapshotOptions {
  /** Skip fetching (no snapshot column visible, offscreen). Default true. */
  enabled?: boolean;
}

/** True when the feature is switched off for the session (re-renders when that happens). */
export function useSnapshotsDisabled(): boolean {
  return useSyncExternalStore(subscribe, snapshotsDisabled, snapshotsDisabled);
}

/**
 * Snapshot rows of `symbols` by upper-case symbol; symbols without a row (loading, untracked, feature
 * off) are missing. Nothing is requested while `enabled` is false. Rows are reloaded once their
 * cache entry expires while the hook stays mounted.
 */
export function useSnapshots(
  symbols: readonly string[],
  opts: UseSnapshotOptions = {},
): Record<string, SnapshotRow | undefined> {
  const { enabled = true } = opts;
  const v = useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
  const [renew, setRenew] = useState(0);
  const active = enabled && symbols.length > 0;

  useEffect(() => {
    if (!active) return;
    for (const s of symbols) void requestSnapshot(s);
    const t = setTimeout(() => setRenew((n) => n + 1), TTL_MS + 1000);
    return () => clearTimeout(t);
  }, [active, symbols, renew]);

  return useMemo(
    () => (active ? peekSnapshots(symbols) : EMPTY),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `v` tracks cache changes
    [active, symbols, v, renew],
  );
}

const EMPTY: Record<string, SnapshotRow | undefined> = {};

/** Snapshot row of one symbol: undefined while loading, disabled or absent. */
export function useSnapshot(
  symbol: string,
  opts: UseSnapshotOptions = {},
): SnapshotRow | undefined {
  const list = useMemo(() => (symbol ? [symbol] : []), [symbol]);
  return useSnapshots(list, opts)[norm(symbol)];
}
