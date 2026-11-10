import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestJson = vi.fn();
vi.mock('../api/client', () => ({
  requestJson: (...args: unknown[]) => requestJson(...args),
}));

import {
  BATCH_MS,
  CHUNK,
  MAX_ENTRIES,
  NEGATIVE_TTL_MS,
  PRIORITY_HEADER,
  TTL_MS,
  clearSparklines,
  peekSparkline,
  requestSparkline,
  watchSparkline,
} from './sparklines';

const reply = (symbols: string[], closes = [1, 2, 3]) =>
  Object.fromEntries(symbols.map((s) => [s, { closes, time: closes.map((_, i) => i) }]));

beforeEach(() => {
  vi.useFakeTimers();
  requestJson.mockReset();
  requestJson.mockImplementation(
    async (_m: string, _p: string, _b: unknown, o: { query: { symbols: string } }) =>
      reply(o.query.symbols.split(',')),
  );
});
afterEach(() => {
  clearSparklines();
  vi.useRealTimers();
});

describe('sparklines loader', () => {
  it('batches requests within the window into one low-priority call', async () => {
    const a = requestSparkline('aapl');
    const b = requestSparkline('MSFT');
    expect(requestJson).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await a).toEqual([1, 2, 3]);
    expect(await b).toEqual([1, 2, 3]);
    expect(requestJson).toHaveBeenCalledTimes(1);
    const [method, path, , opts] = requestJson.mock.calls[0]!;
    expect(method).toBe('GET');
    expect(path).toBe('/sparklines');
    expect(opts.query).toEqual({ symbols: 'AAPL,MSFT', limit: 30 });
    expect(opts.headers).toEqual({ [PRIORITY_HEADER]: 'background' });
  });

  it('dedupes in-flight requests and serves repeats from cache', async () => {
    const a = requestSparkline('AAPL');
    const b = requestSparkline('aapl');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await Promise.all([a, b]);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]![3].query.symbols).toBe('AAPL');
    expect(await requestSparkline('AAPL')).toEqual([1, 2, 3]);
    expect(peekSparkline('AAPL')).toEqual([1, 2, 3]);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('expires cached closes after the TTL', async () => {
    const first = requestSparkline('AAPL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await first;
    vi.setSystemTime(Date.now() + TTL_MS + 1);
    expect(peekSparkline('AAPL')).toBeUndefined();
    const again = requestSparkline('AAPL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await again;
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('chunks to 50 symbols and groups by limit', async () => {
    const symbols = Array.from({ length: CHUNK + 5 }, (_, i) => `S${i}`);
    const all = symbols.map((s) => requestSparkline(s));
    const other = requestSparkline('ZZZ', 60);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await Promise.all([...all, other]);
    const sizes = requestJson.mock.calls.map((c) => c[3].query.symbols.split(',').length);
    expect(sizes.sort((x, y) => y - x)).toEqual([CHUNK, 5, 1]);
    expect(requestJson.mock.calls.some((c) => c[3].query.limit === 60)).toBe(true);
  });

  it('resolves null for missing symbols and for failed calls, and retries after the short TTL', async () => {
    requestJson.mockResolvedValueOnce({ AAPL: { closes: [1, 2], time: [0, 1] }, NOPE: null });
    const a = requestSparkline('AAPL');
    const n = requestSparkline('NOPE');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await a).toEqual([1, 2]);
    expect(await n).toBeNull();

    requestJson.mockRejectedValueOnce(new Error('429'));
    const f = requestSparkline('FAIL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await f).toBeNull();
    expect(peekSparkline('FAIL')).toBeNull();
    vi.setSystemTime(Date.now() + NEGATIVE_TTL_MS + 1);
    expect(peekSparkline('FAIL')).toBeUndefined();
  });

  it('caps the cache (LRU)', async () => {
    requestJson.mockImplementation(
      async (_m: string, _p: string, _b: unknown, o: { query: { symbols: string } }) =>
        reply(o.query.symbols.split(',')),
    );
    for (let start = 0; start < MAX_ENTRIES + 60; start += CHUNK) {
      const ps = Array.from({ length: CHUNK }, (_, i) => requestSparkline(`X${start + i}`));
      await vi.advanceTimersByTimeAsync(BATCH_MS);
      await Promise.all(ps);
    }
    expect(peekSparkline('X0')).toBeUndefined();
    expect(peekSparkline(`X${MAX_ENTRIES + 59}`)).toEqual([1, 2, 3]);
  });
});

describe('watchSparkline', () => {
  it('retries a null answer after the short TTL until it succeeds', async () => {
    requestJson.mockRejectedValueOnce(new Error('429'));
    const seen: Array<number[] | null> = [];
    const stop = watchSparkline('AAPL', 30, (v) => seen.push(v));
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(seen).toEqual([null]);
    await vi.advanceTimersByTimeAsync(NEGATIVE_TTL_MS + BATCH_MS + 1);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([null, [1, 2, 3]]);
    stop();
  });

  it('refreshes positive data when the TTL expires', async () => {
    const seen: Array<number[] | null> = [];
    const stop = watchSparkline('AAPL', 30, (v) => seen.push(v));
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(seen).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TTL_MS - 1);
    expect(requestJson).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + BATCH_MS);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(seen).toHaveLength(2);
    stop();
  });

  it('stops retrying after cleanup', async () => {
    requestJson.mockRejectedValue(new Error('down'));
    const seen: Array<number[] | null> = [];
    const stop = watchSparkline('AAPL', 30, (v) => seen.push(v));
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    stop();
    await vi.advanceTimersByTimeAsync(NEGATIVE_TTL_MS * 3);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([null]);
  });
});
