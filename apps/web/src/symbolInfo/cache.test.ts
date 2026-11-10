import { describe, expect, it, vi } from 'vitest';
import { createTtlCache } from './cache';

function make(opts: { ttlMs?: number; max?: number } = {}) {
  let time = 0;
  const load = vi.fn(async (key: string) => `v:${key}`);
  const cache = createTtlCache<string>({
    ttlMs: opts.ttlMs ?? 1000,
    max: opts.max ?? 3,
    load,
    now: () => time,
  });
  return { cache, load, advance: (ms: number) => (time += ms) };
}

describe('createTtlCache', () => {
  it('loads once per key while fresh and shares an in-flight request', async () => {
    const { cache, load } = make();
    const [a, b] = await Promise.all([cache.get('A'), cache.get('A')]);
    expect(a).toBe('v:A');
    expect(b).toBe('v:A');
    await cache.get('A');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('peeks only settled, unexpired values', async () => {
    const { cache, advance } = make();
    expect(cache.peek('A')).toBeUndefined();
    const p = cache.get('A');
    expect(cache.peek('A')).toBeUndefined(); // still in flight
    await p;
    expect(cache.peek('A')).toBe('v:A');
    advance(1000);
    expect(cache.peek('A')).toBeUndefined();
  });

  it('reloads after the ttl', async () => {
    const { cache, load, advance } = make({ ttlMs: 6 * 3600_000 });
    await cache.get('A');
    advance(6 * 3600_000 - 1);
    await cache.get('A');
    expect(load).toHaveBeenCalledTimes(1);
    advance(2);
    await cache.get('A');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not keep failures', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return 'ok';
    });
    const cache = createTtlCache<string>({ ttlMs: 1000, max: 3, load });
    await expect(cache.get('A')).rejects.toThrow('boom');
    expect(cache.size).toBe(0);
    fail = false;
    await expect(cache.get('A')).resolves.toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used key beyond max', async () => {
    const { cache, load } = make({ max: 2 });
    await cache.get('A');
    await cache.get('B');
    await cache.get('A'); // A is now the most recent
    await cache.get('C'); // evicts B
    expect(cache.size).toBe(2);
    await cache.get('A');
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get('B');
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('clear forgets everything', async () => {
    const { cache, load } = make();
    await cache.get('A');
    cache.clear();
    await cache.get('A');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
