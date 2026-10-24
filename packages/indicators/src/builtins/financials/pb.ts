import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, valueAt } from './common';

/** Price to book: the bar's close over book value per share (equity / shares). */
export const PRICE_BOOK = defineIndicator({
  id: 'fin-pb',
  name: 'Price to Book',
  shortName: 'P/B',
  category: 'financials',
  keywords: ['pb', 'p/b', 'price to book', 'book multiple', 'valuation', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'pb', title: 'P/B', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, env }) {
    const equity = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.equity, 'equity');
    const shares = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.shares, 'shares');
    const bvps = divideBy(equity, shares);
    return (c) => {
      const v = valueAt(bvps, c.time[c.i]!);
      c.set('pb', v > 0 ? c.close[c.i]! / v : NaN);
    };
  },
});
