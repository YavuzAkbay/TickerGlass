import { describe, expect, it } from 'vitest';
import { BarStore } from '../../bars';
import { IndicatorInstance } from '../../instance';
import type { AnyIndicatorDefinition } from '../../registry';
import type { FundamentalsData, InputValueMap, StatementData } from '../../types';
import { FREE_CASH_FLOW } from './free-cash-flow';
import { GROSS_MARGIN } from './gross-margin';
import { EPS } from './eps';
import { REVENUE } from './revenue';
import { REVENUE_GROWTH } from './revenue-growth';
import { PRICE_EARNINGS } from './pe';
import { PRICE_BOOK } from './pb';
import {
  divideBy,
  series,
  splitAdjusted,
  trailingTwelveMonths,
  valueAt,
  yearOverYear,
} from './common';

const DAY = 86_400;
/** Fiscal period ends, ascending: one year of quarters. */
const PERIODS = [0, 91, 182, 273, 364].map((d) => 1_700_000_000 + d * DAY);

function statement(rows: Record<string, number[]>): StatementData {
  return { periods: PERIODS, rows };
}

/** Consistent statements: revenue 100 * (q + 1), everything derived from it. */
function fundamentals(): FundamentalsData {
  const revenue = [100, 200, 300, 400, 500];
  const netIncome = revenue.map((r) => r * 0.1);
  const shares = [10, 10, 10, 10, 10];
  return {
    quarterly: {
      income: statement({
        'Total Revenue': revenue,
        'Gross Profit': revenue.map((r) => r * 0.4),
        'Net Income': netIncome,
        'Diluted EPS': netIncome.map((n, k) => n / shares[k]!),
        'Diluted Average Shares': shares,
      }),
      balance: statement({
        'Total Debt': revenue.map((r) => r * 0.5),
        'Stockholders Equity': revenue.map((r) => r * 2),
        'Ordinary Shares Number': shares,
      }),
      cashflow: statement({
        'Operating Cash Flow': netIncome.map((n) => n * 1.2),
        'Capital Expenditure': revenue.map((r) => -r * 0.05),
      }),
    },
  };
}

/** Weekly bars across the periods, closing at 1000. */
function bars(): BarStore {
  const n = 80;
  const time = Float64Array.from({ length: n }, (_, i) => PERIODS[0]! + (i - 4) * 7 * DAY);
  const close = new Float64Array(n).fill(1000);
  const store = new BarStore();
  store.setAll({ time, open: close, high: close, low: close, close, volume: close });
  return store;
}

function compute(
  def: AnyIndicatorDefinition,
  inputs: InputValueMap = {},
  fund: FundamentalsData = fundamentals(),
  store: BarStore = bars(),
) {
  const inst = new IndicatorInstance(def, inputs);
  inst.setEnv({
    timezone: 'UTC',
    session: null,
    intervalSeconds: 604_800,
    fundamentals: fund,
  });
  inst.computeAll(store);
  return inst.result();
}

describe('financials helpers', () => {
  const s = { periods: [10, 20, 30], values: [1, 2, 3] };

  it('valueAt holds the last period at or before the time', () => {
    expect(valueAt(s, 5)).toBeNaN();
    expect(valueAt(s, 10)).toBe(1);
    expect(valueAt(s, 19)).toBe(1);
    expect(valueAt(s, 30)).toBe(3);
    expect(valueAt(s, 100)).toBe(3);
  });

  it('series resolves row aliases and sorts descending periods ascending', () => {
    const desc: StatementData = {
      periods: [30, 10, 20],
      rows: { 'Total Revenue': [3, 1, 2] },
    };
    expect(series(desc, ['Total Revenue', 'Revenues'])).toEqual({
      periods: [10, 20, 30],
      values: [1, 2, 3],
    });
    expect(series(desc, ['Revenues', 'Sales'])).toBeNull();
  });

  it('trailingTwelveMonths sums each quarter with the three before it', () => {
    const q = { periods: [1, 2, 3, 4, 5], values: [1, 2, 3, 4, 5] };
    expect(trailingTwelveMonths(q, 'Quarterly')).toEqual({
      periods: [4, 5],
      values: [10, 14],
    });
    // Annual passes through; a NaN quarter poisons its window.
    expect(trailingTwelveMonths(q, 'Annual')).toBe(q);
    const hole = { periods: [1, 2, 3, 4], values: [1, NaN, 3, 4] };
    expect(trailingTwelveMonths(hole, 'Quarterly').values[0]).toBeNaN();
  });

  it('yearOverYear compares against four quarters back (or the previous year)', () => {
    const q = { periods: [1, 2, 3, 4, 5], values: [100, 1, 1, 1, 150] };
    expect(yearOverYear(q, 'Quarterly').values).toEqual([50]);
    const a = { periods: [1, 2], values: [100, 80] };
    expect(yearOverYear(a, 'Annual').values).toEqual([-20]);
  });

  it('divideBy reads the denominator at the numerator period ends', () => {
    const num = { periods: [10, 30], values: [10, 30] };
    const den = { periods: [10, 29], values: [2, 6] }; // end a day earlier
    expect(divideBy(num, den).values).toEqual([5, 5]);
    // A denominator ending after the numerator's period is not reported yet:
    // its previous value is used, like any other later series.
    const late = { periods: [10, 31], values: [2, 6] };
    expect(divideBy(num, late).values).toEqual([5, 15]);
  });
});

describe('splitAdjusted', () => {
  const t = (d: number) => 1_700_000_000 + d * DAY;
  const periods = [t(0), t(91), t(182), t(273)];

  it('scales periods before the split, not after', () => {
    const shares = { periods, values: [10, 10, 80, 80] };
    const eps = { periods, values: [8, 8, 1, 1] };
    const splits = [{ t: t(100), ratio: 8 }];
    expect(splitAdjusted(eps, shares, splits, 'perShare').values).toEqual([1, 1, 1, 1]);
    expect(splitAdjusted(shares, shares, splits, 'count').values).toEqual([80, 80, 80, 80]);
  });

  it('leaves periods the provider already restated', () => {
    const shares = { periods, values: [79, 80, 80, 81] };
    const eps = { periods, values: [1, 1, 1, 1] };
    const splits = [{ t: t(100), ratio: 8 }];
    expect(splitAdjusted(eps, shares, splits, 'perShare').values).toEqual([1, 1, 1, 1]);
  });

  it('compounds several splits and ignores unusable ratios', () => {
    const shares = { periods, values: [1, 2, 8, 8] };
    const splits = [
      { t: t(50), ratio: 2 },
      { t: t(150), ratio: 4 },
      { t: t(200), ratio: 0 },
    ];
    expect(splitAdjusted(shares, shares, splits, 'count').values).toEqual([8, 8, 8, 8]);
  });

  it('returns the series unchanged without splits', () => {
    const s = { periods, values: [1, 2, 3, 4] };
    expect(splitAdjusted(s, null, undefined, 'count')).toBe(s);
  });
});

describe('financials built-ins', () => {
  // Period k of the fixture ends at bar 4 + k * 13 (weekly bars, 91-day quarters).
  it('Revenue forward-fills from each period end and sums TTM', () => {
    const r = compute(REVENUE, {});
    const revenue = r.values.revenue!;
    const ttm = r.values.ttm!;
    expect(revenue[3]).toBeNaN(); // before the first period end
    expect(revenue[17]).toBe(200); // period 1
    expect(revenue[42]).toBe(300); // the bar before period 3's end
    expect(ttm[42]).toBeNaN(); // only three quarters known
    expect(revenue[43]).toBe(400);
    expect(ttm[43]).toBe(1000); // 100 + 200 + 300 + 400
    expect(revenue[56]).toBe(500);
    expect(ttm[56]).toBe(1400);
    expect(r.status).toEqual({ state: 'ok' });
  });

  it('Revenue on the annual basis reads the annual statements', () => {
    const annual: FundamentalsData = {
      annual: {
        income: {
          periods: PERIODS.slice(2),
          rows: { 'Total Revenue': [900, 1000, 1100] },
        },
      },
    };
    const r = compute(REVENUE, { period: 'Annual', ttm: false }, annual);
    expect(r.values.revenue![30]).toBe(900); // first annual period ends here
    expect(r.values.revenue![43]).toBe(1000);
    expect(r.values.ttm!.every(Number.isNaN)).toBe(true);
  });

  it('EPS derives diluted EPS from net income over shares when the row is missing', () => {
    const fund = fundamentals();
    delete (fund.quarterly!.income!.rows as Record<string, number[]>)['Diluted EPS'];
    const r = compute(EPS, { ttm: false }, fund);
    expect(r.values.eps![43]).toBeCloseTo(4, 10); // net income 40 over 10 shares
  });

  it('Gross Margin plots the ratio in percent', () => {
    const r = compute(GROSS_MARGIN, {});
    expect(r.values.margin![17]).toBeCloseTo(40, 10);
  });

  it('Revenue Growth turns NaN until the prior-year quarter exists', () => {
    const r = compute(REVENUE_GROWTH, {});
    const growth = r.values.growth!;
    expect(growth[43]).toBeNaN(); // period 3: no year-ago quarter yet
    expect(growth[56]).toBeCloseTo(((500 - 100) / 100) * 100, 10);
  });

  it('Free Cash Flow subtracts capital expenditure from operating cash flow', () => {
    const r = compute(FREE_CASH_FLOW, { ttm: false });
    // OCF 400*0.1*1.2 = 48; capex 400*0.05 = 20.
    expect(r.values.fcf![43]).toBeCloseTo(28, 10);
  });

  it('P/E divides the close by trailing EPS', () => {
    const r = compute(PRICE_EARNINGS, {});
    // TTM EPS at period 3 = (10+20+30+40)/10 = 10; close 1000.
    expect(r.values.pe![43]).toBeCloseTo(100, 10);
  });

  it('P/E puts EPS filed before a split on the split-adjusted basis of the bars', () => {
    // 8:1 split after the last period: statements still pre-split (as Yahoo
    // reports SNDK right after its split), bars already divided by 8.
    const fund = { ...fundamentals(), splits: [{ t: PERIODS[4]! + 10 * DAY, ratio: 8 }] };
    const r = compute(PRICE_EARNINGS, {}, fund);
    // TTM EPS 10 / 8 = 1.25; close 1000.
    expect(r.values.pe![43]).toBeCloseTo(800, 10);
  });

  it('P/B scales the share count by splits after the period', () => {
    const fund = { ...fundamentals(), splits: [{ t: PERIODS[4]! + 10 * DAY, ratio: 2 }] };
    // Equity 1000 at period 4 over 10 * 2 shares = 50 per share (100 unadjusted).
    const r = compute(PRICE_BOOK, {}, fund);
    expect(r.values.pb![60]).toBeCloseTo(20, 10);
  });

  it('reports a clear error when the symbol has no statements of the basis', () => {
    const r = compute(REVENUE, {}, { annual: {} });
    expect(r.status).toMatchObject({ state: 'error', message: /No quarterly revenue/ });
  });
});
