import { describe, expect, it } from 'vitest';
import { DEFAULT_HEATMAP_PREFS, parseHeatmapPrefs, useHeatmapPrefs } from './heatmapPrefs';
import { isViewMode } from './viewMode';

describe('parseHeatmapPrefs', () => {
  it('keeps valid metrics and grouping', () => {
    expect(
      parseHeatmapPrefs({ sizeBy: 'volume', colorBy: 'perf1m', watchlistGroup: 'sector' }),
    ).toEqual({ sizeBy: 'volume', colorBy: 'perf1m', watchlistGroup: 'sector' });
  });

  it('drops unknown values so the defaults apply', () => {
    expect(parseHeatmapPrefs({ sizeBy: 'beta', colorBy: 7, watchlistGroup: 'industry' })).toEqual(
      {},
    );
    expect(parseHeatmapPrefs('nope')).toEqual({});
    expect(parseHeatmapPrefs(null)).toEqual({});
  });

  it('defaults to market cap, 1-day change and no grouping', () => {
    expect(DEFAULT_HEATMAP_PREFS).toEqual({
      sizeBy: 'marketCap',
      colorBy: 'change1d',
      watchlistGroup: 'none',
    });
  });

  it('the store setters change one field', () => {
    useHeatmapPrefs.getState().setSizeBy('equal');
    useHeatmapPrefs.getState().setColorBy('rsi');
    useHeatmapPrefs.getState().setWatchlistGroup('section');
    expect(useHeatmapPrefs.getState()).toMatchObject({
      sizeBy: 'equal',
      colorBy: 'rsi',
      watchlistGroup: 'section',
    });
    useHeatmapPrefs.setState(DEFAULT_HEATMAP_PREFS);
  });
});

describe('isViewMode', () => {
  it('accepts table and heatmap only', () => {
    expect(isViewMode('table')).toBe(true);
    expect(isViewMode('heatmap')).toBe(true);
    expect(isViewMode('grid')).toBe(false);
    expect(isViewMode(undefined)).toBe(false);
  });
});
