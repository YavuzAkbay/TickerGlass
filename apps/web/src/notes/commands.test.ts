import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commands } from '../commands/registry';
import { useUiStore } from '../store/ui';
import { registerNotesCommands } from './commands';
import { useNotesTarget } from './state';

let unregister: () => void;
beforeEach(() => {
  unregister = registerNotesCommands();
  useUiStore.setState({ navOpen: false, navSection: 'watchlist', screen: 'watchlists' });
});
afterEach(() => {
  unregister();
  useNotesTarget.setState({ target: null, scope: 'symbol', pendingFocus: false });
  useUiStore.setState({ screen: 'charts' });
});

describe('notes.openForSymbol', () => {
  it('opens (never closes) the Notes panel pinned to the symbol, leaving a screen', () => {
    commands.execute('notes.openForSymbol', { symbol: 'msft' });
    commands.execute('notes.openForSymbol', { symbol: 'msft' });
    expect(useUiStore.getState()).toMatchObject({
      navOpen: true,
      navSection: 'notes',
      screen: 'charts',
    });
    expect(useNotesTarget.getState()).toMatchObject({ target: 'MSFT', pendingFocus: true });
  });
  it('without a symbol follows the chart', () => {
    useNotesTarget.setState({ target: 'TSLA' });
    commands.execute('notes.openForSymbol');
    expect(useNotesTarget.getState().target).toBeNull();
  });
});
