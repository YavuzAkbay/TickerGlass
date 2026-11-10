import { describe, expect, it } from 'vitest';
import type { WatchlistItem } from '../watchlist/types';
import { tilesOf } from './WatchlistHeatmap';

const sym = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const sec = (title: string, collapsed = false): WatchlistItem => ({
  type: 'section',
  id: title,
  title,
  collapsed,
});

describe('tilesOf', () => {
  it('tags each symbol with the section above it', () => {
    expect(tilesOf([sym('A'), sec('Tech'), sym('B'), sym('C'), sec('Energy'), sym('D')])).toEqual([
      { symbol: 'A', section: '' },
      { symbol: 'B', section: 'Tech' },
      { symbol: 'C', section: 'Tech' },
      { symbol: 'D', section: 'Energy' },
    ]);
  });

  it('ignores collapsed sections (their symbols stay on the map)', () => {
    expect(tilesOf([sec('Tech', true), sym('B')])).toEqual([{ symbol: 'B', section: 'Tech' }]);
  });

  it('drops repeated symbols and handles an empty list', () => {
    expect(tilesOf([sym('A'), sym('A')])).toHaveLength(1);
    expect(tilesOf([])).toEqual([]);
  });
});
