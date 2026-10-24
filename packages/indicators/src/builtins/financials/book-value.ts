import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, valueAt } from './common';

/** Book value per share: stockholders' equity over shares outstanding. */
export const BOOK_VALUE = defineIndicator({
  id: 'fin-bvps',
  name: 'Book Value per Share',
  shortName: 'BVPS',
  category: 'financials',
  keywords: ['book value', 'bvps', 'equity per share', 'balance sheet', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'bvps', title: 'Book Value / Share', kind: 'step', color: COLOR.blue },
  ],
  setup({ inputs, env }) {
    const equity = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.equity, 'equity');
    const shares = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.shares, 'shares');
    const bvps = divideBy(equity, shares);
    return (c) => {
      c.set('bvps', valueAt(bvps, c.time[c.i]!));
    };
  },
});
