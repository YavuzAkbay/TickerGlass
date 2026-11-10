import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_PREFS, parsePagePrefs, useWatchlistPagePrefs } from './pagePrefs';

describe('watchlist page view mode', () => {
  afterEach(() => useWatchlistPagePrefs.setState({ ...DEFAULT_PAGE_PREFS }));

  it('defaults to the table', () => {
    expect(DEFAULT_PAGE_PREFS.view).toBe('table');
  });

  it('parses table and heatmap, drops anything else', () => {
    expect(parsePagePrefs({ view: 'heatmap' }).view).toBe('heatmap');
    expect(parsePagePrefs({ view: 'table' }).view).toBe('table');
    expect(parsePagePrefs({ view: 'tiles' }).view).toBeUndefined();
    expect(parsePagePrefs({}).view).toBeUndefined();
  });

  it('setView switches the mode', () => {
    useWatchlistPagePrefs.getState().setView('heatmap');
    expect(useWatchlistPagePrefs.getState().view).toBe('heatmap');
  });

  it('is adopted from stored prefs without touching the layout', () => {
    useWatchlistPagePrefs.getState().adopt(parsePagePrefs({ view: 'heatmap' }));
    expect(useWatchlistPagePrefs.getState().view).toBe('heatmap');
    expect(useWatchlistPagePrefs.getState().columns).toEqual(DEFAULT_PAGE_PREFS.columns);
  });
});
