import { beforeEach, describe, expect, it } from 'vitest';
import { addDesk, MAX_DESKS, parseDesks, removeDesk, updateDesk, useDesks } from './store';

describe('desks', () => {
  beforeEach(() => useDesks.setState({ desks: [], activeId: null }));

  it('adds, activates, renames and removes desks', () => {
    const d = addDesk({
      name: 'Morning scan',
      layoutId: 'L1',
      watchlistId: 'W1',
      navSection: 'watchlist',
    })!;
    expect(useDesks.getState()).toMatchObject({
      activeId: d.id,
      desks: [{ name: 'Morning scan' }],
    });
    updateDesk(d.id, { name: 'Crypto', navSection: 'timeline' });
    expect(useDesks.getState().desks[0]).toMatchObject({ name: 'Crypto', navSection: 'timeline' });
    removeDesk(d.id);
    expect(useDesks.getState()).toEqual(expect.objectContaining({ desks: [], activeId: null }));
  });

  it('caps the number of desks', () => {
    for (let i = 0; i < MAX_DESKS; i++)
      addDesk({ name: `D${i}`, layoutId: null, watchlistId: null, navSection: 'watchlist' });
    expect(
      addDesk({ name: 'one more', layoutId: null, watchlistId: null, navSection: 'notes' }),
    ).toBeNull();
  });

  it('parses stored desks defensively', () => {
    const out = parseDesks({
      activeId: 'gone',
      desks: [
        { id: 'a', name: 'Ok', layoutId: 5, watchlistId: 'w', navSection: 'news' },
        { id: 'b', name: '  ' },
        'junk',
      ],
    });
    expect(out).toEqual({
      desks: [{ id: 'a', name: 'Ok', layoutId: null, watchlistId: 'w', navSection: 'watchlist' }],
      activeId: null,
    });
  });
});
