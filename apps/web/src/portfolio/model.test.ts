import { describe, expect, it } from 'vitest';
import type { Transaction } from '../api/portfolio';
import { filterActivity, importBatches, newestFirst, toTx } from './model';
import { tradePrefill } from './logTrade';

const tx = (patch: Partial<Transaction>): Transaction => ({
  id: 'x',
  portfolioId: 'p',
  kind: 'buy',
  time: '2025-01-02T15:00:00Z',
  symbol: 'AAPL',
  quantity: 1,
  price: 1,
  amount: null,
  fee: 0,
  currency: 'USD',
  note: 'n',
  source: 'manual',
  externalId: 'e',
  importBatch: null,
  seq: 1,
  revision: 3,
  createdAt: '2025-01-02T15:00:01Z',
  updatedAt: '',
  ...patch,
});

describe('toTx', () => {
  it('keeps only the ledger fields', () => {
    expect(toTx(tx({ id: 'a' }))).toEqual({
      id: 'a',
      kind: 'buy',
      time: '2025-01-02T15:00:00Z',
      symbol: 'AAPL',
      quantity: 1,
      price: 1,
      amount: null,
      fee: 0,
      currency: 'USD',
    });
  });
});

describe('newestFirst', () => {
  it('orders by time descending, then seq descending (not by id)', () => {
    const rows = [
      tx({ id: 'a', time: '2025-01-01T00:00:00Z' }),
      tx({ id: 'z', time: '2025-03-01T00:00:00Z', seq: 1 }),
      tx({ id: 'c', time: '2025-03-01T00:00:00Z', seq: 2 }),
    ];
    expect(newestFirst(rows).map((r) => r.id)).toEqual(['c', 'z', 'a']);
  });
});

describe('filterActivity', () => {
  const rows = [
    tx({ id: 'a', symbol: 'AAPL' }),
    tx({ id: 'b', symbol: 'MSFT', kind: 'sell' }),
    tx({ id: 'c', symbol: null, kind: 'cashIn' }),
  ];
  it('filters by symbol substring and kind', () => {
    expect(filterActivity(rows, { symbol: 'ms', kind: '' }).map((r) => r.id)).toEqual(['b']);
    expect(filterActivity(rows, { symbol: '', kind: 'cashIn' }).map((r) => r.id)).toEqual(['c']);
    expect(filterActivity(rows, { symbol: '', kind: '' })).toHaveLength(3);
  });
});

describe('importBatches', () => {
  it('derives batches from the rows, newest first', () => {
    const rows = [
      tx({ id: 'a', importBatch: 'b1', source: 'import:ibkr', createdAt: '2025-01-01T00:00:00Z' }),
      tx({ id: 'b', importBatch: 'b1', source: 'import:ibkr', createdAt: '2025-01-01T00:00:05Z' }),
      tx({
        id: 'c',
        importBatch: 'b2',
        source: 'import:schwab',
        createdAt: '2025-02-01T00:00:00Z',
      }),
      tx({ id: 'd' }),
    ];
    expect(importBatches(rows)).toEqual([
      { batch: 'b2', source: 'import:schwab', count: 1, createdAt: '2025-02-01T00:00:00Z' },
      { batch: 'b1', source: 'import:ibkr', count: 2, createdAt: '2025-01-01T00:00:05Z' },
    ]);
  });
});

describe('tradePrefill', () => {
  it('uses the symbol currency and live price', () => {
    expect(tradePrefill(' sap.de ', 'EUR', 123.4, 'USD')).toEqual({
      symbol: 'SAP.DE',
      currency: 'EUR',
      price: 123.4,
    });
  });
  it('converts a sub-unit quote currency to its major unit', () => {
    const vod = tradePrefill('VOD.L', 'GBp', 70, 'USD');
    expect(vod).toMatchObject({ symbol: 'VOD.L', currency: 'GBP' });
    expect(vod.price).toBeCloseTo(0.7);
    expect(tradePrefill('X.JO', 'ZAc', 1250, 'USD')).toMatchObject({
      currency: 'ZAR',
      price: 12.5,
    });
    expect(tradePrefill('X.TA', 'ILA', 500, 'USD')).toMatchObject({ currency: 'ILS', price: 5 });
    expect(tradePrefill('VOD.L', 'GBp', null, 'USD')).toEqual({
      symbol: 'VOD.L',
      currency: 'GBP',
      price: null,
    });
  });
  it('trims float noise from the live price', () => {
    expect(tradePrefill('GLSS', 'USD', 193.00653853790826, 'USD').price).toBe(193.0065);
    expect(tradePrefill('X', 'USD', 0.000012345678, 'USD').price).toBe(0.00001234568);
  });
  it('does not trust an unknown currency', () => {
    expect(tradePrefill('X', null, 5, 'EUR')).toEqual({
      symbol: 'X',
      currency: 'EUR',
      price: null,
    });
    expect(tradePrefill('X', 'USD', null, 'USD').price).toBeNull();
  });
});
