import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '../api/portfolio';
import {
  adjustSubunits,
  loadPerformanceData,
  MAX_DAILY_BARS,
  planBars,
  symbolCurrencies,
  toDailyCloses,
  type PerformanceData,
} from './barsPlan';

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
  note: null,
  source: 'manual',
  externalId: null,
  importBatch: null,
  seq: 1,
  revision: 1,
  createdAt: '',
  updatedAt: '',
  ...patch,
});

const NOW = Date.parse('2026-01-02T00:00:00Z');

describe('planBars', () => {
  it('is null without transactions', () => {
    expect(planBars([], 'USD', 'SPY', NOW)).toBeNull();
  });

  it('lists traded symbols, FX pairs into the base and the benchmark', () => {
    const plan = planBars(
      [
        tx({ id: '1' }),
        tx({ id: '2', symbol: 'sap.de', currency: 'EUR' }),
        tx({ id: '3', symbol: 'AAPL' }),
        tx({
          id: '4',
          kind: 'cashIn',
          symbol: null,
          currency: 'GBP',
          time: '2025-03-01T00:00:00Z',
        }),
      ],
      'USD',
      ' spy ',
      NOW,
    )!;
    expect(plan.symbols).toEqual(['AAPL', 'SAP.DE']);
    expect(plan.fx).toEqual([
      { ccy: 'EUR', symbol: 'EURUSD=X' },
      { ccy: 'GBP', symbol: 'GBPUSD=X' },
    ]);
    expect(plan.benchmark).toBe('SPY');
  });

  it('sizes the request by calendar days from the first transaction, with a cap', () => {
    const plan = planBars([tx({})], 'USD', null, NOW)!;
    expect(plan.benchmark).toBeNull();
    expect(plan.limit).toBeGreaterThanOrEqual(365);
    expect(plan.limit).toBeLessThan(400);
    const old = planBars([tx({ time: '1990-01-01T00:00:00Z' })], 'USD', null, NOW)!;
    expect(old.limit).toBe(MAX_DAILY_BARS);
    const fresh = planBars([tx({ time: '2026-01-02T00:00:00Z' })], 'USD', null, NOW)!;
    expect(fresh.limit).toBe(30);
  });
});

describe('toDailyCloses', () => {
  it('pairs times with closes and drops non-finite rows', () => {
    expect(
      toDailyCloses({
        time: Float64Array.from([1, 2, 3]),
        close: Float64Array.from([10, NaN, 30]),
      }),
    ).toEqual([
      { t: 1, c: 10 },
      { t: 3, c: 30 },
    ]);
  });
});

describe('loadPerformanceData', () => {
  const plan = {
    symbols: ['AAPL', 'MSFT'],
    fx: [{ ccy: 'EUR', symbol: 'EURUSD=X' }],
    benchmark: 'SPY',
    limit: 100,
  };

  it('fills closes, fx and benchmark', async () => {
    const fetchCloses = vi.fn(async (s: string) => [{ t: 1, c: s.length }]);
    const d = await loadPerformanceData(plan, fetchCloses);
    expect(Object.keys(d.closes).sort()).toEqual(['AAPL', 'MSFT']);
    expect(d.fx.EUR).toEqual([{ t: 1, c: 8 }]);
    expect(d.benchmark).toEqual([{ t: 1, c: 3 }]);
    expect(d.failed).toEqual([]);
    expect(fetchCloses).toHaveBeenCalledWith('AAPL', 100);
  });

  it('reports a failing series instead of failing the lot', async () => {
    const d = await loadPerformanceData(plan, async (s) => {
      if (s === 'MSFT' || s === 'SPY') throw new Error('nope');
      return [];
    });
    expect(d.failed.sort()).toEqual(['MSFT', 'SPY']);
    expect(d.closes.AAPL).toEqual([]);
    expect(d.closes.MSFT).toBeUndefined();
    expect(d.benchmark).toBeUndefined();
  });

  it('rejects when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(loadPerformanceData(plan, async () => [], ac.signal)).rejects.toBeDefined();
  });
});

describe('symbolCurrencies', () => {
  it('takes the currency of the first buy/sell, else any row, keyed upper-case', () => {
    expect(
      symbolCurrencies([
        tx({ id: '1', kind: 'dividend', symbol: 'vod.l', currency: 'USD' }),
        tx({ id: '2', kind: 'buy', symbol: 'VOD.L', currency: 'GBP' }),
        tx({ id: '3', kind: 'sell', symbol: 'VOD.L', currency: 'GBp' }),
        tx({ id: '4', kind: 'dividend', symbol: 'SAP.DE', currency: 'EUR' }),
        tx({ id: '5', kind: 'cashIn', symbol: null, currency: 'USD' }),
      ]),
    ).toEqual({ 'VOD.L': 'GBP', 'SAP.DE': 'EUR' });
  });
});

describe('adjustSubunits', () => {
  const data = (): PerformanceData => ({
    closes: {
      'VOD.L': [
        { t: 1, c: 7000 },
        { t: 2, c: 7250 },
      ],
      AAPL: [{ t: 1, c: 190 }],
    },
    fx: {},
    failed: [],
  });
  const quoteCcy = (s: string) => ({ 'VOD.L': 'GBp', AAPL: 'USD' })[s];

  it('rescales pence closes of a GBP-ledger symbol and leaves the rest', () => {
    const d = data();
    const out = adjustSubunits(d, { 'VOD.L': 'GBP', AAPL: 'USD' }, quoteCcy);
    expect(out.closes['VOD.L']!.map((p) => p.c)).toEqual([70, 72.5]);
    expect(out.closes['VOD.L']!.map((p) => p.t)).toEqual([1, 2]);
    expect(out.closes.AAPL).toBe(d.closes.AAPL);
    expect(d.closes['VOD.L']![0]!.c).toBe(7000); // input untouched
  });

  it('is a no-op for a pence ledger, unknown quote currency or no ledger currency', () => {
    const d = data();
    expect(adjustSubunits(d, { 'VOD.L': 'GBp' }, quoteCcy)).toBe(d);
    expect(adjustSubunits(d, { 'VOD.L': 'GBP' }, () => undefined)).toBe(d);
    expect(adjustSubunits(d, {}, quoteCcy)).toBe(d);
  });
});
