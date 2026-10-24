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
 * Price to sales: the bar's close over trailing revenue per share (revenue
 * over shares outstanding, both read at the same period end). Quarterly uses
 * the trailing twelve months; annual uses the latest fiscal year.
 */
export const PRICE_SALES = defineIndicator({
  id: 'fin-ps',
  name: 'Price to Sales',
  shortName: 'P/S',
  category: 'financials',
  keywords: ['ps', 'p/s', 'price to sales', 'sales multiple', 'revenue multiple', 'valuation', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'ps', title: 'P/S', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, env }) {
    const revenue = requireSeries(env.fundamentals, inputs.period, 'income', ROW.revenue, 'revenue');
    const shares = series(statementsOf(env.fundamentals, inputs.period)?.balance, ROW.shares);
    if (!shares) throw new Error(`No ${inputs.period.toLowerCase()} shares data for this symbol`);
    const trailingRevenue = trailingTwelveMonths(revenue, inputs.period);
    const revenuePerShare = divideBy(trailingRevenue, shares);
    return (c) => {
      const rps = valueAt(revenuePerShare, c.time[c.i]!);
      c.set('ps', rps > 0 ? c.close[c.i]! / rps : NaN);
    };
  },
});
