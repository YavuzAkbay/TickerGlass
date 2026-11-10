import { describe, expect, it } from 'vitest';
import type { WatchlistItem } from '../../watchlist/types';
import { visibleSymbols } from './visibleSymbols';

const sym = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const sec = (id: string, collapsed = false): WatchlistItem => ({
  type: 'section',
  id,
  title: id,
  collapsed,
});

describe('visibleSymbols', () => {
  it('keeps everything without sections', () => {
    expect(visibleSymbols([sym('A'), sym('B')])).toEqual(['A', 'B']);
  });

  it('drops symbols under collapsed sections only', () => {
    const items = [sym('A'), sec('s1', true), sym('B'), sym('C'), sec('s2'), sym('D')];
    expect(visibleSymbols(items)).toEqual(['A', 'D']);
  });

  it('the local collapsed map overrides the legacy item flag', () => {
    const items = [sec('s1', true), sym('A'), sec('s2'), sym('B')];
    expect(visibleSymbols(items, { s1: false, s2: true })).toEqual(['A']);
    expect(visibleSymbols(items, {})).toEqual(['B']);
  });

  it('is empty for an empty list', () => {
    expect(visibleSymbols([])).toEqual([]);
  });
});
