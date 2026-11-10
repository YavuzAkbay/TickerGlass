/**
 * A small per-key cache for the symbol detail sections: one request per key and TTL
 * (concurrent callers share it), failures are never kept, least recently used keys go first.
 * `/fundamentals` and `/events` cost several upstream credits, so they are kept for hours.
 */

export interface TtlCache<T> {
  /** The value for `key`: cached, in flight, or freshly loaded. Rejections are not kept. */
  get(key: string): Promise<T>;
  /** The settled, unexpired value for `key`, if any (no request). */
  peek(key: string): T | undefined;
  clear(): void;
  readonly size: number;
}

interface Entry<T> {
  expires: number;
  promise: Promise<T>;
  settled: boolean;
  value?: T;
}

export interface TtlCacheOptions<T> {
  ttlMs: number;
  /** Most keys kept. */
  max: number;
  load: (key: string) => Promise<T>;
  /** Clock, for tests. */
  now?: () => number;
}

export function createTtlCache<T>(opts: TtlCacheOptions<T>): TtlCache<T> {
  const { ttlMs, max, load } = opts;
  const clock = opts.now ?? Date.now;
  const entries = new Map<string, Entry<T>>();

  const live = (key: string): Entry<T> | undefined => {
    const e = entries.get(key);
    if (!e) return undefined;
    if (e.expires <= clock()) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };

  return {
    get(key) {
      const hit = live(key);
      if (hit) {
        entries.delete(key); // re-insert: most recently used goes last
        entries.set(key, hit);
        return hit.promise;
      }
      const now = clock();
      for (const [k, e] of entries) if (e.expires <= now) entries.delete(k);
      while (entries.size >= max) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      const entry: Entry<T> = {
        expires: now + ttlMs,
        settled: false,
        promise: load(key).then(
          (value) => {
            entry.settled = true;
            entry.value = value;
            return value;
          },
          (err: unknown) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw err;
          },
        ),
      };
      entries.set(key, entry);
      return entry.promise;
    },
    peek(key) {
      const e = live(key);
      return e?.settled ? e.value : undefined;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
