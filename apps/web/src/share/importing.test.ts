import { beforeEach, describe, expect, it } from 'vitest';
import { useWatchlistPrefs } from '../watchlist/prefs';
import { useWatchlistStore } from '../watchlist/store';
import type { WatchlistShare } from './codec';
import { countRules, importWatchlist, sectionCount, summarizeSpec, uniqueName } from './importing';

const st = () => useWatchlistStore.getState();
const PAYLOAD: WatchlistShare = {
  v: 1,
  type: 'watchlist',
  name: 'Shared',
  items: ['AAPL', { section: 'Semis' }, 'NVDA', 'MSFT'],
};

beforeEach(() => {
  useWatchlistStore.setState({
    lists: {},
    pendingDeletes: [],
    flags: {},
    flagsDirty: {},
    seeded: false,
    lastUndo: null,
  });
  useWatchlistPrefs.getState().setActive(null);
});

describe('uniqueName', () => {
  it('keeps free names and numbers taken ones', () => {
    expect(uniqueName('Tech', [])).toBe('Tech');
    expect(uniqueName('Tech', ['Other'])).toBe('Tech');
    expect(uniqueName('Tech', ['Tech'])).toBe('Tech (2)');
    expect(uniqueName(' tech ', ['TECH', 'tech (2)'])).toBe('tech (3)');
    expect(uniqueName('', [])).toBe('Watchlist');
  });

  it('stays within 200 characters', () => {
    const long = 'x'.repeat(200);
    const out = uniqueName(long, [long]);
    expect(out).toHaveLength(200);
    expect(out.endsWith(' (2)')).toBe(true);
  });
});

describe('importWatchlist', () => {
  it('creates a new list with its sections and activates it', () => {
    const r = importWatchlist(PAYLOAD, { mode: 'new', name: 'Shared' })!;
    expect(r).toMatchObject({ name: 'Shared', added: 3, skipped: 0 });
    const items = st().lists[r.id]!.items;
    expect(items.map((i) => (i.type === 'section' ? `#${i.title}` : i.symbol))).toEqual([
      'AAPL',
      '#Semis',
      'NVDA',
      'MSFT',
    ]);
    expect(useWatchlistPrefs.getState().activeId).toBe(r.id);
  });

  it('dedupes the name of a new list', () => {
    const first = importWatchlist(PAYLOAD, { mode: 'new', name: 'Shared' })!;
    const second = importWatchlist(PAYLOAD, { mode: 'new', name: 'Shared' })!;
    expect(second.name).toBe('Shared (2)');
    expect(second.id).not.toBe(first.id);
    expect(Object.keys(st().lists)).toHaveLength(2);
  });

  it('adds only the missing symbols to an existing list, no sections', () => {
    const id = st().createList('Mine', [{ type: 'symbol', symbol: 'AAPL' }]);
    const r = importWatchlist(PAYLOAD, { mode: 'existing', id })!;
    expect(r).toMatchObject({ id, name: 'Mine', added: 2, skipped: 1 });
    expect(st().lists[id]!.items).toEqual([
      { type: 'symbol', symbol: 'AAPL' },
      { type: 'symbol', symbol: 'NVDA' },
      { type: 'symbol', symbol: 'MSFT' },
    ]);
  });

  it('returns null for a list that is gone', () => {
    expect(importWatchlist(PAYLOAD, { mode: 'existing', id: 'nope' })).toBeNull();
    expect(Object.keys(st().lists)).toHaveLength(0);
  });
});

describe('summaries', () => {
  it('counts sections and nested rules', () => {
    expect(sectionCount(PAYLOAD.items)).toBe(1);
    expect(countRules(null)).toBe(0);
    const spec = {
      schemaVersion: 1 as const,
      universe: { kind: 'symbols' as const, symbols: ['A', 'B'] },
      filter: {
        op: 'and' as const,
        rules: [
          { field: 'a', op: '<' as const, value: 1 },
          { op: 'or' as const, rules: [{ field: 'b', op: '>' as const, value: 2 }] },
        ],
      },
      sort: { field: 'a', dir: 'desc' as const },
      columns: ['x', 'y'],
    };
    expect(countRules(spec.filter)).toBe(2);
    expect(summarizeSpec(spec)).toEqual({
      universe: { kind: 'symbols', value: '2' },
      rules: 2,
      sort: 'a ↓',
      columns: 2,
    });
  });
});
