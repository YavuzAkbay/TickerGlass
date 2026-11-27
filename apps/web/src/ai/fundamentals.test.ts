import { describe, expect, it, vi } from 'vitest';
import type { Chart } from '@tickerglass/engine';
import type { Fundamentals } from '../api/types';

const response: { value: Fundamentals } = { value: { info: {}, financials: {} } };

vi.mock('../indicators/fundamentals', async (orig) => ({
  ...(await orig<typeof import('../indicators/fundamentals')>()),
  fetchFundamentals: vi.fn(async () => response.value),
}));
vi.mock('../events/api', () => ({ fetchEvents: vi.fn(async () => ({ splits: [] })) }));

const { fundamentalsReport, money } = await import('./fundamentals');

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose reads of nested JSON
type Report = Record<string, any>;
const DAY = 86400;
// Eight quarter ends, 2025-03-31 .. 2026-12-31 (roughly; exact dates do not matter).
const ends = Array.from({ length: 8 }, (_, k) =>
  new Date(Date.UTC(2025, 3 * k + 3, 0)).toISOString().slice(0, 10),
);

function chartWith(closes: Array<[string, number]>): Chart {
  const time = closes.map(([d]) => Date.parse(d) / 1000);
  const close = closes.map(([, c]) => c);
  return {
    getSymbol: () => 'TEST',
    symbolInfo: { currency: 'USD' },
    rawStore: { length: time.length, time, close },
  } as unknown as Chart;
}

describe('money', () => {
  it('writes compact amounts', () => {
    expect(money(11_030_000_000)).toBe('11.03B');
    expect(money(-2_500_000)).toBe('-2.50M');
    expect(money(NaN)).toBeNull();
  });
});

describe('fundamentalsReport', () => {
  it('computes TTM figures, multiples and their history', async () => {
    const revenue = [100, 110, 120, 130, 150, 170, 190, 210].map((v) => v * 1e6);
    const netIncome = [10, 11, 12, 13, 20, 25, 30, 35].map((v) => v * 1e6);
    const eps = [1, 1.1, 1.2, 1.3, 2, 2.5, 3, 3.5];
    response.value = {
      info: { marketCap: 1_000_000_000, forwardPE: 7 },
      financials: {
        quarterly: {
          income: {
            periods: ends,
            rows: {
              'Total Revenue': revenue,
              'Net Income': netIncome,
              'Diluted EPS': eps,
              'Diluted Average Shares': ends.map(() => 10e6),
            },
          },
          balance: {
            periods: ends,
            rows: {
              'Stockholders Equity': ends.map(() => 200e6),
              'Total Debt': ends.map(() => 50e6),
              'Cash And Cash Equivalents': ends.map(() => 30e6),
            },
          },
        },
      },
    };
    // A close on each quarter end, then today's price.
    const closes: Array<[string, number]> = ends.map((d) => [d, 50]);
    closes.push([new Date(Date.parse(ends[7]!) + 30 * DAY * 1000).toISOString().slice(0, 10), 55]);
    const r = (await fundamentalsReport(chartWith(closes))) as Report;

    expect(r.price).toBe(55);
    expect(r.marketCap).toBe('1.00B');
    // TTM = last four quarters.
    expect(r.trailing.revenue).toBe('720.00M');
    expect(r.trailing.epsDiluted).toBe(11);
    // 720 vs 460 a year before.
    expect(r.trailing.revenueGrowthYoYPct).toBeCloseTo(56.5, 1);
    expect(r.trailing.roePct).toBeCloseTo(55, 1);
    expect(r.valuationNow.peTrailing).toBe(5); // 55 / 11
    expect(r.valuationNow.priceToSales).toBeCloseTo(1.39, 2);
    expect(r.balanceSheet.netDebt).toBe('20.00M');
    // P/E at the quarter ends with a full TTM: 50/4.6 and 50/11.
    expect(r.valuationHistory.peRange.max).toBeCloseTo(10.87, 2);
    expect(r.valuationHistory.peRange.min).toBeCloseTo(4.55, 2);
    expect(r.quarters).toHaveLength(8);
    expect(r.quarters[7].revenueYoYPct).toBeCloseTo(61.5, 1);
  });

  it('reports a symbol without statements', async () => {
    response.value = { info: { trailingPE: 12 }, financials: {} };
    const r = (await fundamentalsReport(chartWith([['2026-01-02', 10]]))) as Report;
    expect(r.trailing).toBeUndefined();
    expect(r.providerSummary.trailingPE).toBe(12);
    expect(r.notes[0]).toMatch(/no financial statements/);
  });
});
