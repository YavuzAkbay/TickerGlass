import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import {
  PERIOD_INPUT,
  ROW,
  divideBy,
  requireSeries,
  scaled,
  trailingTwelveMonths,
  valueAt,
} from './common';

/**
 * Return on equity: earnings over the period (trailing twelve months on the
 * quarterly basis) as a percent of stockholders' equity at its end.
 */
export const ROE = defineIndicator({
  id: 'fin-roe',
  name: 'Return on Equity',
  shortName: 'ROE',
  category: 'financials',
  keywords: ['roe', 'return on equity', 'profitability', 'financials'],
  overlay: false,
  format: 'percent',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'roe', title: 'ROE', kind: 'step', color: COLOR.purple },
  ],
  setup({ inputs, env }) {
    const netIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.netIncome,
      'net income',
    );
    const equity = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.equity, 'equity');
    const earnings = trailingTwelveMonths(netIncome, inputs.period);
    const roe = scaled(divideBy(earnings, equity), 100);
    return (c) => {
      c.set('roe', valueAt(roe, c.time[c.i]!));
    };
  },
});
