/** Minimal typed client for the InvestOpen REST API (proxied at /api). */

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const BASE = '/api';

/** GET `/api{path}` as JSON. Throws ApiError with the server's `detail` on non-OK. */
export async function getJson<T>(path: string, init?: { signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json' },
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
      else if (body.detail !== undefined) detail = JSON.stringify(body.detail);
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new ApiError(detail, res.status);
  }
  return (await res.json()) as T;
}

interface CacheEntry {
  expires: number;
  promise: Promise<unknown>;
}

const cache = new Map<string, CacheEntry>();

/** getJson with a short in-memory cache. Concurrent callers share one request;
 * failures are evicted immediately so the next call retries. */
export function cachedJson<T>(path: string, ttlMs: number): Promise<T> {
  const now = Date.now();
  const hit = cache.get(path);
  if (hit && hit.expires > now) return hit.promise as Promise<T>;
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
