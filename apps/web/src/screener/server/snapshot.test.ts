import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestJson = vi.fn();
vi.mock('../../api/client', async (orig) => ({
  ...(await orig<typeof import('../../api/client')>()),
  requestJson: (...args: unknown[]) => requestJson(...args),
}));

import { ApiError } from '../../api/client';
import {
  BATCH_MS,
  CHUNK,
  FAILURE_TTL_MS,
  NEGATIVE_TTL_MS,
  TTL_MS,
  clearSnapshots,
  peekSnapshot,
  peekSnapshots,
  requestSnapshot,
  snapshotsDisabled,
} from './snapshot';

const row = (n: number) => ({ last: n, rsi14: 50, nextEarnings: null });
/** Server answer: every symbol but those in `omit`. */
const answer =
  (asOf: string, omit: string[] = []) =>
  async (_m: string, _p: string, _b: unknown, o: { query: { symbols: string } }) => ({
    asOf,
    rows: Object.fromEntries(
      o.query.symbols
        .split(',')
        .filter((s) => !omit.includes(s))
        .map((s, i) => [s, row(i + 1)]),
    ),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
  requestJson.mockReset();
  requestJson.mockImplementation(answer('2026-11-05'));
});
afterEach(() => {
  clearSnapshots();
  vi.useRealTimers();
});

describe('snapshot loader', () => {
  it('batches requests within the window into one call', async () => {
    const a = requestSnapshot('aapl');
    const b = requestSnapshot('MSFT');
    expect(requestJson).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await a).toEqual(row(1));
    expect(await b).toEqual(row(2));
    expect(requestJson).toHaveBeenCalledTimes(1);
    const [method, path, , opts] = requestJson.mock.calls[0]!;
    expect(method).toBe('GET');
    expect(path).toBe('/screener/snapshot');
    expect(opts.query).toEqual({ symbols: 'AAPL,MSFT' });
  });

  it('splits more than 200 symbols into several calls', async () => {
    const syms = Array.from({ length: CHUNK + 5 }, (_, i) => `S${i}`);
    const all = syms.map((s) => requestSnapshot(s));
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await Promise.all(all);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestJson.mock.calls[0]![3].query.symbols.split(',')).toHaveLength(CHUNK);
    expect(requestJson.mock.calls[1]![3].query.symbols.split(',')).toHaveLength(5);
  });

  it('dedupes in-flight requests and serves repeats from cache', async () => {
    const a = requestSnapshot('AAPL');
    const b = requestSnapshot('aapl');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await Promise.all([a, b]);
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestJson.mock.calls[0]![3].query.symbols).toBe('AAPL');
    expect(await requestSnapshot('AAPL')).toEqual(row(1));
    expect(peekSnapshot('aapl')).toEqual(row(1));
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it('remembers omitted (untracked) symbols as absent for 30 minutes', async () => {
    requestJson.mockImplementation(answer('2026-11-05', ['ZZZ']));
    const p = requestSnapshot('ZZZ');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await p).toBeNull();
    expect(peekSnapshot('ZZZ')).toBeNull();
    expect(peekSnapshots(['ZZZ'])).toEqual({});
    await requestSnapshot('ZZZ');
    expect(requestJson).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(NEGATIVE_TTL_MS + 1);
    expect(peekSnapshot('ZZZ')).toBeUndefined();
  });

  it('expires rows after 30 minutes', async () => {
    const p = requestSnapshot('AAPL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await p;
    vi.advanceTimersByTime(TTL_MS - 1000);
    expect(peekSnapshot('AAPL')).toEqual(row(1));
    vi.advanceTimersByTime(2000);
    expect(peekSnapshot('AAPL')).toBeUndefined();
  });

  it('drops rows of an older asOf once a newer one is seen', async () => {
    const a = requestSnapshot('AAPL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await a;
    requestJson.mockImplementation(answer('2026-11-06'));
    const b = requestSnapshot('MSFT');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    await b;
    expect(peekSnapshot('MSFT')).not.toBeUndefined();
    expect(peekSnapshot('AAPL')).toBeUndefined();
  });

  it.each([404, 501, 0])(
    'is disabled for the session after a %i, with no retries',
    async (status) => {
      requestJson.mockRejectedValue(new ApiError('nope', status));
      const a = requestSnapshot('AAPL');
      const b = requestSnapshot('MSFT');
      await vi.advanceTimersByTimeAsync(BATCH_MS);
      expect(await a).toBeNull();
      expect(await b).toBeNull();
      expect(snapshotsDisabled()).toBe(true);
      expect(await requestSnapshot('NVDA')).toBeNull();
      await vi.advanceTimersByTimeAsync(BATCH_MS * 4);
      expect(requestJson).toHaveBeenCalledTimes(1);
    },
  );

  it('retries after a transient failure, without disabling', async () => {
    requestJson.mockRejectedValueOnce(new ApiError('busy', 503));
    const a = requestSnapshot('AAPL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await a).toBeNull();
    expect(snapshotsDisabled()).toBe(false);
    expect(await requestSnapshot('AAPL')).toBeNull(); // negative window
    expect(requestJson).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(FAILURE_TTL_MS + 1);
    const b = requestSnapshot('AAPL');
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(await b).toEqual(row(1));
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});
