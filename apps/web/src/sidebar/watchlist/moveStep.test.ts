import { beforeEach, describe, expect, it } from 'vitest';
import { useWatchlistStore } from '../../watchlist/store';
import type { WatchlistItem } from '../../watchlist/types';
import { moveStepTarget } from './moveStep';

const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const SEC = (id: string): WatchlistItem => ({ type: 'section', id, title: id, collapsed: false });
const names = (items: WatchlistItem[]) =>
  items.map((i) => (i.type === 'symbol' ? i.symbol : `#${i.id}`));

function step(items: WatchlistItem[], from: number, dir: 1 | -1): string[] {
  const st = useWatchlistStore.getState();
  const id = st.createList('t', items);
  const to = moveStepTarget(useWatchlistStore.getState().lists[id]!.items, from, dir);
  if (to !== null) useWatchlistStore.getState().moveItem(id, from, to);
  return names(useWatchlistStore.getState().lists[id]!.items);
}

describe('moveStepTarget', () => {
  beforeEach(() => useWatchlistStore.setState({ lists: {} }));

  it('moves a symbol one place', () => {
    expect(step([S('A'), S('B'), S('C')], 1, -1)).toEqual(['B', 'A', 'C']);
    expect(step([S('A'), S('B'), S('C')], 1, 1)).toEqual(['A', 'C', 'B']);
  });
  it('is null at the ends', () => {
    expect(moveStepTarget([S('A'), S('B')], 0, -1)).toBeNull();
    expect(moveStepTarget([S('A'), S('B')], 1, 1)).toBeNull();
  });
  it('moves a section block over its neighbour block', () => {
    const items = [SEC('s1'), S('A'), SEC('s2'), S('B'), S('C')];
    expect(step(items, 0, 1)).toEqual(['#s2', 'B', 'C', '#s1', 'A']);
    expect(step(items, 2, -1)).toEqual(['#s2', 'B', 'C', '#s1', 'A']);
  });
});
