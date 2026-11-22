import { describe, expect, it } from 'vitest';
import { computeLedger } from './ledger';
import { valuate } from './valuate';
import { buy, mk } from './testUtil';

const d = (day: number) => `2024-01-${String(day).padStart(2, '0')}T12:00:00Z`;
const fx = (m: Record<string, number>) => (c: string) => m[c];

describe('valuate', () => {
  const ledger = computeLedger(
    [
      mk('cashIn', d(1), { amount: 5000 }),
      mk('cashIn', d(1), { amount: 200, currency: 'EUR' }),
      buy(d(2), 'AAPL', 10, 100),
      buy(d(2), 'SAP', 5, 100, 0, { currency: 'EUR' }),
      mk('dividend', d(3), { symbol: 'AAPL', amount: 10, fee: 2 }),
    ],
    { costMethod: 'fifo' },
  );

  it('converts to base, weights by base value and totals', () => {
    const v = valuate(ledger, { AAPL: 110, SAP: 120 }, fx({ EUR: 1.1 }), 'USD', { AAPL: 108 });
    const aapl = v.rows.find((r) => r.symbol === 'AAPL');
    const sap = v.rows.find((r) => r.symbol === 'SAP');
    expect(aapl).toMatchObject({ marketValue: 1100, unrealized: 100, dayChange: 20 });
    expect(aapl?.unrealizedPct).toBeCloseTo(10, 9);
    expect(aapl?.dayChangePct).toBeCloseTo((20 / 1080) * 100, 9);
    expect(sap).toMatchObject({ marketValue: 600, fxRate: 1.1 });
    expect(sap?.marketValueBase).toBeCloseTo(660, 9);
    expect(sap?.dayChange).toBeNull();
    expect(aapl?.weight).toBeCloseTo(1100 / 1760, 9);
    expect((aapl?.weight ?? 0) + (sap?.weight ?? 0)).toBeCloseTo(1, 9);
    expect(v.totals.marketValue).toBeCloseTo(1760, 9);
    expect(v.totals.unrealized).toBeCloseTo(100 + 110, 9);
    expect(v.totals.costBasis).toBeCloseTo(1000 + 550, 9);
    expect(v.totals.dividends).toBe(8);
    expect(v.totals.dayChange).toBe(20);
    // cash: USD 5000 - 1000 + 8 ; EUR 200 - 500 = -300
    expect(v.cash.map((c) => c.currency)).toEqual(['EUR', 'USD']);
    expect(v.totals.cash).toBeCloseTo(4008 + -300 * 1.1, 9);
    expect(v.totals.totalValue).toBeCloseTo(1760 + 4008 - 330, 9);
    expect(v.totals.totalReturn).toBeCloseTo(210 + 8, 9);
    expect(v.missingFx).toEqual([]);
    expect(v.missingPrices).toEqual([]);
  });

  it('flags and excludes rows and cash without FX', () => {
    const v = valuate(ledger, { AAPL: 110, SAP: 120 }, fx({}), 'USD');
    const sap = v.rows.find((r) => r.symbol === 'SAP');
    expect(sap).toMatchObject({ fxMissing: true, marketValueBase: null, weight: null });
    expect(sap?.marketValue).toBe(600);
    expect(v.totals.marketValue).toBe(1100);
    expect(v.rows.find((r) => r.symbol === 'AAPL')?.weight).toBe(1);
    expect(v.missingFx).toEqual(['EUR']);
    expect(v.cash.find((c) => c.currency === 'EUR')).toMatchObject({
      fxMissing: true,
      valueBase: null,
    });
    expect(v.totals.cash).toBe(4008);
  });

  it('flags missing prices and leaves them out of totals', () => {
    const v = valuate(ledger, { AAPL: 110 }, fx({ EUR: 1.1 }), 'USD');
    expect(v.missingPrices).toEqual(['SAP']);
    const sap = v.rows.find((r) => r.symbol === 'SAP');
    expect(sap).toMatchObject({ priceMissing: true, last: null, marketValue: null });
    expect(v.totals.marketValue).toBe(1100);
  });

  it('omits closed positions', () => {
    const l = computeLedger(
      [buy(d(1), 'A', 1, 1), mk('sell', d(2), { symbol: 'A', quantity: 1, price: 2 })],
      {
        costMethod: 'fifo',
      },
    );
    expect(valuate(l, {}, fx({}), 'USD').rows).toEqual([]);
  });
});
