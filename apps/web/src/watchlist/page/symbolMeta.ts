import { useSyncExternalStore } from 'react';
import type { SymbolMeta } from '../model';

/**
 * Company names for the page's Name column. Quotes don't carry names, so they
 * are resolved through the symbol-search API one symbol at a time (throttled,
 * visible rows first, whole lists on demand) and cached forever — names are static. Failed lookups
 * are remembered as a blank name so they never retry or refetch.
 */

const STORE_KEY = 'tickerglass-symbol-meta';
const MAX_CACHED = 2000;
/** Space between search requests, so a big list never hammers the endpoint. */
const THROTTLE_MS = 150;
/** Pending lookups beyond this are dropped; scrolling back re-requests them. */
const MAX_QUEUED = 200;

const BLANK: SymbolMeta = { name: '', exchange: null, type: null };

const cache = new Map<string, SymbolMeta>();
const failed = new Set<string>();
const queued = new Set<string>();
const listeners = new Set<() => void>();
let queue: string[] = [];
/** Whole-list wishes (name sort / filter) per owner; fed into `queue` only when it runs dry. */
const wanted = new Map<string, string[]>();
/** Bulk lookups that hit a network error; not retried until the wishes change. */
const netFailed = new Set<string>();
/** Symbols moved from the wishes into the queue per drain round. */
const BULK_BATCH = 20;
let drainTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

function load(): void {
  if (loaded || typeof localStorage === 'undefined') return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object')
      for (const [sym, meta] of Object.entries(parsed as Record<string, unknown>)) {
        if (
          meta &&
          typeof meta === 'object' &&
          typeof (meta as SymbolMeta).name === 'string' &&
          (meta as SymbolMeta).name
        )
          cache.set(sym, meta as SymbolMeta);
      }
  } catch {
    // A broken cache costs a re-fetch; ignore it.
  }
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      // Oldest entries first out once the cap is reached (Map keeps insertion order).
      const entries = [...cache.entries()];
      while (entries.length > MAX_CACHED) entries.shift();
      localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Quota errors are fine to ignore: the in-memory cache still works.
    }
  }, 1000);
}

const emit = () => listeners.forEach((l) => l());
let version = 0;

function resolve(symbol: string, meta: SymbolMeta | null): void {
  if (meta && meta.name) cache.set(symbol, meta);
  else failed.add(symbol);
  version++;
  emit();
  persist();
}

const isUnknown = (s: string) =>
  !cache.has(s) && !failed.has(s) && !queued.has(s) && !netFailed.has(s);

/** Visible-row lookups go first: wishes only refill an empty queue. */
function refillFromWanted(): void {
  if (queue.length) return;
  for (const list of wanted.values()) {
    for (const s of list) {
      if (queue.length >= BULK_BATCH) return;
      if (isUnknown(s)) {
        queued.add(s);
        queue.push(s);
      }
    }
  }
}

function wantedPending(): boolean {
  for (const list of wanted.values()) if (list.some(isUnknown)) return true;
  return false;
}

function scheduleDrain(): void {
  if (drainTimer === null)
    drainTimer = setTimeout(drain, THROTTLE_MS) as unknown as ReturnType<typeof setTimeout>;
}

function drain(): void {
  drainTimer = null;
  refillFromWanted();
  const symbol = queue.shift();
  if (!symbol) return;
  if (queue.length || wantedPending()) scheduleDrain();
  // Lazy: the feed module reads `location` at import, which non-browser importers lack.
  import('../../chart/feed')
    .then(({ feed }) => feed.searchSymbols(symbol, 5))
    .then((results) => {
      const hit =
        results.find((r) => r.symbol === symbol) ??
        results.find((r) => r.symbol.toUpperCase() === symbol.toUpperCase());
      resolve(symbol, hit ? { name: hit.name, exchange: hit.exchange, type: hit.type } : null);
    })
    .catch(() => {
      // Network hiccups are retryable — leave the symbol neither cached nor failed.
      queued.delete(symbol);
      netFailed.add(symbol);
    });
}

/** Start resolving `symbol` in the background (no-op when known or already queued). */
export function requestSymbolMeta(symbol: string): void {
  load();
  if (cache.has(symbol) || failed.has(symbol) || queued.has(symbol)) return;
  netFailed.delete(symbol);
  if (queue.length >= MAX_QUEUED) return;
  queued.add(symbol);
  queue.push(symbol);
  scheduleDrain();
}

/**
 * Resolve names for a whole list in the background (name sort, name filter).
 * `owner` keys the wish so several consumers coexist; `null` withdraws it.
 * Visible rows still resolve first, and the shared throttle applies.
 */
export function wantSymbolMetas(owner: string, symbols: readonly string[] | null): void {
  load();
  netFailed.clear();
  if (symbols === null) {
    wanted.delete(owner);
    return;
  }
  wanted.set(owner, [...new Set(symbols)]);
  if (wantedPending()) scheduleDrain();
}

/** Resolved metadata, or null while unknown/blank. Blank name = lookup failed. */
export function peekSymbolMeta(symbol: string): SymbolMeta | null {
  load();
  return cache.get(symbol) ?? null;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const getVersion = () => version;

/** Bumps on every resolve: lets a bulk reader (the table's name sort) re-render. */
export function useSymbolMetaVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/**
 * Subscribe one symbol's metadata. Also schedules the lookup; `enabled` lets
 * the Name column turn fetching off entirely.
 */
export function useSymbolMeta(symbol: string, enabled = true): SymbolMeta | null {
  const meta = useSyncExternalStore(
    subscribe,
    () => peekSymbolMeta(symbol) ?? BLANK,
    () => BLANK,
  );
  if (enabled && meta === BLANK) requestSymbolMeta(symbol);
  return meta.name ? meta : null;
}

/** Test hook: reset module state between tests. */
export function resetSymbolMetaForTests(): void {
  cache.clear();
  failed.clear();
  queued.clear();
  queue = [];
  wanted.clear();
  netFailed.clear();
  if (drainTimer) clearTimeout(drainTimer);
  if (saveTimer) clearTimeout(saveTimer);
  drainTimer = null;
  saveTimer = null;
}
