/** Minimal typed client for the TickerGlass REST API (proxied at /api). */

export class ApiError extends Error {
  readonly status: number;
  /** Parsed JSON error body (`{ detail }`), when the server sent one. */
  readonly body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const BASE = '/api';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Browsers reject keepalive requests whose body exceeds 64 KB; stay below with a margin. */
export const KEEPALIVE_MAX_BYTES = 60_000;

/**
 * Worth retrying later: unreachable (status 0), server errors (5xx), request
 * timeout (408) and rate limiting (429). Other errors fail the same way again.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError)
    return err.status === 0 || err.status >= 500 || err.status === 408 || err.status === 429;
  return err instanceof TypeError;
}

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * Let the request outlive the page (saves on `pagehide`). Only honoured for
   * bodies under KEEPALIVE_MAX_BYTES: larger keepalive requests throw in browsers.
   */
  keepalive?: boolean;
  /** Query parameters; undefined values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

/**
 * `method` `/api{path}` with an optional JSON body; resolves to the JSON
 * response (undefined for 204). Throws ApiError with the server's `detail`
 * (and the parsed body in `body`) on non-OK, status 0 when unreachable.
 */
export async function requestJson<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Stringify once; the size decides whether keepalive is allowed.
  const text = body !== undefined ? JSON.stringify(body) : undefined;
  const keepalive =
    !!opts.keepalive && new TextEncoder().encode(text ?? '').length < KEEPALIVE_MAX_BYTES;
  try {
    res = await fetch(`${BASE}${withQuery(path, opts.query)}`, {
      method,
      headers,
      ...(text !== undefined ? { body: text } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(keepalive ? { keepalive: true } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`.trim();
    let parsed: unknown;
    try {
      parsed = await res.json();
      const d = (parsed as { detail?: unknown } | null)?.detail;
      if (typeof d === 'string') detail = d;
      else if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string')
        detail = (d as { message: string }).message;
      else if (d !== undefined) detail = JSON.stringify(d);
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new ApiError(detail, res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET `/api{path}` as JSON. Throws ApiError with the server's `detail` on non-OK. */
export function getJson<T>(path: string, init?: { signal?: AbortSignal }): Promise<T> {
  return requestJson<T>('GET', path, undefined, init?.signal ? { signal: init.signal } : {});
}

interface CacheEntry {
  expires: number;
  promise: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();

/** Upper bound on cached paths; the least recently used go first. */
export const MAX_ENTRIES = 300;

/** Test hook: forget every cached response. */
export function clearJsonCache(): void {
  cache.clear();
}

/** getJson with a short in-memory cache. Concurrent callers share one request;
 * failures are evicted immediately so the next call retries. The cache is an
 * LRU capped at MAX_ENTRIES, and expired entries are swept on insert. */
export function cachedJson<T>(path: string, ttlMs: number): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && hit.expires > now) {
    cache.delete(path); // re-insert: most recently used goes last
    cache.set(path, hit);
    return hit.promise as Promise<T>;
  }
  if (hit) cache.delete(path);
  for (const [k, e] of cache) if (e.expires <= now) cache.delete(k);
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  const promise = getJson<T>(path);
  const entry: CacheEntry = { expires: now + ttlMs, promise };
  cache.set(path, entry);
  promise.catch(() => {
    if (cache.get(path) === entry) cache.delete(path);
  });
  return promise;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
