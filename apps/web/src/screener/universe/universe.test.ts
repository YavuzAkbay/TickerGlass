import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearUniverseCache, getUniverse, UniverseUnavailableError } from './index';
import { buildUniverse, SCREENER_CLASSES, UNIVERSE_AS_OF } from './types';

// The universes themselves live on the server (api/src/tickerglass_api/screener_data, checked
// by api/tests/test_screener_universe.py); here only the client-side loading and shapes.

function universeBody(cls: string): unknown {
  return {
    cls,
    groupLabel: 'sector',
    capKind: 'mcap',
    groups: ['Tech'],
    exchanges: ['NASDAQ'],
    symbols: [
      { symbol: 'AAA', name: 'Alpha', rank: 1, group: 'Tech', exchange: 'NASDAQ', cap: 10 },
      { symbol: 'BBB', name: 'Beta', rank: 2, group: 'Tech', exchange: null, cap: null },
    ],
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('getUniverse', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clearUniverseCache();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves every class from the API', async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(json(universeBody(new URL(url, 'http://x').searchParams.get('cls')!))),
    );
    for (const cls of SCREENER_CLASSES) {
      const universe = await getUniverse(cls);
      expect(universe.cls).toBe(cls);
      expect(universe.symbols).toHaveLength(2);
      expect(universe.symbols[1]).not.toHaveProperty('exchange');
      expect(universe.symbols[1]).not.toHaveProperty('cap');
    }
  });

  it('rejects with UniverseUnavailableError and caches nothing when the API is down', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(getUniverse('stocks')).rejects.toBeInstanceOf(UniverseUnavailableError);
    // A retry asks again and succeeds once the API is back.
    fetchMock.mockResolvedValue(json(universeBody('stocks')));
    expect((await getUniverse('stocks')).symbols).toHaveLength(2);
  });
});

describe('buildUniverse', () => {
  it('expands rows with 1-based ranks and first-seen group order', () => {
    const u = buildUniverse('stocks', 'sector', 'mcap', [
      ['B', 'Beta', 'Tech', 'NYSE', 5],
      ['A', 'Alpha', 'Tech', 'NASDAQ'],
    ]);
    expect(u.symbols).toEqual([
      { symbol: 'B', name: 'Beta', group: 'Tech', exchange: 'NYSE', cap: 5, rank: 1 },
      { symbol: 'A', name: 'Alpha', group: 'Tech', exchange: 'NASDAQ', rank: 2 },
    ]);
    expect(u.groups).toEqual(['Tech']);
    expect(u.exchanges).toEqual(['NYSE', 'NASDAQ']);
  });

  it('stamps the snapshot date', () => {
    expect(UNIVERSE_AS_OF).toMatch(/^\d{4}-\d{2}$/);
  });
});
