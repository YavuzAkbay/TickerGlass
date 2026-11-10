import { useEffect, useState } from 'react';
import { requestJson } from '../api/client';

/**
 * Batched daily-close loader behind the watchlist/screener sparklines. Rows ask for one symbol
 * each; requests made within BATCH_MS go out as one `/sparklines` call (background priority on
 * the server), results are cached in memory and concurrent requests for a key share one promise.
 */

export const DEFAULT_LIMIT = 30;
/** Requests arriving within this window share one HTTP call. */
export const BATCH_MS = 50;
/** Server cap on symbols per call. */
export const CHUNK = 50;
export const TTL_MS = 10 * 60 * 1000;
/** A failed or empty answer is retried sooner: it is usually a rate limit or an outage. */
export const NEGATIVE_TTL_MS = 30 * 1000;
export const MAX_ENTRIES = 2000;
export const PRIORITY_HEADER = 'X-TickerGlass-Priority';

type Closes = number[] | null;
interface Entry {
  expires: number;
  value: Closes;
}
interface SparklinePayload {
  closes: number[];
  time: number[];
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Closes>>();
/** limit -> symbol -> resolvers waiting for the next flush. */
const queue = new Map<number, Map<string, Array<(v: Closes) => void>>>();
let timer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (symbol: string, limit: number) => `${symbol}|${limit}`;

/** Test hook: forget cached and queued state. */
export function clearSparklines(): void {
  cache.clear();
  inflight.clear();
  queue.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}

function remember(key: string, value: Closes): void {
  cache.delete(key);
  cache.set(key, { expires: Date.now() + (value ? TTL_MS : NEGATIVE_TTL_MS), value });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Cached closes for `symbol`, or undefined when nothing fresh is known (does not fetch). */
export function peekSparkline(symbol: string, limit = DEFAULT_LIMIT): Closes | undefined {
  const key = keyOf(symbol.toUpperCase(), limit);
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key); // most recently used goes last
  cache.set(key, hit);
  return hit.value;
}

async function fetchChunk(symbols: string[], limit: number): Promise<Map<string, Closes>> {
  const out = new Map<string, Closes>();
  try {
    const body = await requestJson<Record<string, SparklinePayload | null>>(
      'GET',
      '/sparklines',
      undefined,
      {
        query: { symbols: symbols.join(','), limit },
        headers: { [PRIORITY_HEADER]: 'background' },
      },
    );
    for (const s of symbols) {
      const closes = body?.[s]?.closes?.filter((v) => Number.isFinite(v));
      out.set(s, closes && closes.length > 0 ? closes : null);
    }
  } catch {
    for (const s of symbols) out.set(s, null);
  }
  return out;
}

function flush(): void {
  timer = null;
  const batches = [...queue];
  queue.clear();
  for (const [limit, bySymbol] of batches) {
    const symbols = [...bySymbol.keys()];
    for (let i = 0; i < symbols.length; i += CHUNK) {
      const chunk = symbols.slice(i, i + CHUNK);
      void fetchChunk(chunk, limit).then((results) => {
        for (const s of chunk) {
          const value = results.get(s) ?? null;
          remember(keyOf(s, limit), value);
          inflight.delete(keyOf(s, limit));
          for (const resolve of bySymbol.get(s) ?? []) resolve(value);
        }
      });
    }
  }
}

/**
 * Daily closes (oldest first) of `symbol`, or null when unavailable. Never rejects.
 * Cached for 10 min; calls within 50 ms are merged into one request.
 */
export function requestSparkline(symbol: string, limit = DEFAULT_LIMIT): Promise<Closes> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return Promise.resolve(null);
  const key = keyOf(sym, limit);
  const cached = peekSparkline(sym, limit);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = new Promise<Closes>((resolve) => {
    let bySymbol = queue.get(limit);
    if (!bySymbol) queue.set(limit, (bySymbol = new Map()));
    const waiters = bySymbol.get(sym);
    if (waiters) waiters.push(resolve);
    else bySymbol.set(sym, [resolve]);
    timer ??= setTimeout(flush, BATCH_MS);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * Keep `onValue` fed with the closes of `symbol`: loads now, then reloads once the cached answer
 * expires (a null answer after NEGATIVE_TTL_MS, closes after TTL_MS), so a row that stays mounted
 * recovers from a rate limit and never shows stale data. Returns the cleanup.
 */
export function watchSparkline(
  symbol: string,
  limit: number,
  onValue: (value: Closes) => void,
): () => void {
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const load = () => {
    timer = null;
    void requestSparkline(symbol, limit).then((value) => {
      if (!alive) return;
      onValue(value);
      timer = setTimeout(load, value ? TTL_MS : NEGATIVE_TTL_MS);
    });
  };
  load();
  return () => {
    alive = false;
    if (timer) clearTimeout(timer);
  };
}

export interface UseSparklineOptions {
  /** Skip fetching (offscreen, expression symbols). Default true. */
  enabled?: boolean;
  /** Daily sessions to load. Default 30. */
  limit?: number;
}

/** Closes for `symbol`: undefined while loading or disabled, null when unavailable. */
export function useSparkline(symbol: string, opts: UseSparklineOptions = {}): Closes | undefined {
  const { enabled = true, limit = DEFAULT_LIMIT } = opts;
  const active = enabled && symbol.length > 0;
  const key = keyOf(symbol.toUpperCase(), limit);
  const [res, setRes] = useState<{ key: string; value: Closes } | null>(null);

  useEffect(() => {
    if (!active) return;
    return watchSparkline(symbol, limit, (value) =>
      setRes((prev) => (prev && prev.key === key && prev.value === value ? prev : { key, value })),
    );
  }, [active, symbol, limit, key]);

  if (!active) return undefined;
  if (res && res.key === key) return res.value;
  return peekSparkline(symbol, limit);
}
