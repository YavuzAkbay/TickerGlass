import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import {
  PERIOD_INPUT,
  ROW,
  divideBy,
  requireSeries,
  series,
  statementsOf,
  trailingTwelveMonths,
  valueAt,
} from './common';

/**
 * Price to earnings: the bar's close over trailing earnings per share (the
 * diluted EPS row, or net income over diluted shares). Quarterly uses the
 * trailing twelve months; annual uses the latest fiscal year.
 */
export const PRICE_EARNINGS = defineIndicator({
  id: 'fin-pe',
  name: 'Price to Earnings',
  shortName: 'P/E',
  category: 'financials',
  keywords: ['pe', 'p/e', 'price to earnings', 'earnings multiple', 'valuation', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'pe', title: 'P/E', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, env }) {
    const stmts = statementsOf(env.fundamentals, inputs.period);
    const reported = series(stmts?.income, ROW.dilutedEps);
    const netIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.netIncome,
      'net income',
    );
    const shares = series(stmts?.income, ROW.dilutedShares);
    const eps = reported ?? (shares ? divideBy(netIncome, shares) : null);
    if (!eps) throw new Error(`No ${inputs.period.toLowerCase()} diluted EPS data for this symbol`);
    const trailing = trailingTwelveMonths(eps, inputs.period);
    return (c) => {
      const e = valueAt(trailing, c.time[c.i]!);
      c.set('pe', e > 0 ? c.close[c.i]! / e : NaN);
    };
  },
});
