import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../commands/registry';
import { useChartView } from '../store/chartView';
import { registerWatchlistCommands } from './commands';
import { useWatchlistStore } from './store';

const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../ui/Toast', () => ({ toast: (m: string) => toasts.push(m) }));

beforeEach(() => {
  toasts.length = 0;
  useWatchlistStore.setState({
    lists: {},
    pendingDeletes: [],
    flags: {},
    flagsDirty: {},
    seeded: false,
  });
});

describe('watchlist.addSymbol', () => {
  it('refuses symbol expressions with a toast and adds nothing', () => {
    const off = registerWatchlistCommands();
    useChartView.setState({ symbol: 'AAPL/MSFT' });
    commands.execute('watchlist.addSymbol');
    expect(toasts).toEqual(["Symbol expressions can't be added to watchlists"]);
    expect(Object.keys(useWatchlistStore.getState().lists)).toEqual([]);
    off();
  });
});
