import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_PREFS,
  MAX_VIEWS,
  parsePagePrefs,
  parseViews,
  pruneViews,
  useWatchlistPagePrefs,
  type ColumnView,
} from './pagePrefs';
import type { ColumnId, SortSpec } from '../types';

const get = () => useWatchlistPagePrefs.getState();
/** Seed the global layout (and so what is shown). */
const seed = (columns: ColumnId[], sort: SortSpec | null = null) =>
  useWatchlistPagePrefs.setState({ columns, sort, global: { columns, sort } });

describe('parsePagePrefs', () => {
  it('keeps only page-eligible columns, in the stored (user) order, without repeats', () => {
    const out = parsePagePrefs({ columns: ['trend', 'name', 'bogus', 'volume', 'name'] });
    expect(out.columns).toEqual(['trend', 'name', 'volume']);
  });

  it('validates the sort spec', () => {
    expect(parsePagePrefs({ sort: { key: 'name', dir: 'desc' } }).sort).toEqual({
      key: 'name',
      dir: 'desc',
    });
    expect(parsePagePrefs({ sort: { key: 'dayRange', dir: 'desc' } }).sort).toBeUndefined();
    expect(parsePagePrefs({ sort: { key: 'last', dir: 'sideways' } }).sort).toBeUndefined();
    expect(parsePagePrefs({ sort: null }).sort).toBeNull();
  });

  it('validates booleans and density', () => {
    expect(parsePagePrefs({ detailOpen: false, density: 'compact' })).toEqual({
      detailOpen: false,
      density: 'compact',
    });
    expect(parsePagePrefs({ density: 'huge' })).toEqual({});
    expect(parsePagePrefs('nope')).toEqual({});
  });
});

describe('useWatchlistPagePrefs', () => {
  beforeEach(() => {
    useWatchlistPagePrefs.setState({ ...DEFAULT_PAGE_PREFS });
  });

  it('hiding a sorted column clears the sort', () => {
    seed(['name', 'last', 'volume'], { key: 'last', dir: 'desc' });
    useWatchlistPagePrefs.getState().toggleColumn('last');
    const s = useWatchlistPagePrefs.getState();
    expect(s.columns).toEqual(['name', 'volume']);
    expect(s.sort).toBeNull();
  });

  it('hiding an unsorted column keeps the sort', () => {
    seed(['name', 'last', 'volume'], { key: 'last', dir: 'desc' });
    useWatchlistPagePrefs.getState().toggleColumn('volume');
    const s = useWatchlistPagePrefs.getState();
    expect(s.columns).toEqual(['name', 'last']);
    expect(s.sort).toEqual({ key: 'last', dir: 'desc' });
  });

  it('re-adding a column puts it at its canonical place among the shown ones', () => {
    seed(['name', 'trend']);
    useWatchlistPagePrefs.getState().toggleColumn('volume');
    expect(useWatchlistPagePrefs.getState().columns).toEqual(['name', 'volume', 'trend']);
  });

  it('keeps a user-reordered layout when toggling another column', () => {
    seed(['trend', 'last', 'name']);
    useWatchlistPagePrefs.getState().toggleColumn('volume');
    // After the last shown column that precedes it canonically; nothing else moves.
    expect(useWatchlistPagePrefs.getState().columns).toEqual(['trend', 'last', 'name', 'volume']);
  });
});

describe('parsePagePrefs: widths, presets, per-list views', () => {
  it('parses the new fields and leaves absent ones out', () => {
    const out = parsePagePrefs({
      widths: { name: 180, bogus: 5 },
      presets: [{ name: 'Mine', columns: ['last', 'open'] }],
      perList: true,
      views: { l1: { columns: ['last'], sort: { key: 'last', dir: 'asc' } } },
    });
    expect(out).toEqual({
      widths: { name: 180 },
      presets: [{ name: 'Mine', columns: ['last', 'open'], widths: {} }],
      perList: true,
      views: { l1: { columns: ['last'], sort: { key: 'last', dir: 'asc' } } },
    });
    expect(parsePagePrefs({ perList: 'yes', widths: undefined })).toEqual({});
  });

  it('views: drops invalid entries, clears a sort on a hidden column, keeps the newest', () => {
    const views = parseViews({
      '': { columns: ['last'], sort: null },
      bad: 'x',
      nocols: { sort: null },
      hidden: { columns: ['last'], sort: { key: 'volume', dir: 'desc' } },
      symbolSort: { columns: ['last', 'bogus'], sort: { key: 'symbol', dir: 'asc' } },
      badSort: { columns: ['last'], sort: { key: 'dayRange', dir: 'asc' } },
    });
    expect(Object.keys(views)).toEqual(['hidden', 'symbolSort', 'badSort']);
    expect(views.hidden!.sort).toBeNull();
    expect(views.symbolSort).toEqual({ columns: ['last'], sort: { key: 'symbol', dir: 'asc' } });
    expect(views.badSort!.sort).toBeNull();

    const many = Object.fromEntries(
      Array.from({ length: MAX_VIEWS + 10 }, (_, i) => [
        `l${i}`,
        { columns: ['last'], sort: null },
      ]),
    );
    const kept = Object.keys(parseViews(many));
    expect(kept).toHaveLength(MAX_VIEWS);
    expect(kept.at(-1)).toBe(`l${MAX_VIEWS + 9}`);
  });

  it('pruneViews drops deleted lists but keeps flag lists', () => {
    const v: ColumnView = { columns: ['last'], sort: null };
    const out = pruneViews({ a: v, gone: v, 'flag:red': v, 'flag:nope': v }, ['a', 'b']);
    expect(Object.keys(out)).toEqual(['a', 'flag:red']);
  });
});

describe('per-list views', () => {
  beforeEach(() => {
    useWatchlistPagePrefs.setState({ ...DEFAULT_PAGE_PREFS, activeViewId: null });
  });

  it('records nothing in views while the option is off; edits are global', () => {
    get().enterList('a');
    get().toggleColumn('open');
    expect(get().views).toEqual({});
    expect(get().global.columns).toContain('open');
  });

  it('records columns and sort under the current list and restores them on re-entry', () => {
    get().setPerList(true);
    get().enterList('a');
    get().setColumns(['name', 'last']);
    get().setSort({ key: 'last', dir: 'desc' });
    expect(get().views.a).toEqual({
      columns: ['name', 'last'],
      sort: { key: 'last', dir: 'desc' },
    });

    // A list without a view shows the global layout, not the previous list's.
    get().enterList('b');
    expect(get().columns).toEqual(DEFAULT_PAGE_PREFS.global.columns);
    expect(get().sort).toBeNull();
    get().setColumns(['volume']);
    get().setSort(null);
    expect(get().views.b).toEqual({ columns: ['volume'], sort: null });

    get().enterList('a');
    expect(get().columns).toEqual(['name', 'last']);
    expect(get().sort).toEqual({ key: 'last', dir: 'desc' });
    get().enterList('b');
    expect(get().columns).toEqual(['volume']);
    expect(get().sort).toBeNull();
  });

  it('never writes a list view into the global layout (what syncs as columns/sort)', () => {
    get().setPerList(true);
    get().enterList('a');
    get().setColumns(['last']);
    get().setSort({ key: 'last', dir: 'asc' });
    get().enterList('b');
    get().setColumns(['volume']);
    expect(get().global).toEqual(DEFAULT_PAGE_PREFS.global);
    get().enterList(null); // leaving the page
    expect(get().columns).toEqual(DEFAULT_PAGE_PREFS.global.columns);
  });

  it('turning it off returns to the global layout and keeps the stored views', () => {
    get().enterList('a');
    get().setColumns(['last']); // global
    get().setPerList(true);
    expect(get().columns).toEqual(['last']); // no view yet: the global one
    get().setColumns(['volume']); // a's view
    get().setPerList(false);
    expect(get().columns).toEqual(['last']);
    expect(get().views.a!.columns).toEqual(['volume']);
    get().setColumns(['open']);
    expect(get().global.columns).toEqual(['open']);
    expect(get().views.a!.columns).toEqual(['volume']);
    get().setPerList(true);
    expect(get().columns).toEqual(['volume']);
  });

  it('caps entries, newest kept', () => {
    get().setPerList(true);
    for (let i = 0; i < MAX_VIEWS + 5; i++) {
      get().enterList(`l${i}`);
      get().setColumns(['last']);
    }
    const keys = Object.keys(get().views);
    expect(keys).toHaveLength(MAX_VIEWS);
    expect(keys.at(-1)).toBe(`l${MAX_VIEWS + 4}`);
    expect(keys).not.toContain('l0');
  });

  it('pruneViews action removes deleted lists only', () => {
    get().setPerList(true);
    get().enterList('a');
    get().setColumns(['last']);
    get().enterList('b');
    get().setColumns(['volume']);
    get().pruneViews(['b']);
    expect(Object.keys(get().views)).toEqual(['b']);
  });

  it('forgetViews removes just those lists and re-derives what is shown', () => {
    get().setPerList(true);
    get().enterList('a');
    get().setColumns(['last']);
    get().enterList('b');
    get().setColumns(['volume']);
    get().forgetViews(['b']);
    expect(Object.keys(get().views)).toEqual(['a']);
    expect(get().columns).toEqual(DEFAULT_PAGE_PREFS.global.columns);
  });

  it('adopt: stored columns/sort become the global layout; shown follows the view', () => {
    get().setPerList(true);
    get().enterList('a');
    get().setColumns(['last']);
    get().adopt({ columns: ['volume'], sort: null, views: {} });
    expect(get().global.columns).toEqual(['volume']);
    expect(get().columns).toEqual(['volume']); // a's view is gone
    get().adopt({ views: { a: { columns: ['open'], sort: null } } });
    expect(get().columns).toEqual(['open']);
    expect(get().global.columns).toEqual(['volume']);
  });
});

describe('column presets across surfaces', () => {
  beforeEach(() => {
    useWatchlistPagePrefs.setState({ ...DEFAULT_PAGE_PREFS, activeViewId: null });
  });

  it('saves with the surface it came from', () => {
    get().savePreset('Side', ['last', 'trend'], {}, 'sidebar');
    expect(get().presets[0]).toMatchObject({ name: 'Side', surface: 'sidebar' });
  });

  it('a sidebar preset without widths keeps the page widths and the Name column', () => {
    seed(['name', 'volume']);
    useWatchlistPagePrefs.setState({ widths: { name: 200, volume: 90 } });
    get().savePreset('Side', ['last', 'trend'], {}, 'sidebar');
    get().applyPreset(get().presets[0]!);
    expect(get().columns).toEqual(['name', 'last', 'trend']);
    expect(get().widths).toEqual({ name: 200, volume: 90 });
  });

  it('a sidebar preset does not add Name when the table hides it', () => {
    seed(['last', 'volume']);
    get().applyPreset({ name: 'x', columns: ['last', 'trend'], widths: {}, surface: 'sidebar' });
    expect(get().columns).toEqual(['last', 'trend']);
  });

  it('a page preset (any widths) replaces the widths; without the tag Name is not forced', () => {
    seed(['name', 'volume']);
    useWatchlistPagePrefs.setState({ widths: { name: 200 } });
    get().applyPreset({ name: 'x', columns: ['last'], widths: { last: 80 } });
    expect(get().columns).toEqual(['last']);
    expect(get().widths).toEqual({ last: 80 });
  });
});

describe('page column layout actions', () => {
  beforeEach(() => {
    useWatchlistPagePrefs.setState({ ...DEFAULT_PAGE_PREFS, activeViewId: null });
  });

  it('moveColumn reorders and keeps the sort', () => {
    seed(['name', 'last', 'volume'], { key: 'volume', dir: 'asc' });
    get().moveColumn('volume', 0);
    expect(get().columns).toEqual(['volume', 'name', 'last']);
    expect(get().sort).toEqual({ key: 'volume', dir: 'asc' });
    const before = get().columns;
    get().moveColumn('volume', 0);
    expect(get().columns).toBe(before);
  });

  it('widths clamp, reset per column and all at once', () => {
    get().setWidth('name', 10);
    get().setWidth('last', 123.4);
    expect(get().widths).toEqual({ name: 44, last: 123 });
    get().setWidth('name', null);
    expect(get().widths).toEqual({ last: 123 });
    get().resetWidths();
    expect(get().widths).toEqual({});
  });

  it('saves a preset with the widths of its columns, replaces the same name, applies it', () => {
    expect(get().savePreset('Wide', ['name', 'last'], { name: 200, volume: 90 })).toBe(true);
    expect(get().presets).toEqual([
      { name: 'Wide', columns: ['name', 'last'], widths: { name: 200 }, surface: 'page' },
    ]);
    expect(get().savePreset('wide', ['last'])).toBe(true);
    expect(get().presets).toHaveLength(1);
    get().savePreset('Wide2', ['volume', 'name'], { volume: 70 });
    get().applyPreset(get().presets[1]!);
    expect(get().columns).toEqual(['volume', 'name']);
    expect(get().widths).toEqual({ volume: 70 });
    get().deletePreset('Wide2');
    expect(get().presets.map((p) => p.name)).toEqual(['wide']);
  });

  it('applying a preset clears a sort on a column it hides', () => {
    seed(get().columns, { key: 'volume', dir: 'desc' });
    get().applyPreset({ name: 'x', columns: ['last'], widths: {} });
    expect(get().sort).toBeNull();
  });
});
