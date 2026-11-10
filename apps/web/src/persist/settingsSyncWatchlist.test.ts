import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_PREFS, useWatchlistPagePrefs } from '../watchlist/page/pagePrefs';
import { DEFAULT_PREFS, useWatchlistPrefs } from '../watchlist/prefs';
import { SETTING_DEFS } from './settingsSync';

const def = (key: string) => SETTING_DEFS.find((d) => d.key === key)!;

beforeEach(() => {
  useWatchlistPrefs.setState({ ...DEFAULT_PREFS, collapsed: {} });
  useWatchlistPagePrefs.setState({ ...DEFAULT_PAGE_PREFS });
});

describe('watchlist.prefs setting', () => {
  it('syncs columns and sort, not the active list or collapsed sections', () => {
    useWatchlistPrefs.setState({
      activeId: 'abc',
      columns: ['last'],
      sort: { key: 'last', dir: 'asc' },
      collapsed: { s: true },
    });
    expect(def('watchlist.prefs').read()).toEqual({
      columns: ['last'],
      sort: { key: 'last', dir: 'asc' },
    });
  });

  it('keeps the local active list when the server value (older clients) has one', () => {
    useWatchlistPrefs.setState({ activeId: 'mine' });
    def('watchlist.prefs').write({ activeId: 'theirs', columns: ['volume'], sort: null });
    expect(useWatchlistPrefs.getState()).toMatchObject({ activeId: 'mine', columns: ['volume'] });
  });
});

describe('watchlist.page.prefs setting', () => {
  it('syncs columns, sort and density; the detail pane toggle stays local', () => {
    useWatchlistPagePrefs.setState({
      columns: ['name', 'last'],
      sort: { key: 'name', dir: 'desc' },
      global: { columns: ['name', 'last'], sort: { key: 'name', dir: 'desc' } },
      density: 'compact',
      detailOpen: false,
    });
    expect(def('watchlist.page.prefs').read()).toEqual({
      columns: ['name', 'last'],
      sort: { key: 'name', dir: 'desc' },
      density: 'compact',
      widths: {},
      presets: [],
      perList: false,
      views: {},
    });
    def('watchlist.page.prefs').write({ columns: ['last'], density: 'cozy', detailOpen: true });
    expect(useWatchlistPagePrefs.getState()).toMatchObject({
      columns: ['last'],
      density: 'cozy',
      detailOpen: false,
    });
  });

  it('a list switch with per-list on does not change the synced columns/sort', () => {
    const st = useWatchlistPagePrefs.getState();
    st.setPerList(true);
    st.enterList('a');
    st.setColumns(['last']);
    st.enterList('b');
    const read = def('watchlist.page.prefs').read() as Record<string, unknown>;
    expect(read.columns).toEqual(DEFAULT_PAGE_PREFS.global.columns);
    expect(read.sort).toBeNull();
    expect(read.views).toEqual({ a: { columns: ['last'], sort: null } });
    let n = 0;
    const off = def('watchlist.page.prefs').subscribe(() => n++);
    useWatchlistPagePrefs.getState().enterList('a'); // only the shown view changes
    off();
    expect(JSON.stringify(def('watchlist.page.prefs').read())).toBe(JSON.stringify(read));
  });

  it('syncs widths, presets, the per-list switch and views', () => {
    const synced = {
      widths: { name: 150 },
      presets: [{ name: 'Mine', columns: ['last', 'open'], widths: {} }],
      perList: true,
      views: { l1: { columns: ['last'], sort: null } },
    };
    def('watchlist.page.prefs').write({ columns: ['last'], ...synced });
    expect(useWatchlistPagePrefs.getState()).toMatchObject(synced);
    expect(def('watchlist.page.prefs').read()).toMatchObject(synced);
  });

  it('ignores malformed layout fields and keeps the local ones', () => {
    useWatchlistPagePrefs.setState({ widths: { last: 90 }, perList: true });
    def('watchlist.page.prefs').write({
      widths: 'x',
      presets: 'y',
      views: [1],
      perList: 'no',
      columns: ['volume', 'bogus', 'volume'],
    });
    const s = useWatchlistPagePrefs.getState();
    expect(s.columns).toEqual(['volume']);
    expect(s.presets).toEqual([]);
    expect(s.views).toEqual({});
    expect(s.widths).toEqual({});
    expect(s.perList).toBe(true);
  });

  it('an older client value without the new fields leaves them alone', () => {
    useWatchlistPagePrefs.setState({ widths: { last: 90 }, perList: true });
    def('watchlist.page.prefs').write({ columns: ['last'], sort: null, density: 'cozy' });
    expect(useWatchlistPagePrefs.getState()).toMatchObject({ widths: { last: 90 }, perList: true });
  });

  it('notifies subscribers when the page prefs change', () => {
    let n = 0;
    const off = def('watchlist.page.prefs').subscribe(() => n++);
    useWatchlistPagePrefs.getState().setDensity('compact');
    off();
    expect(n).toBe(1);
  });
});
