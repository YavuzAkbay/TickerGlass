import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, valueAt } from './common';

/** Total debt over stockholders' equity per fiscal period (leverage). */
export const DEBT_EQUITY = defineIndicator({
  id: 'fin-debt-equity',
  name: 'Debt to Equity',
  shortName: 'D/E',
  category: 'financials',
  keywords: ['debt to equity', 'debt/equity', 'leverage', 'balance sheet', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'ratio', title: 'Debt / Equity', kind: 'step', color: COLOR.orange },
  ],
  setup({ inputs, env }) {
    const debt = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.totalDebt, 'total debt');
    const equity = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.equity, 'equity');
    const ratio = divideBy(debt, equity);
    return (c) => {
      c.set('ratio', valueAt(ratio, c.time[c.i]!));
    };
  },
});
