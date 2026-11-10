import { ApiError, requestJson, type RequestOptions } from '../api/client';
import { hotlistPath, type HotlistKind, type HotlistResponse } from './kinds';

interface EtagEntry {
  etag: string;
  data: HotlistResponse;
}

const MAX_CACHED = 32;
/** Newest-last LRU of the last answer per request path, revalidated with `If-None-Match`. */
const cache = new Map<string, EtagEntry>();

/** Test hook: forget every cached ranking. */
export function clearHotlistCache(): void {
  cache.clear();
}

/**
 * `GET /api/screener/hotlists`: a ranking from the last close snapshot (database only). The answer
 * carries an ETag; the next request for the same ranking sends it and a 304 reuses the cached body
 * (same pattern as the screener scan). Any other non-OK answer is replayed through `requestJson`,
 * which owns the error mapping.
 */
export async function getHotlist(
  kind: HotlistKind,
  universe: string,
  opts: Pick<RequestOptions, 'signal'> = {},
): Promise<HotlistResponse> {
  const path = hotlistPath(kind, universe);
  const hit = cache.get(path);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (hit) headers['If-None-Match'] = hit.etag;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'GET',
      headers,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError('Network error: API unreachable', 0);
  }
  if (res.status === 304 && hit) return hit.data;
  if (!res.ok || res.status === 304)
    return requestJson<HotlistResponse>('GET', path, undefined, opts);
  const data = (await res.json()) as HotlistResponse;
  const etag = res.headers.get('ETag');
  if (etag) {
    cache.delete(path);
    cache.set(path, { etag, data });
    while (cache.size > MAX_CACHED) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  return data;
}
