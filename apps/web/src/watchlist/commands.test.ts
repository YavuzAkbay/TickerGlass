import { beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '../commands/registry';
import { useChartView } from '../store/chartView';
import { useQuoteStore } from '../quotes/store';
import { emptyQuote } from '../quotes/merge';
import { importText, registerWatchlistCommands } from './commands';
import { useWatchlistPrefs } from './prefs';
import { useWatchlistStore } from './store';

const toasts = vi.hoisted(() => [] as string[]);
const actionToasts = vi.hoisted(
  () => [] as { message: string; actions: { label: string; run: () => void }[] }[],
);
vi.mock('../ui/Toast', () => ({
  toast: (m: string) => toasts.push(m),
  actionToast: (message: string, actions: { label: string; run: () => void }[]) => {
    actionToasts.push({ message, actions });
    return 1;
  },
}));

beforeEach(() => {
  toasts.length = 0;
  actionToasts.length = 0;
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

describe('watchlist.remove', () => {
  it('removes with an Undo toast that puts the symbol back', () => {
    const off = registerWatchlistCommands();
    const st = useWatchlistStore.getState();
    const id = st.createList('l', [
      { type: 'symbol', symbol: 'A' },
      { type: 'symbol', symbol: 'B' },
    ]);
    useWatchlistPrefs.setState({ activeId: id });
    commands.execute('watchlist.remove', 'A');
    const syms = () =>
      useWatchlistStore
        .getState()
        .lists[id]!.items.map((i) => (i.type === 'symbol' ? i.symbol : ''));
    expect(syms()).toEqual(['B']);
    expect(actionToasts).toHaveLength(1);
    expect(actionToasts[0]!.message).toBe('Removed A');
    expect(actionToasts[0]!.actions.map((a) => a.label)).toEqual(['Undo']);
    actionToasts[0]!.actions[0]!.run();
    expect(syms()).toEqual(['A', 'B']);
    off();
  });

  it('flag lists: removing a flag is undoable too', () => {
    const off = registerWatchlistCommands();
    useWatchlistStore.getState().setFlag('AAPL', 'red');
    useWatchlistPrefs.setState({ activeId: 'flag:red' });
    commands.execute('watchlist.remove', 'AAPL');
    expect(useWatchlistStore.getState().flags.AAPL).toBeUndefined();
    actionToasts[0]!.actions[0]!.run();
    expect(useWatchlistStore.getState().flags.AAPL?.color).toBe('red');
    off();
  });
});

describe('next/previous symbol follow the displayed order', () => {
  it('uses the sort and skips collapsed sections', () => {
    const set: string[] = [];
    const off = [
      registerWatchlistCommands(),
      commands.register([
        {
          id: 'chart.setSymbol',
          title: 'x',
          category: 'x',
          hidden: true,
          run: (a) => void set.push(String(a)),
        },
      ]),
    ];
    const S = (symbol: string) => ({ type: 'symbol' as const, symbol });
    const id = useWatchlistStore
      .getState()
      .createList('l', [
        S('A'),
        S('B'),
        { type: 'section', id: 's1', title: 's1' },
        S('C'),
        S('D'),
        { type: 'section', id: 's2', title: 's2' },
        S('E'),
      ]);
    useQuoteStore.setState({
      quotes: {
        A: { ...emptyQuote('A'), last: 1 },
        B: { ...emptyQuote('B'), last: 2 },
        C: { ...emptyQuote('C'), last: 3 },
        D: { ...emptyQuote('D'), last: 4 },
        E: { ...emptyQuote('E'), last: 5 },
      },
    });
    useWatchlistPrefs.setState({
      activeId: id,
      sort: { key: 'last', dir: 'desc' },
      columns: ['last'],
      collapsed: { s1: true },
    });
    useChartView.setState({ symbol: 'B' });
    // displayed: B A | (C D hidden) | E
    commands.execute('watchlist.next');
    commands.execute('watchlist.prev');
    expect(set).toEqual(['A']); // prev of the first stays put
    useChartView.setState({ symbol: 'A' });
    commands.execute('watchlist.next');
    expect(set.at(-1)).toBe('E');
    useWatchlistPrefs.setState({ sort: null, collapsed: {} });
    useChartView.setState({ symbol: 'B' });
    commands.execute('watchlist.next');
    expect(set.at(-1)).toBe('C');
    off.forEach((f) => f());
  });
});

describe('importText', () => {
  it('creates a list from pasted symbols and reports unmapped ones and duplicates', () => {
    expect(importText('aapl msft, EURONEXT:AIR\nFOO:BAR AAPL')).toBe(true);
    const lists = Object.values(useWatchlistStore.getState().lists);
    expect(lists).toHaveLength(1);
    expect(lists[0]!.items).toEqual([
      { type: 'symbol', symbol: 'AAPL' },
      { type: 'symbol', symbol: 'MSFT' },
    ]);
    expect(toasts.at(-1)).toBe(
      'Imported 2 symbols; 2 not imported (unknown exchange): EURONEXT:AIR, FOO:BAR; 1 duplicate skipped',
    );
  });

  it('refuses text without importable symbols and creates no list', () => {
    expect(importText('FOO:BAR')).toBe(false);
    expect(Object.keys(useWatchlistStore.getState().lists)).toEqual([]);
    expect(toasts.at(-1)).toContain('No symbols found');
    expect(toasts.at(-1)).toContain('FOO:BAR');
  });
});
