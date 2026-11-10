import { describe, expect, it } from 'vitest';
import { MAX_WATCHLIST_ITEMS } from './model';
import { mergeLists, type ListContent } from './merge';
import type { WatchlistItem } from './types';

const S = (symbol: string): WatchlistItem => ({ type: 'symbol', symbol });
const SEC = (id: string, title = id): WatchlistItem => ({ type: 'section', id, title });
const L = (name: string, ...items: WatchlistItem[]): ListContent => ({ name, items });
const ids = (items: WatchlistItem[]) =>
  items.map((i) => (i.type === 'symbol' ? i.symbol : `#${i.id}`));

function merged(base: ListContent, mine: ListContent, theirs: ListContent) {
  const r = mergeLists(base, mine, theirs);
  if (!r.ok) throw new Error(`conflict: ${r.reasons.join('; ')}`);
  return { name: r.name, items: ids(r.items) };
}

describe('mergeLists', () => {
  const base = L('L', S('A'), S('B'), S('C'));

  it('unions adds from both sides: mine order, their new items after their predecessor', () => {
    expect(
      merged(base, L('L', S('A'), S('M'), S('B'), S('C')), L('L', S('A'), S('B'), S('C'), S('T')))
        .items,
    ).toEqual(['A', 'M', 'B', 'C', 'T']);
  });

  it('places their new items after their nearest kept predecessor, in their section', () => {
    const b = L('L', SEC('s'), S('A'), SEC('t'), S('B'));
    // Their adds in the first section stay there, not at the end (the last section).
    expect(
      merged(
        b,
        L('L', SEC('s'), S('A'), SEC('t'), S('B'), S('M')),
        L('L', SEC('s'), S('A'), S('T1'), S('T2'), SEC('t'), S('B')),
      ).items,
    ).toEqual(['#s', 'A', 'T1', 'T2', '#t', 'B', 'M']);
    // Predecessor removed by me: the next kept one before it (here the section header).
    expect(
      merged(
        b,
        L('L', SEC('s'), SEC('t'), S('B')),
        L('L', SEC('s'), S('A'), S('T'), SEC('t'), S('B')),
      ).items,
    ).toEqual(['#s', 'T', '#t', 'B']);
    // Nothing kept before it in theirs: first.
    expect(
      merged(b, L('L', SEC('s'), S('A'), SEC('t'), S('B')), L('L', S('T'), ...b.items)).items,
    ).toEqual(['T', '#s', 'A', '#t', 'B']);
    // A new section of theirs brings its new items along, in order, after my reorder.
    expect(
      merged(
        b,
        L('L', SEC('t'), S('B'), SEC('s'), S('A')),
        L('L', SEC('s'), S('A'), SEC('u'), S('U1'), S('U2'), SEC('t'), S('B')),
      ).items,
    ).toEqual(['#t', 'B', '#s', 'A', '#u', 'U1', 'U2']);
  });

  it('applies removals from both sides', () => {
    expect(merged(base, L('L', S('A'), S('C')), L('L', S('A'), S('B'))).items).toEqual(['A']);
  });

  it('a removal wins over an untouched copy on the other side', () => {
    expect(merged(base, L('L', S('A'), S('B'), S('C')), L('L', S('B'), S('C'))).items).toEqual([
      'B',
      'C',
    ]);
    expect(merged(base, L('L', S('B'), S('C')), L('L', S('A'), S('B'), S('C'))).items).toEqual([
      'B',
      'C',
    ]);
  });

  it('the same symbol added on both sides appears once', () => {
    expect(
      merged(base, L('L', S('A'), S('B'), S('C'), S('N')), L('L', S('N'), S('A'), S('B'), S('C')))
        .items,
    ).toEqual(['A', 'B', 'C', 'N']);
  });

  it('keeps my order when only I reordered, and takes a one-sided rename', () => {
    const r = merged(base, L('L', S('C'), S('B'), S('A')), L('Renamed', S('A'), S('B'), S('C')));
    expect(r).toEqual({ name: 'Renamed', items: ['C', 'B', 'A'] });
    expect(
      merged(base, L('Mine', S('A'), S('B'), S('C')), L('L', S('A'), S('B'), S('C'))).name,
    ).toBe('Mine');
  });

  it('merges one-sided section renames and section adds', () => {
    const b = L('L', SEC('s', 'Old'), S('A'));
    const r = mergeLists(
      b,
      L('L', SEC('s', 'Mine'), S('A')),
      L('L', SEC('s', 'Old'), S('A'), SEC('t', 'New')),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0]).toMatchObject({ title: 'Mine' });
      expect(ids(r.items)).toEqual(['#s', 'A', '#t']);
    }
  });

  it('conflicts when the name or a section title was changed differently', () => {
    const r1 = mergeLists(base, L('Mine', ...base.items), L('Theirs', ...base.items));
    expect(r1.ok).toBe(false);
    const b = L('L', SEC('s', 'Old'));
    const r2 = mergeLists(b, L('L', SEC('s', 'X')), L('L', SEC('s', 'Y')));
    expect(r2).toMatchObject({ ok: false });
    if (!r2.ok) expect(r2.reasons[0]).toContain('renamed differently');
  });

  it('conflicts when a section was renamed on one side and removed on the other', () => {
    const b = L('L', SEC('s', 'Old'), S('A'));
    expect(mergeLists(b, L('L', SEC('s', 'New'), S('A')), L('L', S('A'))).ok).toBe(false);
    // removed on one side, untouched on the other: just removed
    expect(mergeLists(b, L('L', SEC('s', 'Old'), S('A')), L('L', S('A'))).ok).toBe(true);
  });

  it('conflicts when the merge would exceed the item cap', () => {
    const b = L('L');
    const many = (p: string) =>
      Array.from({ length: MAX_WATCHLIST_ITEMS - 10 }, (_, i) => S(`${p}${i}`));
    expect(mergeLists(b, L('L', ...many('M')), L('L', ...many('T'))).ok).toBe(false);
  });
});
