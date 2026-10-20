import { describe, expect, it, vi } from 'vitest';
import type { BarColumns, DataFeed, GetBarsRequest, GetBarsResult, UTCTimestamp } from '../types';
import { CoalescingFeed } from './coalescing-feed';
import { parseInterval } from './intervals';

const empty = (): BarColumns => ({
  time: new Float64Array(0),
  open: new Float64Array(0),
  high: new Float64Array(0),
  low: new Float64Array(0),
  close: new Float64Array(0),
  volume: new Float64Array(0),
});

function setup(opts?: { ttlMs?: number; maxEntries?: number }) {
  let t = 0;
  let fail = false;
  const getBars = vi.fn(async (_req: GetBarsRequest): Promise<GetBarsResult> => {
    await Promise.resolve();
    if (fail) throw new Error('boom');
    return { bars: empty(), hasMore: false };
  });
  const subscribe = vi.fn(() => () => undefined);
  const inner = { getBars, subscribe } as unknown as DataFeed;
  const feed = new CoalescingFeed(inner, { ...opts, now: () => t });
  const req = (symbol = 'AAPL', to?: number): GetBarsRequest => ({
    symbol,
    interval: parseInterval('1D'),
    limit: 100,
    ...(to === undefined ? {} : { to: to as UTCTimestamp }),
  });
  return {
    feed,
    getBars,
    subscribe,
    req,
    advance: (ms: number) => (t += ms),
    setFail: (v: boolean) => (fail = v),
  };
}

describe('CoalescingFeed', () => {
  it('shares one inner fetch between concurrent identical calls', async () => {
    const s = setup();
    const [a, b, c] = await Promise.all([
      s.feed.getBars(s.req()),
      s.feed.getBars(s.req()),
      s.feed.getBars(s.req()),
    ]);
    expect(s.getBars).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    await s.feed.getBars(s.req());
    expect(s.getBars).toHaveBeenCalledTimes(1);
  });

  it('treats different parameters as different requests', async () => {
    const s = setup();
    await s.feed.getBars(s.req('AAPL'));
    await s.feed.getBars(s.req('MSFT'));
    await s.feed.getBars(s.req('AAPL', 1000));
    expect(s.getBars).toHaveBeenCalledTimes(3);
  });

  it('refetches after the ttl expires', async () => {
    const s = setup({ ttlMs: 1000 });
    await s.feed.getBars(s.req());
    s.advance(999);
    await s.feed.getBars(s.req());
    expect(s.getBars).toHaveBeenCalledTimes(1);
    s.advance(2);
    await s.feed.getBars(s.req());
    expect(s.getBars).toHaveBeenCalledTimes(2);
  });

  it('treats absent and false adjusted/prepost as the same request', async () => {
    const s = setup();
    await s.feed.getBars(s.req());
    await s.feed.getBars({ ...s.req(), adjusted: false, prepost: false });
    expect(s.getBars).toHaveBeenCalledTimes(1);
    await s.feed.getBars({ ...s.req(), adjusted: true });
    expect(s.getBars).toHaveBeenCalledTimes(2);
  });

  it('reuses open-ended results only briefly, bounded requests for the full ttl', async () => {
    const s = setup({ ttlMs: 10_000 });
    await s.feed.getBars(s.req());
    await s.feed.getBars(s.req('AAPL', 1000));
    s.advance(1001);
    await s.feed.getBars(s.req());
    await s.feed.getBars(s.req('AAPL', 1000));
    expect(s.getBars).toHaveBeenCalledTimes(3); // only the open-ended one refetched
  });

  it('does not cache errors', async () => {
    const s = setup();
    s.setFail(true);
    await expect(s.feed.getBars(s.req())).rejects.toThrow('boom');
    s.setFail(false);
    await expect(s.feed.getBars(s.req())).resolves.toBeDefined();
    expect(s.getBars).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used entry', async () => {
    const s = setup({ maxEntries: 2 });
    await s.feed.getBars(s.req('A'));
    await s.feed.getBars(s.req('B'));
    await s.feed.getBars(s.req('A')); // A is now most recent
    await s.feed.getBars(s.req('C')); // evicts B
    expect(s.getBars).toHaveBeenCalledTimes(3);
    await s.feed.getBars(s.req('A'));
    expect(s.getBars).toHaveBeenCalledTimes(3);
    await s.feed.getBars(s.req('B'));
    expect(s.getBars).toHaveBeenCalledTimes(4);
  });

  it('passes subscribe through', () => {
    const s = setup();
    const req = { symbol: 'AAPL', interval: parseInterval('1D') };
    s.feed.subscribe(req, null, () => undefined);
    expect(s.subscribe).toHaveBeenCalledTimes(1);
  });
});
