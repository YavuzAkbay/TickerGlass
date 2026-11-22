import type { ClosedLot } from '@tickerglass/portfolio';
import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../api/portfolio';
import {
  addTags,
  draftFromEntry,
  draftToIn,
  filterEntries,
  entryR,
  filterOptions,
  lotsByOpenTx,
  MAX_TAGS,
} from './journalDraft';

const entry = (patch: Partial<JournalEntry>): JournalEntry => ({
  id: 'e',
  portfolioId: 'p',
  transactionId: null,
  symbol: null,
  noteId: null,
  setup: null,
  tags: [],
  stop: null,
  rMultiple: null,
  hasScreenshot: false,
  revision: 1,
  createdAt: '',
  updatedAt: '',
  ...patch,
});

describe('addTags', () => {
  it('splits on commas, trims and dedupes', () => {
    expect(addTags(['a'], ' b, a ,, c ')).toEqual(['a', 'b', 'c']);
  });
  it('caps the count and the length', () => {
    const many = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(addTags(many, 'extra')).toEqual(many);
    expect(addTags([], 'x'.repeat(60))[0]).toHaveLength(40);
  });
});

describe('draftToIn', () => {
  it('round-trips an entry', () => {
    const e = entry({
      transactionId: 't',
      symbol: 'AAPL',
      setup: 'Breakout',
      tags: ['a'],
      stop: 140.5,
      rMultiple: 2,
    });
    const r = draftToIn(draftFromEntry(e), 'n1');
    expect(r).toEqual({
      ok: true,
      value: {
        transactionId: 't',
        symbol: 'AAPL',
        noteId: 'n1',
        setup: 'Breakout',
        tags: ['a'],
        stop: 140.5,
        rMultiple: 2,
      },
    });
  });
  it('blank fields become null; symbols are upper-cased', () => {
    const r = draftToIn({ ...draftFromEntry(entry({})), symbol: ' msft ', setup: '  ' }, null);
    expect(r.ok && r.value).toMatchObject({
      symbol: 'MSFT',
      setup: null,
      stop: null,
      rMultiple: null,
    });
  });
  it('rejects a bad stop or override', () => {
    const base = draftFromEntry(entry({}));
    const r = draftToIn({ ...base, stop: '-1', rMultiple: 'x' }, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['rMultiple', 'stop']);
    expect(draftToIn({ ...base, rMultiple: '-1.5' }, null).ok).toBe(true);
  });
});

describe('filters', () => {
  const list = [
    entry({ id: 'a', tags: ['gap', 'earnings'], setup: 'Breakout' }),
    entry({ id: 'b', tags: ['gap'], setup: 'Pullback' }),
    entry({ id: 'c', tags: [], setup: null }),
  ];
  it('filters by tag or setup', () => {
    expect(filterEntries(list, 'tag:gap').map((e) => e.id)).toEqual(['a', 'b']);
    expect(filterEntries(list, 'setup:Pullback').map((e) => e.id)).toEqual(['b']);
    expect(filterEntries(list, '')).toHaveLength(3);
  });
  it('lists the options sorted', () => {
    expect(filterOptions(list)).toEqual({
      tags: ['earnings', 'gap'],
      setups: ['Breakout', 'Pullback'],
    });
  });
});

describe('entryR', () => {
  const lot = (openTxId: string, quantity: number, openPrice: number, pnl: number) =>
    ({
      symbol: 'X',
      currency: 'USD',
      openTxId,
      closeTxId: 'c',
      quantity,
      openPrice,
      closePrice: 0,
      pnl,
      openTime: '',
      closeTime: '',
      splitFactor: 1,
    }) as unknown as ClosedLot;
  const lots = lotsByOpenTx([lot('t1', 10, 100, 200), lot('t1', 10, 100, 100), lot('t2', 1, 5, 1)]);

  it('groups lots by opening transaction', () => {
    expect(lots.get('t1')).toHaveLength(2);
  });
  it('computes R from the stop and the linked lots', () => {
    // pnl 300, risk 20 * |100 - 95| = 100 -> 3R
    expect(entryR(95, null, 't1', lots)).toBeCloseTo(3);
  });
  it('the override wins; no stop or no trade gives null', () => {
    expect(entryR(95, -1, 't1', lots)).toBe(-1);
    expect(entryR(null, null, 't1', lots)).toBeNull();
    expect(entryR(95, null, null, lots)).toBeNull();
    expect(entryR(95, null, 'nope', lots)).toBeNull();
  });
});
