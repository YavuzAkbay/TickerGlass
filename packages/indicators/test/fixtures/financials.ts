import type { FundamentalsData } from '../../src/types';
import type { GroupFixtures } from './types';

/**
 * incremental.test.ts overrides for the financials group: the statements
 * fixture spans the default 400 x 15m bars (all of them after its fifth
 * period end, so history, TTM, growth and valuation series all have values).
 */
const FUND: FundamentalsData = {
  quarterly: {
    income: {
      periods: [0, 1, 2, 3, 4, 5].map((k) => 1_700_000_000 - (6 - k) * 91 * 86_400),
      rows: {
        'Total Revenue': [100, 200, 300, 400, 500, 600],
        'Gross Profit': [40, 80, 120, 160, 200, 240],
        'Operating Income': [20, 40, 60, 80, 100, 120],
        'Net Income': [10, 20, 30, 40, 50, 60],
        'Diluted EPS': [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        'Diluted Average Shares': [100, 100, 100, 100, 100, 100],
      },
    },
    balance: {
      periods: [0, 1, 2, 3, 4, 5].map((k) => 1_700_000_000 - (6 - k) * 91 * 86_400),
      rows: {
        'Current Assets': [200, 400, 600, 800, 1000, 1200],
        'Cash And Cash Equivalents': [100, 200, 300, 400, 500, 600],
        'Current Liabilities': [100, 200, 300, 400, 500, 600],
        'Total Debt': [200, 400, 600, 800, 1000, 1200],
        'Stockholders Equity': [500, 1000, 1500, 2000, 2500, 3000],
        'Ordinary Shares Number': [100, 100, 100, 100, 100, 100],
      },
    },
    cashflow: {
      periods: [0, 1, 2, 3, 4, 5].map((k) => 1_700_000_000 - (6 - k) * 91 * 86_400),
      rows: {
        'Operating Cash Flow': [12, 24, 36, 48, 60, 72],
        'Capital Expenditure': [-5, -10, -15, -20, -25, -30],
      },
    },
  },
};

const CONTEXT = { fundamentals: FUND };

/** financials group overrides, keyed by indicator id. */
export const FINANCIALS_FIXTURES: GroupFixtures = {
  'fin-revenue': { context: CONTEXT },
  'fin-net-income': { context: CONTEXT },
  'fin-eps': { context: CONTEXT },
  'fin-gross-margin': { context: CONTEXT },
  'fin-operating-margin': { context: CONTEXT },
  'fin-net-margin': { context: CONTEXT },
  'fin-revenue-growth': { context: CONTEXT },
  'fin-net-income-growth': { context: CONTEXT },
  'fin-ocf': { context: CONTEXT },
  'fin-fcf': { context: CONTEXT },
  'fin-debt-cash': { context: CONTEXT },
  'fin-debt-equity': { context: CONTEXT },
  'fin-current-ratio': { context: CONTEXT },
  'fin-roe': { context: CONTEXT },
  'fin-bvps': { context: CONTEXT },
  'fin-pe': { context: CONTEXT },
  'fin-ps': { context: CONTEXT },
  'fin-pb': { context: CONTEXT },
};
