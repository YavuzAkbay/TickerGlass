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

/** Columns for bars at `times` (seconds); prices encode `tag` so sources are distinguishable. */
function columns(times: number[], tag = 0): BarColumns {
  const col = (f: (t: number) => number) => Float64Array.from(times, f);
  return {
    time: Float64Array.from(times),
    open: col((t) => t + tag),
    high: col((t) => t + tag + 1),
    low: col((t) => t + tag - 1),
    close: col((t) => t + tag + 0.5),
    volume: col((t) => tag * 1000 + t),
  };
}

const MIN = 60;
const range = (from: number, count: number, step = MIN): number[] =>
  Array.from({ length: count }, (_, i) => from + i * step);

/**
 * Inner feed over a 1m series that the test can grow and revise. Each call returns
 * the last `limit` bars with values tagged by the series revision.
 */
function setupTail(opts?: { maxBars?: number; seriesMaxAgeMs?: number; hasMoreBefore?: boolean }) {
  const T0 = 1_700_000_000; // seconds, aligned to the minute
  let times = range(T0, 200);
  let tag = 0;
  let nowMs = (T0 + 199 * MIN) * 1000; // the last bar just opened
  let override: ((req: GetBarsRequest) => GetBarsResult) | null = null;
  const getBars = vi.fn(async (req: GetBarsRequest): Promise<GetBarsResult> => {
    await Promise.resolve();
    if (override) return override(req);
    const sel = times.slice(-req.limit);
    return {
      bars: columns(sel, tag),
      hasMore: (opts?.hasMoreBefore ?? true) || sel.length < times.length,
    };
  });
  const inner = { getBars, subscribe: vi.fn() } as unknown as DataFeed;
  const feed = new CoalescingFeed(inner, {
    tailRefresh: true,
    now: () => nowMs,
    ...(opts?.maxBars === undefined ? {} : { maxBars: opts.maxBars }),
    ...(opts?.seriesMaxAgeMs === undefined ? {} : { seriesMaxAgeMs: opts.seriesMaxAgeMs }),
  });
  const req = (limit = 100, symbol = 'AAPL'): GetBarsRequest => ({
    symbol,
    interval: parseInterval('1m'),
    limit,
  });
  return {
    feed,
    getBars,
    req,
    T0,
    /** Advance the clock and append the bars that closed meanwhile. */
    advanceMinutes(m: number) {
      const last = times[times.length - 1] ?? T0;
      times = [...times, ...range(last + MIN, m)];
      nowMs += m * MIN * 1000;
    },
    advanceMs: (ms: number) => (nowMs += ms),
    revise: (t: number) => (tag = t),
    setInner: (f: ((req: GetBarsRequest) => GetBarsResult) | null) => (override = f),
    times: () => times,
  };
}

describe('CoalescingFeed tail refresh', () => {
  it('fetches only a small tail for a reopened series and merges it', async () => {
    const s = setupTail();
    const first = await s.feed.getBars(s.req());
    expect(first.bars.time.length).toBe(100);
    s.advanceMinutes(2);
    s.revise(7);
    const res = await s.feed.getBars(s.req());
    expect(s.getBars).toHaveBeenCalledTimes(2);
    // 2 minutes elapsed: 2 new bars + 3 overlap.
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 5 });
    expect(s.getBars.mock.calls[1]?.[0]).not.toHaveProperty('to');
    const times = s.times();
    expect(Array.from(res.bars.time)).toEqual(times.slice(-100));
    // The last 5 bars come from the tail (revised), the rest from the cache.
    const n = res.bars.time.length;
    const tagOf = (i: number) => (res.bars.open[i] ?? NaN) - (res.bars.time[i] ?? NaN);
    expect(tagOf(n - 6)).toBe(0);
    for (let i = n - 5; i < n; i++) {
      expect(tagOf(i)).toBe(7);
      expect(res.bars.high[i]).toBe((res.bars.time[i] ?? 0) + 8);
      expect(res.bars.low[i]).toBe((res.bars.time[i] ?? 0) + 6);
      expect(res.bars.close[i]).toBe((res.bars.time[i] ?? 0) + 7.5);
      expect(res.bars.volume[i]).toBe(7000 + (res.bars.time[i] ?? 0));
    }
    expect(res.hasMore).toBe(true);
    // The first result was not touched.
    expect(Array.from(first.bars.time)).toEqual(times.slice(-102, -2));
    expect(first.bars.open[99]).toBe(first.bars.time[99]);
  });

  it('serves the exact request from the short cache before refreshing', async () => {
    const s = setupTail();
    const a = await s.feed.getBars(s.req());
    s.advanceMs(500);
    expect(await s.feed.getBars(s.req())).toBe(a);
    expect(s.getBars).toHaveBeenCalledTimes(1);
  });

  it('uses the cached series for a smaller request and caps the tail at its limit', async () => {
    const s = setupTail();
    await s.feed.getBars(s.req(100));
    s.advanceMinutes(30);
    const res = await s.feed.getBars(s.req(10));
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 10 });
    expect(Array.from(res.bars.time)).toEqual(s.times().slice(-10));
    expect(res.hasMore).toBe(true);
  });

  it('computes hasMore from the merged length when the cache had no older history', async () => {
    const s = setupTail({ hasMoreBefore: false });
    s.setInner((req) => {
      const sel = s.times().slice(-Math.min(req.limit, 4));
      return { bars: columns(sel), hasMore: false };
    });
    // A young symbol: only 4 bars exist.
    const first = await s.feed.getBars(s.req(5));
    expect(first.bars.time.length).toBe(4);
    expect(first.hasMore).toBe(false);
    s.advanceMinutes(3);
    s.setInner((req) => ({ bars: columns(s.times().slice(-req.limit)), hasMore: true }));
    const res = await s.feed.getBars(s.req(5));
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 5 });
    expect(res.bars.time.length).toBe(5);
    // 4 cached + 3 new = 7 bars merged, sliced to 5.
    expect(res.hasMore).toBe(true);
  });

  it('keeps hasMore false when everything fits', async () => {
    const s = setupTail();
    s.setInner(() => ({ bars: columns(range(s.T0, 3)), hasMore: false }));
    await s.feed.getBars(s.req(10));
    s.advanceMs(60_000);
    s.setInner((req) => ({
      bars: columns(range(s.T0 + MIN, Math.min(req.limit, 3))),
      hasMore: true,
    }));
    const res = await s.feed.getBars(s.req(10));
    expect(Array.from(res.bars.time)).toEqual(range(s.T0, 4));
    expect(res.hasMore).toBe(false);
  });

  it('falls back to a full fetch when the tail leaves a gap', async () => {
    const s = setupTail();
    await s.feed.getBars(s.req());
    s.advanceMinutes(2);
    const last = s.times()[s.times().length - 1] ?? 0;
    s.setInner((req) =>
      req.limit === 5
        ? { bars: columns(range(last + 10 * MIN, 5)), hasMore: true }
        : { bars: columns(s.times().slice(-req.limit), 9), hasMore: true },
    );
    const res = await s.feed.getBars(s.req());
    expect(s.getBars).toHaveBeenCalledTimes(3);
    expect(s.getBars.mock.calls[2]?.[0]).toMatchObject({ limit: 100 });
    expect(Array.from(res.bars.time)).toEqual(s.times().slice(-100));
    expect(res.bars.open[0]).toBe((res.bars.time[0] ?? 0) + 9);
  });

  it('fetches in full once the series is older than seriesMaxAgeMs', async () => {
    const s = setupTail({ seriesMaxAgeMs: 10 * 60_000 });
    await s.feed.getBars(s.req());
    s.advanceMinutes(5);
    await s.feed.getBars(s.req()); // tail merge keeps the full-fetch age
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 8 });
    s.advanceMinutes(5);
    await s.feed.getBars(s.req());
    expect(s.getBars.mock.calls[2]?.[0]).toMatchObject({ limit: 100 });
    s.advanceMinutes(1);
    await s.feed.getBars(s.req());
    expect(s.getBars.mock.calls[3]?.[0]).toMatchObject({ limit: 4 });
  });

  it('fetches in full when the cached series is too short for the request', async () => {
    const s = setupTail();
    await s.feed.getBars(s.req(50));
    s.advanceMinutes(1);
    const res = await s.feed.getBars(s.req(100));
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 100 });
    expect(res.bars.time.length).toBe(100);
  });

  it('keeps series apart by adjusted/prepost', async () => {
    const s = setupTail();
    await s.feed.getBars(s.req());
    s.advanceMinutes(1);
    await s.feed.getBars({ ...s.req(), adjusted: true });
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 100, adjusted: true });
  });

  it('does not cache a failed tail', async () => {
    const s = setupTail();
    await s.feed.getBars(s.req());
    s.advanceMinutes(1);
    s.setInner(() => {
      throw new Error('boom');
    });
    await expect(s.feed.getBars(s.req())).rejects.toThrow('boom');
    s.setInner(null);
    await expect(s.feed.getBars(s.req())).resolves.toBeDefined();
    expect(s.getBars.mock.calls[2]?.[0]).toMatchObject({ limit: 4 });
  });

  it('is off by default: open-ended requests refetch in full', async () => {
    const s = setup();
    await s.feed.getBars(s.req());
    s.advance(1001);
    await s.feed.getBars(s.req());
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 100 });
  });
});

describe('CoalescingFeed historical ttl and bar budget', () => {
  it('keeps bounded requests for historicalTtlMs', async () => {
    let t = 0;
    const getBars = vi.fn(async () => ({ bars: empty(), hasMore: true }));
    const feed = new CoalescingFeed({ getBars } as unknown as DataFeed, {
      historicalTtlMs: 300_000,
      now: () => t,
    });
    const req: GetBarsRequest = {
      symbol: 'AAPL',
      interval: parseInterval('1D'),
      limit: 10,
      to: 1000 as UTCTimestamp,
    };
    await feed.getBars(req);
    t = 299_999;
    await feed.getBars(req);
    expect(getBars).toHaveBeenCalledTimes(1);
    t = 300_000;
    await feed.getBars(req);
    expect(getBars).toHaveBeenCalledTimes(2);
  });

  it('evicts least recently used results beyond maxBars', async () => {
    const getBars = vi.fn(async (req: GetBarsRequest) => ({
      bars: columns(range(0, req.limit)),
      hasMore: true,
    }));
    const feed = new CoalescingFeed({ getBars } as unknown as DataFeed, {
      maxBars: 250,
    });
    const req = (symbol: string): GetBarsRequest => ({
      symbol,
      interval: parseInterval('1D'),
      limit: 100,
      to: 1000 as UTCTimestamp,
    });
    await feed.getBars(req('A'));
    await feed.getBars(req('B'));
    await feed.getBars(req('A')); // A is now most recent
    await feed.getBars(req('C')); // 300 bars: evicts B
    expect(getBars).toHaveBeenCalledTimes(3);
    await feed.getBars(req('A'));
    await feed.getBars(req('C'));
    expect(getBars).toHaveBeenCalledTimes(3);
    await feed.getBars(req('B'));
    expect(getBars).toHaveBeenCalledTimes(4);
  });

  it('counts a result shared by a request and its series once', async () => {
    const s = setupTail({ maxBars: 150 });
    await s.feed.getBars(s.req(100));
    s.advanceMinutes(1);
    // The series survived (100 bars counted once), so this is a tail fetch.
    await s.feed.getBars(s.req(100));
    expect(s.getBars.mock.calls[1]?.[0]).toMatchObject({ limit: 4 });
  });

  it('drops the series too when over budget', async () => {
    const s = setupTail({ maxBars: 150 });
    await s.feed.getBars(s.req(100, 'A'));
    await s.feed.getBars(s.req(100, 'B')); // evicts A's request and series
    s.advanceMinutes(1);
    await s.feed.getBars(s.req(100, 'A'));
    expect(s.getBars.mock.calls[2]?.[0]).toMatchObject({ symbol: 'A', limit: 100 });
  });
});

describe('CoalescingFeed search cache', () => {
  function setupSearch(searchCache = true) {
    let t = 0;
    let fail = false;
    const searchSymbols = vi.fn(async (q: string) => {
      await Promise.resolve();
      if (fail) throw new Error('down');
      return [{ symbol: q.toUpperCase(), name: q, exchange: null, type: null, typeDisplay: null }];
    });
    const feed = new CoalescingFeed({ searchSymbols } as unknown as DataFeed, {
      searchCache,
      now: () => t,
    });
    return {
      feed,
      searchSymbols,
      advance: (ms: number) => (t += ms),
      setFail: (v: boolean) => (fail = v),
    };
  }

  it('reuses results for 10 minutes and shares in-flight searches', async () => {
    const s = setupSearch();
    const [a, b] = await Promise.all([
      s.feed.searchSymbols('app', 5),
      s.feed.searchSymbols('app', 5),
    ]);
    expect(b).toBe(a);
    s.advance(599_999);
    expect(await s.feed.searchSymbols('app', 5)).toBe(a);
    expect(s.searchSymbols).toHaveBeenCalledTimes(1);
    await s.feed.searchSymbols('app', 10);
    expect(s.searchSymbols).toHaveBeenCalledTimes(2);
    s.advance(1);
    await s.feed.searchSymbols('app', 5);
    expect(s.searchSymbols).toHaveBeenCalledTimes(3);
  });

  it('does not cache failures', async () => {
    const s = setupSearch();
    s.setFail(true);
    await expect(s.feed.searchSymbols('app')).rejects.toThrow('down');
    s.setFail(false);
    await expect(s.feed.searchSymbols('app')).resolves.toHaveLength(1);
    expect(s.searchSymbols).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 100 queries', async () => {
    const s = setupSearch();
    for (let i = 0; i <= 100; i++) await s.feed.searchSymbols(`q${i}`);
    await s.feed.searchSymbols('q100');
    expect(s.searchSymbols).toHaveBeenCalledTimes(101);
    await s.feed.searchSymbols('q0'); // evicted
    expect(s.searchSymbols).toHaveBeenCalledTimes(102);
  });

  it('passes searches through when off', async () => {
    const s = setupSearch(false);
    await s.feed.searchSymbols('app');
    await s.feed.searchSymbols('app');
    expect(s.searchSymbols).toHaveBeenCalledTimes(2);
  });
});
