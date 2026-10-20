import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveQuote } from '../quotes/types';
import { emptyQuote } from '../quotes/merge';
import {
  buildRows,
  flagRows,
  formatTxt,
  parseTxt,
  resolveActive,
  toYahooSymbol,
  txtFileName,
  addBlocker,
  MAX_WATCHLIST_ITEMS,
} from './model';
import { parsePrefs, useWatchlistPrefs } from './prefs';
import { mergePersisted, useWatchlistStore } from './store';
import type { WatchlistEntry, WatchlistItem } from './types';

const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const SEC = (id: string, collapsed = false): WatchlistItem => ({
  type: 'section',
  id,
  title: id,
  collapsed,
});
const q = (symbol: string, o: Partial<LiveQuote>): LiveQuote => ({ ...emptyQuote(symbol), ...o });
const symbols = (items: WatchlistItem[]) =>
  items.map((i) => (i.type === 'symbol' ? i.symbol : `#${i.id}`));

describe('txt', () => {
  const SAMPLE_EXPORT =
    '###INDICES,SP:SPX,NASDAQ:AAPL,BIST:THYAO,BINANCE:BTCUSDT,CME_MINI:ES1!,FX:EURUSD';
  it('parses an exported watchlist', () => {
    const r = parseTxt(SAMPLE_EXPORT);
    expect(symbols(r.items)).toEqual([
      '#' + (r.items[0] as { id: string }).id,
      '^GSPC',
      'AAPL',
      'THYAO.IS',
      'BTC-USD',
      'ES=F',
      'EURUSD=X',
    ]);
    expect(r.items[0]).toMatchObject({ type: 'section', title: 'INDICES' });
    expect(r.unmapped).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('maps exchanges, reports unmapped prefixes, drops duplicates and invalid entries', () => {
    const r = parseTxt(
      'LSE:VOD\nHKEX:700, EURONEXT:ABC;\nFOO:BAR,nasdaq:aapl,AAPL,bad symbol,###  ,TVC:DXY',
    );
    expect(symbols(r.items).filter((s) => !s.startsWith('#'))).toEqual([
      'VOD.L',
      '0700.HK',
      'BAR',
      'AAPL',
      'DX-Y.NYB',
    ]);
    expect(r.unmapped).toEqual(['FOO:BAR']);
    expect(r.skipped).toBe(2); // "EURONEXT:ABC;" and "bad symbol"
    expect(r.items.find((i) => i.type === 'section')).toMatchObject({ title: 'Section' });
  });

  it('truncates at 1000 items', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `S${i}`).join(',');
    expect(parseTxt(text).items).toHaveLength(1000);
  });

  it('toYahooSymbol', () => {
    expect(toYahooSymbol('BINANCE:ETHEUR')).toBe('ETH-EUR');
    expect(toYahooSymbol('COMEX:GC2!')).toBe('GC=F');
    expect(toYahooSymbol('NYSE:BRK.B')).toBe('BRK.B');
    expect(toYahooSymbol('')).toBeNull();
  });

  it('formatTxt round-trips', () => {
    const items: WatchlistItem[] = [S('AAPL'), SEC('a'), S('MSFT'), S('VOD.L')];
    const text = formatTxt(items);
    expect(text).toBe('AAPL,###a,MSFT,VOD.L');
    expect(symbols(parseTxt(text).items).map((s) => (s.startsWith('#') ? '#x' : s))).toEqual([
      'AAPL',
      '#x',
      'MSFT',
      'VOD.L',
    ]);
    expect(txtFileName('a/b:c')).toBe('a_b_c.txt');
  });
});

describe('buildRows', () => {
  const items = [S('B'), S('A'), SEC('s1'), S('D'), S('C'), SEC('s2', true), S('E')];
  const quotes = {
    A: q('A', { last: 1, changePercent: 5 }),
    B: q('B', { last: 2 }),
    C: q('C', { last: 3, changePercent: -1 }),
    D: q('D', { last: 4 }),
  };
  const ids = (rows: ReturnType<typeof buildRows>) =>
    rows.map((r) => (r.kind === 'section' ? `#${r.id}` : r.symbol));

  it('keeps item order without sort and hides collapsed sections', () => {
    const rows = buildRows(items, null, quotes);
    expect(ids(rows)).toEqual(['B', 'A', '#s1', 'D', 'C', '#s2']);
    expect(rows[2]).toMatchObject({ kind: 'section', count: 2, index: 2 });
    expect(rows[5]).toMatchObject({ kind: 'section', collapsed: true, count: 1 });
    expect(rows[0]).toMatchObject({ kind: 'symbol', sectionId: null, index: 0 });
    expect(rows[3]).toMatchObject({ sectionId: 's1', index: 3 });
    expect(ids(buildRows(items, null, quotes, false))).toContain('E');
  });

  it('sorts within sections, nulls last in both directions', () => {
    const asc = buildRows(items, { key: 'changePercent', dir: 'asc' }, quotes);
    expect(ids(asc)).toEqual(['A', 'B', '#s1', 'C', 'D', '#s2']);
    const desc = buildRows(items, { key: 'changePercent', dir: 'desc' }, quotes);
    expect(ids(desc)).toEqual(['A', 'B', '#s1', 'C', 'D', '#s2']);
    expect(ids(buildRows(items, { key: 'symbol', dir: 'desc' }, quotes))).toEqual([
      'B',
      'A',
      '#s1',
      'D',
      'C',
      '#s2',
    ]);
  });

  it('flagRows orders by flag time', () => {
    const rows = flagRows(
      {
        X: { color: 'red', at: '2026-01-02' },
        Y: { color: 'red', at: '2026-01-01' },
        Z: { color: 'blue', at: '2026-01-01' },
      },
      'red',
    );
    expect(rows.map((r) => (r.kind === 'symbol' ? r.symbol : ''))).toEqual(['Y', 'X']);
    expect(rows[0]).toMatchObject({ index: -1, sectionId: null });
  });

  it('resolveActive', () => {
    const e = (id: string, name: string): WatchlistEntry => ({
      id,
      name,
      items: [],
      revision: 1,
      dirty: false,
    });
    const lists = { a: e('a', 'zeta'), b: e('b', 'Alpha') };
    expect(resolveActive('a', lists)).toBe('a');
    expect(resolveActive('gone', lists)).toBe('b');
    expect(resolveActive(null, lists)).toBe('b');
    expect(resolveActive('flag:red', lists)).toBe('flag:red');
    expect(resolveActive('flag:nope', lists)).toBe('b');
    expect(resolveActive(null, {})).toBeNull();
  });
});

describe('watchlist store', () => {
  const st = () => useWatchlistStore.getState();
  const items = (id: string) => symbols(st().lists[id]!.items);
  beforeEach(() => {
    useWatchlistStore.setState({
      lists: {},
      pendingDeletes: [],
      flags: {},
      flagsDirty: {},
      seeded: false,
    });
  });

  it('drops symbols the server would reject (SYMBOL_RE) on create, add and flag', () => {
    const id = st().createList('l', [S('A B'), S('aapl'), S('$$$')]);
    expect(items(id)).toEqual(['AAPL']);
    expect(st().addSymbols(id, ['A B', 'x'.repeat(33), 'msft'])).toEqual(['MSFT']);
    expect(st().addSymbols(id, ['A B'])).toEqual([]);
    expect(items(id)).toEqual(['AAPL', 'MSFT']);
    st().setFlag('A B', 'red');
    expect(st().flags).toEqual({});
    expect(st().flagsDirty).toEqual({});
  });

  it('rejects symbol expressions', () => {
    const id = st().createList('l', [S('AAPL/MSFT'), S('AAPL'), S('(A+B)')]);
    expect(items(id)).toEqual(['AAPL']);
    expect(st().addSymbols(id, ['AAPL/MSFT', 'BRK-B'])).toEqual(['BRK-B']);
    st().setFlag('AAPL/MSFT', 'red');
    expect(st().flags).toEqual({});
  });

  it('creates normalized, de-duplicated, dirty lists and rejects duplicates on add', () => {
    const id = st().createList(' Tech ', [S(' aapl '), S('AAPL'), S('msft')]);
    expect(st().lists[id]).toMatchObject({ name: 'Tech', revision: null, dirty: true });
    expect(items(id)).toEqual(['AAPL', 'MSFT']);
    expect(st().addSymbols(id, ['aapl', 'nvda', 'NVDA'])).toEqual(['NVDA']);
    expect(items(id)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(st().addSymbols(id, ['X'], 0)).toEqual(['X']);
    expect(items(id)).toEqual(['AAPL', 'X', 'MSFT', 'NVDA']);
  });

  it('enforces the 1000-item cap', () => {
    const id = st().createList('big', []);
    const many = Array.from({ length: 1005 }, (_, i) => `S${i}`);
    expect(st().addSymbols(id, many)).toHaveLength(1000);
    expect(st().addSymbols(id, ['EXTRA'])).toEqual([]);
    expect(st().addSection(id, 'x')).toBe('');
    expect(st().lists[id]!.items).toHaveLength(1000);
  });

  it('moveItem moves a section with its block and never splits another section', () => {
    const id = st().createList('l', [S('A'), SEC('s1'), S('B'), S('C'), SEC('s2'), S('D')]);
    st().moveItem(id, 1, 5); // s1 block (s1,B,C) to the end
    expect(items(id)).toEqual(['A', '#s2', 'D', '#s1', 'B', 'C']);
    st().moveItem(id, 0, 3); // A into s1's block
    expect(items(id)).toEqual(['#s2', 'D', '#s1', 'A', 'B', 'C']);
    st().moveItem(id, 3, 3);
    st().moveItem(id, 0, 3); // s2 block would land inside s1: snaps to its end
    expect(items(id)).toEqual(['#s1', 'A', 'B', 'C', '#s2', 'D']);
  });

  it('sections: add/rename/toggle/remove', () => {
    const id = st().createList('l', [S('A'), S('B')]);
    const sid = st().addSection(id, 'Sec', 1);
    expect(items(id)).toEqual(['A', `#${sid}`, 'B']);
    st().renameSection(id, sid, 'New');
    st().toggleSection(id, sid);
    expect(st().lists[id]!.items[1]).toMatchObject({ title: 'New', collapsed: true });
    const keep = st().duplicateList(id, 'copy');
    expect((st().lists[keep]!.items[1] as { id: string }).id).not.toBe(sid);
    st().removeSection(id, sid, true);
    expect(items(id)).toEqual(['A', 'B']);
    st().removeSection(keep, (st().lists[keep]!.items[1] as { id: string }).id, false);
    expect(items(keep)).toEqual(['A']);
  });

  it('moveSymbols adds to the target and removes from the source', () => {
    const a = st().createList('a', [S('A'), S('B'), S('C')]);
    const b = st().createList('b', [S('B')]);
    expect(st().moveSymbols(a, b, ['b', 'c', 'nope'])).toBe(1);
    expect(items(a)).toEqual(['A']);
    expect(items(b)).toEqual(['B', 'C']);
  });

  it('delete queues a server delete (also for unconfirmed creates), once; flags are dirty', () => {
    const a = st().createList('a');
    st().deleteList(a);
    // Its create may have gone through with the response lost: delete it too (404 = done).
    expect(st().pendingDeletes).toEqual([a]);
    useWatchlistStore.setState({ pendingDeletes: [] });
    useWatchlistStore.setState({
      lists: { z: { id: 'z', name: 'z', items: [], revision: 3, dirty: false } },
    });
    st().deleteList('z');
    expect(st().pendingDeletes).toEqual(['z']);
    st().setFlag('aapl', 'red');
    expect(st().flags.AAPL?.color).toBe('red');
    expect(st().flagsDirty).toEqual({ AAPL: true });
    st().setFlag('AAPL', null);
    expect(st().flags.AAPL).toBeUndefined();
  });

  it('rename marks dirty', () => {
    const id = st().createList('a');
    useWatchlistStore.setState({
      lists: { [id]: { ...st().lists[id]!, dirty: false, revision: 1 } },
    });
    st().renameList(id, 'b');
    expect(st().lists[id]).toMatchObject({ name: 'b', dirty: true });
  });
});

describe('rehydrate', () => {
  it('drops invalid symbols, marks changed lists dirty, cleans flags', () => {
    const entry = (id: string, items: WatchlistItem[]): WatchlistEntry => ({
      id,
      name: id,
      items,
      revision: 3,
      dirty: false,
    });
    const saved = {
      lists: { a: entry('a', [S('AAPL'), S('bad symbol!'), S('MSFT')]), b: entry('b', [S('IBM')]) },
      flags: {
        AAPL: { color: 'red', at: 't' },
        'no good': { color: 'blue', at: 't' },
      },
      flagsDirty: { AAPL: true, 'no good': true },
      pendingDeletes: ['x'],
      seeded: true,
    };
    const out = mergePersisted(saved, useWatchlistStore.getState());
    expect(symbols(out.lists.a!.items)).toEqual(['AAPL', 'MSFT']);
    expect(out.lists.a!.dirty).toBe(true);
    expect(out.lists.b).toBe(saved.lists.b);
    expect(out.lists.b!.dirty).toBe(false);
    expect(Object.keys(out.flags)).toEqual(['AAPL']);
    expect(Object.keys(out.flagsDirty)).toEqual(['AAPL']);
    expect(out.pendingDeletes).toEqual(['x']);
    expect(out.seeded).toBe(true);
  });
});

describe('prefs', () => {
  it('parsePrefs validates', () => {
    expect(parsePrefs(null)).toEqual({});
    expect(
      parsePrefs({
        activeId: 'flag:red',
        columns: ['volume', 'last', 'bogus'],
        sort: { key: 'last', dir: 'desc' },
      }),
    ).toEqual({
      activeId: 'flag:red',
      columns: ['last', 'volume'],
      sort: { key: 'last', dir: 'desc' },
    });
    expect(
      parsePrefs({ activeId: 'flag:x', sort: { key: 'zzz', dir: 'asc' }, columns: 'no' }),
    ).toEqual({
      activeId: null,
    });
    expect(parsePrefs({ sort: null })).toEqual({ sort: null });
  });

  it('toggleColumn keeps canonical order and clears a sort on a hidden column', () => {
    useWatchlistPrefs.setState({ activeId: null, columns: ['last'], sort: null });
    useWatchlistPrefs.getState().toggleColumn('volume');
    useWatchlistPrefs.getState().toggleColumn('change');
    expect(useWatchlistPrefs.getState().columns).toEqual(['last', 'change', 'volume']);
    useWatchlistPrefs.getState().setSort({ key: 'volume', dir: 'asc' });
    useWatchlistPrefs.getState().toggleColumn('volume');
    expect(useWatchlistPrefs.getState().sort).toBeNull();
  });
});

describe('addBlocker', () => {
  const full: WatchlistItem[] = Array.from({ length: MAX_WATCHLIST_ITEMS }, (_, i) => ({
    type: 'symbol',
    symbol: `S${i}`,
  }));
  it('distinguishes a full list from a duplicate', () => {
    expect(addBlocker(full, 'NEW')).toBe('full');
    expect(addBlocker(full, 'S3')).toBe('duplicate');
    expect(addBlocker(full.slice(1), 'NEW')).toBeNull();
    const id = useWatchlistStore.getState().createList('big', full);
    expect(useWatchlistStore.getState().addSymbols(id, ['NEW'])).toEqual([]);
  });
});
