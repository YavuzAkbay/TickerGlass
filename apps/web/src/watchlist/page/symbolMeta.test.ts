import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchSymbols = vi.fn();
vi.mock('../../chart/feed', () => ({
  feed: { searchSymbols: (...a: unknown[]) => searchSymbols(...a) },
}));

import {
  peekSymbolMeta,
  requestSymbolMeta,
  resetSymbolMetaForTests,
  wantSymbolMetas,
} from './symbolMeta';

const hit = (symbol: string) => [{ symbol, name: `${symbol} Inc`, exchange: 'X', type: 'equity' }];

describe('symbolMeta bulk wishes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetSymbolMetaForTests();
    searchSymbols.mockReset();
    searchSymbols.mockImplementation((s: string) => Promise.resolve(hit(s)));
  });
  afterEach(() => {
    resetSymbolMetaForTests();
    vi.useRealTimers();
  });

  it('resolves a whole list past the single-request queue cap', async () => {
    const symbols = Array.from({ length: 260 }, (_, i) => `S${i}`);
    wantSymbolMetas('t', symbols);
    await vi.advanceTimersByTimeAsync(150 * 300);
    expect(peekSymbolMeta('S0')?.name).toBe('S0 Inc');
    expect(peekSymbolMeta('S259')?.name).toBe('S259 Inc');
    expect(searchSymbols).toHaveBeenCalledTimes(260);
  });

  it('serves visible-row requests before the backlog', async () => {
    wantSymbolMetas('t', ['A', 'B', 'C']);
    requestSymbolMeta('Z');
    await vi.advanceTimersByTimeAsync(150);
    expect(searchSymbols.mock.calls[0]?.[0]).toBe('Z');
  });

  it('stops once the wish is withdrawn', async () => {
    wantSymbolMetas(
      't',
      Array.from({ length: 100 }, (_, i) => `S${i}`),
    );
    await vi.advanceTimersByTimeAsync(150 * 3);
    wantSymbolMetas('t', null);
    await vi.advanceTimersByTimeAsync(150 * 5);
    // At most the queued batch (20) drains after withdrawal.
    expect(searchSymbols.mock.calls.length).toBeLessThanOrEqual(25);
  });

  it('does not hot-loop on network errors', async () => {
    searchSymbols.mockImplementation(() => Promise.reject(new Error('down')));
    wantSymbolMetas('t', ['A', 'B']);
    await vi.advanceTimersByTimeAsync(150 * 50);
    expect(searchSymbols).toHaveBeenCalledTimes(2);
  });
});
