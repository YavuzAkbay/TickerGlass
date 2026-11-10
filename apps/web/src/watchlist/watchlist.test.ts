import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveQuote } from '../quotes/types';
import { emptyQuote } from '../quotes/merge';
import {
  buildRows,
  flagRows,
  formatTxt,
  parseTxt,
  describeImport,
  displayOrder,
  resolveActive,
  toYahooSymbol,
  txtFileName,
  addBlocker,
  MAX_WATCHLIST_ITEMS,
} from './model';
import { parsePrefs, useWatchlistPrefs } from './prefs';
import { describeMove } from './actions';
import { isSectionCollapsed, mergePersisted, useWatchlistStore } from './store';
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
      'AAPL',
      'DX-Y.NYB',
    ]);
    // Unknown exchange: reported, never imported as the bare ticker.
    expect(r.unmapped).toEqual(['EURONEXT:ABC;', 'FOO:BAR']); // EURONEXT alone: which market?
    expect(r.skipped).toBe(1); // "bad symbol"
    expect(r.duplicates).toBe(1); // AAPL
    expect(r.items.find((i) => i.type === 'section')).toMatchObject({ title: 'Section' });
  });

  it('truncates at 1000 items', () => {
    const text = Array.from({ length: 1200 }, (_, i) => `S${i}`).join(',');
    expect(parseTxt(text).items).toHaveLength(1000);
  });

  it('toYahooSymbol', () => {
    expect(toYahooSymbol('BINANCE:ETHEUR')).toBe('ETH-EUR');
    expect(toYahooSymbol('COMEX:GC2!')).toBe('GC=F');
    expect(toYahooSymbol('NYSE:BRK.B')).toBe('BRK-B');
    expect(toYahooSymbol('')).toBeNull();
  });

  it('maps US class shares to Yahoo dashes, only for US exchanges', () => {
    for (const ex of ['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS'])
      expect(toYahooSymbol(`${ex}:BRK.B`)).toBe('BRK-B');
    expect(toYahooSymbol('NYSE:BF.B')).toBe('BF-B');
    expect(toYahooSymbol('NYSE:BAC')).toBe('BAC');
    expect(toYahooSymbol('VOD.L')).toBe('VOD.L'); // plain Yahoo symbol untouched
  });

  it('maps exchange prefixes to Yahoo suffixes', () => {
    const cases: Record<string, string> = {
      'LSE:VOD': 'VOD.L',
      'XETR:SAP': 'SAP.DE',
      'TSX:RY': 'RY.TO',
      'TSX:RCI.B': 'RCI-B.TO',
      'TSXV:ABC': 'ABC.V',
      'ASX:BHP': 'BHP.AX',
      'HKEX:700': '0700.HK',
      'HKEX:9988': '9988.HK',
      'TSE:7203': '7203.T',
      'NSE:TCS': 'TCS.NS',
      'BSE:500325': '500325.BO',
      'BIST:THYAO': 'THYAO.IS',
      'SIX:NESN': 'NESN.SW',
      'MIL:ENI': 'ENI.MI',
      'BME:SAN': 'SAN.MC',
      'OMXSTO:VOLV_B': 'VOLV_B.ST',
      'OSL:EQNR': 'EQNR.OL',
      'OMXCOP:NOVO_B': 'NOVO_B.CO',
      'OMXHEX:NOKIA': 'NOKIA.HE',
      'KRX:005930': '005930.KS',
      'TWSE:2330': '2330.TW',
      'SGX:D05': 'D05.SI',
      'BMFBOVESPA:PETR4': 'PETR4.SA',
      'BMV:WALMEX': 'WALMEX.MX',
      'EURONEXT_PAR:MC': 'MC.PA',
      'BINANCE:BTCUSDT': 'BTC-USD',
      'COINBASE:ETHEUR': 'ETH-EUR',
      'FX:EURUSD': 'EURUSD=X',
    };
    for (const [from, to] of Object.entries(cases))
      expect([from, toYahooSymbol(from)]).toEqual([from, to]);
  });

  it('never keeps the bare ticker of an unknown or ambiguous prefix', () => {
    for (const raw of ['EURONEXT:AIR', 'FOO:BAR', 'FX:EUR', 'BINANCE:BTC', 'NYSE:']) {
      expect(toYahooSymbol(raw)).toBeNull();
    }
    const r = parseTxt('EURONEXT:AIR,FOO:BAR,AAPL,euronext:air');
    expect(symbols(r.items)).toEqual(['AAPL']);
    expect(r.unmapped).toEqual(['EURONEXT:AIR', 'FOO:BAR']);
  });

  it('reports truncation at 1000 items and skipped duplicates', () => {
    const text = [...Array.from({ length: 1005 }, (_, i) => `S${i}`), 'S0', 'S1'].join(',');
    const r = parseTxt(text);
    expect(r.items).toHaveLength(1000);
    expect(r.truncated).toBe(7); // 5 symbols + the 2 repeats are past the cap
    expect(r.duplicates).toBe(0);
    const d = parseTxt('A,B,A,A');
    expect(d.duplicates).toBe(2);
    expect(d.truncated).toBe(0);
  });

  it('parses pasted text: comma, space, semicolon and new line separated', () => {
    const r = parseTxt('aapl msft;NASDAQ:NVDA\n  tsla,\tBRK-B  LSE:VOD', { loose: true });
    expect(symbols(r.items)).toEqual(['AAPL', 'MSFT', 'NVDA', 'TSLA', 'BRK-B', 'VOD.L']);
    // Without `loose` a space makes the entry invalid, as before.
    expect(parseTxt('aapl msft').skipped).toBe(1);
    // Section titles keep their spaces in pasted text too.
    expect(parseTxt('###My Section\nAAPL', { loose: true }).items[0]).toMatchObject({
      title: 'My Section',
    });
  });

  it('describeImport lists the first 5 unmapped and the rest as a count', () => {
    const r = parseTxt('A:1,B:2,C:3,D:4,E:5,F:6,G:7,AAPL');
    const msg = describeImport({ ...r, duplicates: 2, truncated: 3 }, 1);
    expect(msg).toContain('Imported 1 symbol;');
    expect(msg).toContain('7 not imported (unknown exchange): A:1, B:2, C:3, D:4, E:5 +2 more');
    expect(msg).toContain('2 duplicates skipped');
    expect(msg).toContain('3 left out');
    expect(describeImport(parseTxt('AAPL'), 1)).toBe('Imported 1 symbol');
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
    expect(st().lists[id]!.items[1]).toMatchObject({ title: 'New' });
    const keep = st().duplicateList(id, 'copy');
    expect((st().lists[keep]!.items[1] as { id: string }).id).not.toBe(sid);
    st().removeSection(id, sid, true);
    expect(items(id)).toEqual(['A', 'B']);
    st().removeSection(keep, (st().lists[keep]!.items[1] as { id: string }).id, false);
    expect(items(keep)).toEqual(['A']);
  });

  describe('section collapse is local', () => {
    beforeEach(() => useWatchlistPrefs.setState({ collapsed: {} }));

    it('toggle changes prefs only: list not dirty, items content unchanged', () => {
      const id = st().createList('l', [S('A')]);
      const sid = st().addSection(id, 'Sec');
      useWatchlistStore.setState((s) => ({
        lists: { ...s.lists, [id]: { ...s.lists[id]!, dirty: false } },
      }));
      const before = st().lists[id]!.items;
      st().toggleSection(id, sid);
      expect(isSectionCollapsed(id, sid)).toBe(true);
      expect(st().lists[id]!.dirty).toBe(false);
      expect(st().lists[id]!.items).toEqual(before);
      expect(st().lists[id]!.items).toBe(before); // views follow the prefs map instead
      expect(useWatchlistPrefs.getState().collapsed).toEqual({ [sid]: true });
      st().toggleSection(id, sid);
      expect(isSectionCollapsed(id, sid)).toBe(false);
    });

    it('migrates the legacy synced flag on read; the pref wins once set', () => {
      const id = st().createList('l', [SEC('old', true), S('A')]);
      expect(isSectionCollapsed(id, 'old')).toBe(true);
      const rows = buildRows(st().lists[id]!.items, null, {});
      expect(rows[0]).toMatchObject({ kind: 'section', collapsed: true });
      st().toggleSection(id, 'old'); // expand
      expect(isSectionCollapsed(id, 'old')).toBe(false);
      // the item still says collapsed, but rows follow the pref
      expect(buildRows(st().lists[id]!.items, null, {})[0]).toMatchObject({ collapsed: false });
    });

    it('deleting a list forgets its sections', () => {
      const id = st().createList('l', [SEC('x')]);
      st().toggleSection(id, 'x');
      st().deleteList(id);
      expect(useWatchlistPrefs.getState().collapsed).toEqual({});
    });
  });

  describe('undo', () => {
    it('removeSymbols returns a snapshot; restore puts symbols back in place', () => {
      const id = st().createList('l', [S('A'), SEC('s'), S('B'), S('C'), S('D')]);
      const snap = st().removeSymbols(id, ['b', 'D', 'nope'])!;
      expect(items(id)).toEqual(['A', '#s', 'C']);
      expect(snap.entries.map((e) => e.index)).toEqual([2, 4]);
      expect(st().restore(snap)).toBe(2);
      expect(items(id)).toEqual(['A', '#s', 'B', 'C', 'D']);
      expect(st().lists[id]!.dirty).toBe(true);
      expect(st().removeSymbols(id, ['nope'])).toBeNull();
    });

    it('restore works after other edits and skips symbols re-added meanwhile', () => {
      const id = st().createList('l', [S('A'), S('B'), S('C')]);
      const snap = st().removeSymbols(id, ['A', 'B'])!;
      st().addSymbols(id, ['B', 'Z']);
      expect(items(id)).toEqual(['C', 'B', 'Z']);
      expect(st().restore(snap)).toBe(1); // only A; B is already there
      expect(items(id)).toEqual(['A', 'C', 'B', 'Z']);
    });

    it('undoLast restores the last removal once; moves are not undoable removals', () => {
      const id = st().createList('l', [S('A'), S('B')]);
      expect(st().undoLast()).toBe(0);
      st().removeSymbols(id, ['A']);
      expect(st().undoLast()).toBe(1);
      expect(items(id)).toEqual(['A', 'B']);
      expect(st().undoLast()).toBe(0);
      const other = st().createList('o', []);
      st().moveSymbols(id, other, ['A']);
      expect(st().undoLast()).toBe(0);
    });

    it('removeSection with symbols is restored whole, also without them', () => {
      const id = st().createList('l', [S('A'), SEC('s'), S('B'), S('C')]);
      const all = st().removeSection(id, 's', false)!;
      expect(items(id)).toEqual(['A']);
      expect(st().restore(all)).toBe(3);
      expect(items(id)).toEqual(['A', '#s', 'B', 'C']);
      const only = st().removeSection(id, 's', true)!;
      expect(items(id)).toEqual(['A', 'B', 'C']);
      st().restore(only);
      expect(items(id)).toEqual(['A', '#s', 'B', 'C']);
      expect(st().removeSection(id, 'missing', true)).toBeNull();
    });

    it('restore respects the item cap', () => {
      const id = st().createList('l', [S('A')]);
      const snap = st().removeSymbols(id, ['A'])!;
      st().addSymbols(
        id,
        Array.from({ length: MAX_WATCHLIST_ITEMS }, (_, i) => `S${i}`),
      );
      expect(st().restore(snap)).toBe(0);
    });
  });

  it('moveSymbolsDetailed reports what did not fit', () => {
    const a = st().createList('a', [S('A'), S('B'), S('C')]);
    const b = st().createList(
      'b',
      Array.from({ length: MAX_WATCHLIST_ITEMS - 1 }, (_, i) => S(`X${i}`)),
    );
    st().addSymbols(b, ['A']); // now full; A already there
    const r = st().moveSymbolsDetailed(a, b, ['A', 'B', 'C']);
    expect(r).toEqual({ moved: 0, alreadyThere: 1, leftBehind: 2 });
    expect(items(a)).toEqual(['B', 'C']);
    expect(describeMove(r, 'b')).toBe("1 symbol already in b; 2 didn't fit (list is full)");
    expect(describeMove({ moved: 3, alreadyThere: 0, leftBehind: 0 }, 'x')).toBe(
      'Moved 3 symbols to x',
    );
    expect(describeMove({ moved: 1, alreadyThere: 1, leftBehind: 2 }, 'x')).toBe(
      "Moved 1 symbol to x; 1 already there; 2 didn't fit (list is full)",
    );
  });

  it('moveSymbols adds to the target and removes from the source', () => {
    const a = st().createList('a', [S('A'), S('B'), S('C')]);
    const b = st().createList('b', [S('B')]);
    expect(st().moveSymbols(a, b, ['b', 'c', 'nope'])).toBe(1);
    expect(items(a)).toEqual(['A']);
    expect(items(b)).toEqual(['B', 'C']);
  });

  it("delete forgets the list's remembered page view; `loaded` starts false", async () => {
    const { useWatchlistPagePrefs } = await import('./page/pagePrefs');
    expect(useWatchlistStore.getState().loaded).toBe(false);
    const a = st().createList('a');
    const b = st().createList('b');
    useWatchlistPagePrefs.setState({
      views: { [a]: { columns: ['last'], sort: null }, [b]: { columns: ['name'], sort: null } },
    });
    st().deleteList(a);
    expect(Object.keys(useWatchlistPagePrefs.getState().views)).toEqual([b]);
    useWatchlistPagePrefs.setState({ views: {} });
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

  it('normalizes the old single-list pendingSeed shape to the multi-list one', () => {
    const old = { pendingSeed: { id: 'a', sig: 's' } };
    expect(mergePersisted(old, useWatchlistStore.getState()).pendingSeed).toEqual({
      ids: ['a'],
      sigs: { a: 's' },
    });
    const fresh = { pendingSeed: { ids: ['a', 'b'], sigs: { a: 's1' } } };
    expect(mergePersisted(fresh, useWatchlistStore.getState()).pendingSeed).toEqual({
      ids: ['a', 'b'],
      sigs: { a: 's1' },
    });
    expect(
      mergePersisted({ pendingSeed: null }, useWatchlistStore.getState()).pendingSeed,
    ).toBeNull();
    expect(
      mergePersisted({ pendingSeed: { ids: [] } }, useWatchlistStore.getState()).pendingSeed,
    ).toBeNull();
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

describe('sidebar column presets', () => {
  it('setColumns keeps canonical order, drops page-only columns and clears a hidden sort', () => {
    useWatchlistPrefs.setState({
      activeId: null,
      columns: ['last'],
      sort: { key: 'volume', dir: 'asc' },
    });
    useWatchlistPrefs.getState().setColumns(['trend', 'name', 'last', 'dayRange', 'gapPercent']);
    expect(useWatchlistPrefs.getState().columns).toEqual(['last', 'gapPercent', 'trend']);
    expect(useWatchlistPrefs.getState().sort).toBeNull();
  });

  it('parsePrefs accepts the new columns and sort keys', () => {
    expect(
      parsePrefs({
        columns: ['week52Range', 'last', 'marketCap'],
        sort: { key: 'relVolume', dir: 'desc' },
      }),
    ).toEqual({
      columns: ['last', 'marketCap', 'week52Range'],
      sort: { key: 'relVolume', dir: 'desc' },
    });
    expect(parsePrefs({ sort: { key: 'dayRange', dir: 'asc' } })).toEqual({});
  });
});

describe('collapsed prefs', () => {
  it('persists only valid entries', async () => {
    const { parseCollapsed } = await import('./prefs');
    expect(parseCollapsed({ a: true, b: false, c: 'x', '': true })).toEqual({ a: true, b: false });
    expect(parseCollapsed(null)).toEqual({});
  });

  it('keeps the most recent entries on load', async () => {
    const { parseCollapsed, MAX_COLLAPSE_ENTRIES } = await import('./prefs');
    const raw = Object.fromEntries(
      Array.from({ length: MAX_COLLAPSE_ENTRIES + 10 }, (_, i) => [`s${i}`, true]),
    );
    const out = parseCollapsed(raw);
    expect(Object.keys(out)).toHaveLength(MAX_COLLAPSE_ENTRIES);
    expect(out.s0).toBeUndefined();
    expect(out[`s${MAX_COLLAPSE_ENTRIES + 9}`]).toBe(true);
  });

  it('caps on write, dropping the oldest and moving an updated entry to the end', async () => {
    const { MAX_COLLAPSE_ENTRIES } = await import('./prefs');
    const collapsed = Object.fromEntries(
      Array.from({ length: MAX_COLLAPSE_ENTRIES }, (_, i) => [`s${i}`, true]),
    );
    useWatchlistPrefs.setState({ collapsed });
    useWatchlistPrefs.getState().setSectionCollapsed('s1', false);
    let keys = Object.keys(useWatchlistPrefs.getState().collapsed);
    expect(keys).toHaveLength(MAX_COLLAPSE_ENTRIES);
    expect(keys[keys.length - 1]).toBe('s1');
    useWatchlistPrefs.getState().setSectionCollapsed('new', true);
    keys = Object.keys(useWatchlistPrefs.getState().collapsed);
    expect(keys).toHaveLength(MAX_COLLAPSE_ENTRIES);
    expect(keys).not.toContain('s0');
    expect(keys[keys.length - 1]).toBe('new');
    expect(keys).toContain('s1');
    useWatchlistPrefs.setState({ collapsed: {} });
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

describe('displayOrder', () => {
  const items = [S('B'), S('A'), SEC('s1'), S('D'), S('C'), SEC('s2'), S('E')];
  const quotes = {
    A: q('A', { last: 1 }),
    B: q('B', { last: 2 }),
    C: q('C', { last: 3 }),
    D: q('D', { last: 4 }),
  };

  it('follows item order without sort', () => {
    expect(displayOrder(items, null, quotes)).toEqual(['B', 'A', 'D', 'C', 'E']);
  });
  it('applies the sort within sections and skips collapsed sections', () => {
    expect(displayOrder(items, { key: 'last', dir: 'desc' }, quotes, { s1: true })).toEqual([
      'B',
      'A',
      'E',
    ]);
    expect(displayOrder(items, { key: 'symbol', dir: 'asc' }, quotes)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
  });
});

describe('buildRows with symbol meta (page name sort)', () => {
  const items: WatchlistItem[] = [S('MSFT'), S('AAPL'), S('NVDA')];
  const meta = {
    MSFT: { name: 'Microsoft', exchange: null, type: null },
    AAPL: { name: 'Apple', exchange: null, type: null },
  };
  const syms = (rows: ReturnType<typeof buildRows>) =>
    rows.map((r) => (r.kind === 'symbol' ? r.symbol : ''));
  it('sorts alphabetically by the resolved name, missing names last', () => {
    const rows = buildRows(items, { key: 'name', dir: 'asc' }, {}, true, meta);
    expect(syms(rows)).toEqual(['AAPL', 'MSFT', 'NVDA']);
    const desc = buildRows(items, { key: 'name', dir: 'desc' }, {}, true, meta);
    expect(syms(desc)).toEqual(['MSFT', 'AAPL', 'NVDA']);
  });
  it('without meta the sort is stable (all nulls keep list order)', () => {
    const rows = buildRows(items, { key: 'name', dir: 'asc' }, {});
    expect(syms(rows)).toEqual(['MSFT', 'AAPL', 'NVDA']);
  });
});
