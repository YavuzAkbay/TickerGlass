import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removeWithUndo } from './actions';
import { useWatchlistStore } from './store';
import type { WatchlistItem } from './types';

const toasts = vi.hoisted(() => [] as string[]);
const undos = vi.hoisted(() => [] as (() => void)[]);
vi.mock('../ui/Toast', () => ({
  toast: (m: string) => toasts.push(m),
  actionToast: (_m: string, actions: { run: () => void }[]) => {
    undos.push(actions[0]!.run);
    return 1;
  },
}));

const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const st = () => useWatchlistStore.getState();
const syms = (id: string) =>
  st().lists[id]!.items.map((i) => (i.type === 'symbol' ? i.symbol : ''));

beforeEach(() => {
  toasts.length = 0;
  undos.length = 0;
  useWatchlistStore.setState({
    lists: {},
    pendingDeletes: [],
    flags: {},
    flagsDirty: {},
    seeded: false,
    lastUndo: null,
  });
});

describe('removeWithUndo', () => {
  it('flag list undo restores the original flag time (order unchanged)', () => {
    st().setFlag('AAPL', 'red');
    const at = '2020-01-01T00:00:00.000Z';
    useWatchlistStore.setState({ flags: { ...st().flags, AAPL: { color: 'red', at } } });
    removeWithUndo('flag:red', ['AAPL']);
    expect(st().flags.AAPL).toBeUndefined();
    undos[0]!();
    expect(st().flags.AAPL).toEqual({ color: 'red', at });
  });

  it('counts symbols the user already re-added as restored, with no error toast', () => {
    const id = st().createList('l', [S('A'), S('B'), S('C')]);
    removeWithUndo(id, ['A', 'B']);
    st().addSymbols(id, ['A']);
    undos[0]!();
    expect(syms(id).sort()).toEqual(['A', 'B', 'C']);
    expect(toasts).toEqual([]);
  });

  it('says so when the list was deleted meanwhile', () => {
    const id = st().createList('l', [S('A'), S('B')]);
    removeWithUndo(id, ['A']);
    st().deleteList(id);
    undos[0]!();
    expect(toasts).toEqual(['List no longer exists']);
  });
});
