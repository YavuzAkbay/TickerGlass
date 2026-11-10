import { describe, expect, it } from 'vitest';
import { EMPTY_FILTERS } from './model';
import { PRESETS } from './presets';
import {
  migrateScreenerPrefs,
  parseScreenerPrefs,
  SCREENER_PREFS_VERSION,
  useScreenerPrefs,
} from './screenerPrefs';

describe('parseScreenerPrefs', () => {
  it('keeps valid values and drops everything else', () => {
    const parsed = parseScreenerPrefs({
      tab: 'crypto',
      sort: { key: 'changePercent', dir: 'desc' },
      pageSize: 50,
      universeSize: 250,
      columns: ['name', 'cap', 'bogus'],
      density: 'compact',
      detailOpen: false,
      filters: { stocks: { search: 'a', chgMin: 1 }, etfs: 'nope' },
      junk: true,
    });
    expect(parsed.tab).toBe('crypto');
    expect(parsed.sort).toEqual({ key: 'changePercent', dir: 'desc' });
    expect(parsed.pageSize).toBe(50);
    expect(parsed.universeSize).toBe(250);
    expect(parsed.columns).toEqual(['name', 'cap']);
    expect(parsed.density).toBe('compact');
    expect(parsed.detailOpen).toBe(false);
    expect(parsed.filters?.stocks).toEqual({ ...EMPTY_FILTERS, search: 'a', chgMin: 1 });
    expect(parsed.filters?.etfs).toEqual(EMPTY_FILTERS);
    expect('junk' in (parsed as object)).toBe(false);
  });

  it('rejects invalid enums and bounds', () => {
    const parsed = parseScreenerPrefs({
      tab: 'bogus',
      preset: 'bogus',
      sort: { key: 'bogus', dir: 'up' },
      pageSize: -3,
      universeSize: 0,
      density: 'snug',
    });
    expect(parsed.tab).toBeUndefined();
    expect('preset' in parsed).toBe(false);
    expect(parsed.sort).toBeUndefined();
    expect(parsed.pageSize).toBeUndefined();
    expect(parsed.universeSize).toBeUndefined();
    expect(parsed.density).toBeUndefined();
  });

  it('accepts every sort key the table offers, including ext % and the new columns', () => {
    for (const key of ['extChangePercent', 'liveCap', 'relVolume', 'week52Pos', 'dayRangePct']) {
      expect(parseScreenerPrefs({ sort: { key, dir: 'asc' } }).sort).toEqual({ key, dir: 'asc' });
    }
  });

  it('every preset sort survives a round trip (whitelist derives from PRESETS)', () => {
    for (const p of PRESETS) {
      expect(parseScreenerPrefs({ sort: p.sort }).sort).toEqual(p.sort);
      // Legacy stored preset without a sort still resolves to the preset's sort.
      expect(parseScreenerPrefs({ preset: p.id }).sort).toEqual(p.sort);
    }
    expect(parseScreenerPrefs({ preset: 'bogus' }).sort).toBeUndefined();
    // An explicit sort wins over a stale stored preset.
    expect(parseScreenerPrefs({ preset: 'gainers', sort: null }).sort).toBeNull();
  });

  it('validates the page size against the allowed set', () => {
    expect(parseScreenerPrefs({ pageSize: 20 }).pageSize).toBe(20);
    expect(parseScreenerPrefs({ pageSize: 100 }).pageSize).toBe(100);
    expect(parseScreenerPrefs({ pageSize: 500 }).pageSize).toBe(500); // server table only
    expect(parseScreenerPrefs({ pageSize: 37 }).pageSize).toBeUndefined();
    expect(parseScreenerPrefs({ pageSize: 20.5 }).pageSize).toBeUndefined();
    expect(parseScreenerPrefs({ pageSize: '50' }).pageSize).toBeUndefined();
  });

  it('universe size is an integer >= 20 or null', () => {
    expect(parseScreenerPrefs({ universeSize: 20 }).universeSize).toBe(20);
    expect(parseScreenerPrefs({ universeSize: 19 }).universeSize).toBeUndefined();
    expect(parseScreenerPrefs({ universeSize: 100.5 }).universeSize).toBeUndefined();
    expect(parseScreenerPrefs({ universeSize: Infinity }).universeSize).toBeUndefined();
    expect(parseScreenerPrefs({ universeSize: 'x' }).universeSize).toBeUndefined();
  });

  it('keeps the new opt-in columns in canonical order', () => {
    expect(
      parseScreenerPrefs({ columns: ['liveCap', 'week52Range', 'relVolume', 'name'] }).columns,
    ).toEqual(['name', 'relVolume', 'week52Range', 'liveCap']);
  });

  it('accepts null limits', () => {
    expect(parseScreenerPrefs({ pageSize: null, universeSize: null }).pageSize).toBeNull();
    expect(parseScreenerPrefs({ universeSize: null }).universeSize).toBeNull();
  });

  it('edits reset the page; setPage clamps negatives', () => {
    useScreenerPrefs.setState({ page: 3 });
    useScreenerPrefs.getState().setFilters('commodities', { ...EMPTY_FILTERS, search: 'x' });
    expect(useScreenerPrefs.getState().page).toBe(0);
    useScreenerPrefs.getState().setPage(4);
    expect(useScreenerPrefs.getState().page).toBe(4);
    useScreenerPrefs.getState().setPage(-1);
    expect(useScreenerPrefs.getState().page).toBe(0);
    useScreenerPrefs.getState().setPageSize(50);
    expect(useScreenerPrefs.getState().page).toBe(0);
    expect(useScreenerPrefs.getState().pageSize).toBe(50);
  });
});

describe('useScreenerPrefs', () => {
  it('setPreset applies the preset sort; null clears it', () => {
    const store = useScreenerPrefs.getState();
    store.setPreset('losers');
    expect(useScreenerPrefs.getState().sort).toEqual({ key: 'changePercent', dir: 'asc' });
    useScreenerPrefs.getState().setPreset(null);
    expect(useScreenerPrefs.getState().sort).toBeNull();
    useScreenerPrefs.getState().setSort({ key: 'volume', dir: 'desc' });
    expect(useScreenerPrefs.getState().sort).toEqual({ key: 'volume', dir: 'desc' });
    void store;
  });

  it('filters are stored per class', () => {
    useScreenerPrefs.getState().setFilters('crypto', { ...EMPTY_FILTERS, search: 'btc' });
    expect(useScreenerPrefs.getState().filters.crypto.search).toBe('btc');
    expect(useScreenerPrefs.getState().filters.stocks.search).toBe('');
  });
});

describe('persist migration', () => {
  const migrate = migrateScreenerPrefs;

  it('is at version 4', () => {
    expect(SCREENER_PREFS_VERSION).toBe(4);
  });

  it('v3 -> v4 keeps the stored prefs and parses with the server draft defaults', () => {
    const v3 = {
      tab: 'etfs',
      pageSize: 50,
      sort: { key: 'volume', dir: 'desc' },
      columns: ['name'],
    };
    const migrated = migrate(v3, 3);
    expect(migrated).toEqual(v3);
    const parsed = parseScreenerPrefs(migrated);
    expect(parsed.tab).toBe('etfs');
    expect(parsed.pageSize).toBe(50);
    expect(parsed.draft).toBeUndefined();
    expect(parsed.serverColumns).toBeUndefined();
    expect(parsed.activeScreenId).toBeUndefined();
  });

  it('v1 -> v4 chains every step', () => {
    expect(migrate({ resultLimit: 10, preset: 'losers' }, 1)).toEqual({
      sort: { key: 'changePercent', dir: 'asc' },
    });
  });

  it('v2 -> v3 drops the stored preset (a sort-less preset becomes its sort)', () => {
    expect(migrate({ preset: 'gainers', sort: { key: 'volume', dir: 'desc' } }, 2)).toEqual({
      sort: { key: 'volume', dir: 'desc' },
    });
    expect(migrate({ preset: 'losers' }, 2)).toEqual({
      sort: { key: 'changePercent', dir: 'asc' },
    });
    expect(migrate({ preset: 'gainers', sort: null }, 2)).toEqual({ sort: null });
  });

  it('v1 -> v3 also drops resultLimit', () => {
    expect(migrate({ resultLimit: 10, preset: null, pageSize: 20 }, 1)).toEqual({ pageSize: 20 });
  });
});

describe('server draft prefs (v4)', () => {
  it('parses a stored draft, active screen and server columns', () => {
    const parsed = parseScreenerPrefs({
      draft: {
        schemaVersion: 1,
        universe: { kind: 'list', id: 'sp500' },
        filter: { op: 'and', rules: [{ field: 'rsi14', op: '<', value: 30 }] },
        sort: { field: 'rsi14', dir: 'asc' },
      },
      activeScreenId: 'abc',
      serverColumns: ['rsi14', 'name', 'bogus', 'perf1m'],
    });
    expect(parsed.draft?.universe).toEqual({ kind: 'list', id: 'sp500' });
    expect(parsed.draft?.filter?.rules).toHaveLength(1);
    expect(parsed.draft?.sort).toEqual({ field: 'rsi14', dir: 'asc' });
    expect(parsed.activeScreenId).toBe('abc');
    // Canonical order, unknown ids dropped.
    expect(parsed.serverColumns).toEqual(['name', 'perf1m', 'rsi14']);
  });

  it('drops a draft without a usable universe and a malformed filter', () => {
    expect(
      parseScreenerPrefs({ draft: { universe: { kind: 'class', cls: 'bonds' } } }).draft,
    ).toBeUndefined();
    const parsed = parseScreenerPrefs({
      draft: {
        universe: { kind: 'class', cls: 'etfs' },
        filter: { op: 'xor', rules: [] },
        sort: { field: 1 },
      },
    });
    expect(parsed.draft?.filter).toBeNull();
    expect(parsed.draft?.sort.field).toBe('avgDollarVol30');
  });

  it('setUniverse / setTab keep the class tab and the draft universe in sync', () => {
    const s = () => useScreenerPrefs.getState();
    s().setUniverse({ kind: 'class', cls: 'crypto' });
    expect(s().tab).toBe('crypto');
    s().setUniverse({ kind: 'list', id: 'ndx100' });
    expect(s().tab).toBe('crypto');
    expect(s().draft.universe).toEqual({ kind: 'list', id: 'ndx100' });
    s().setTab('etfs');
    expect(s().draft.universe).toEqual({ kind: 'class', cls: 'etfs' });
  });

  it('draft edits reset the page; applySpec loads a saved screen', () => {
    const s = () => useScreenerPrefs.getState();
    useScreenerPrefs.setState({ page: 4 });
    s().setDraftSort({ field: 'mcap', dir: 'desc' });
    expect(s().page).toBe(0);
    useScreenerPrefs.setState({ page: 4 });
    s().applySpec(
      {
        schemaVersion: 1,
        universe: { kind: 'class', cls: 'stocks' },
        filter: { op: 'or', rules: [{ field: 'newHi52', op: '=', value: true }] },
        sort: { field: 'relVol', dir: 'desc' },
        columns: ['name', 'rsi14'],
      },
      'scr-1',
    );
    expect(s().activeScreenId).toBe('scr-1');
    expect(s().draft.filter?.op).toBe('or');
    expect(s().serverColumns).toEqual(['name', 'rsi14']);
    expect(s().page).toBe(0);
    s().toggleServerColumn('mcap');
    expect(s().serverColumns).toEqual(['name', 'rsi14', 'mcap']);
  });
});
