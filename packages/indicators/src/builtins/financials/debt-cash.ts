import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, requireSeries, valueAt } from './common';

/** Total debt against cash and equivalents per fiscal period, from the balance sheet. */
export const DEBT_CASH = defineIndicator({
  id: 'fin-debt-cash',
  name: 'Debt & Cash',
  shortName: 'Debt & Cash',
  category: 'financials',
  keywords: ['debt', 'cash', 'total debt', 'cash and equivalents', 'balance sheet', 'financials'],
  overlay: false,
  format: 'volume',
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'debt', title: 'Total Debt', kind: 'step', color: COLOR.red },
    { type: 'plot', id: 'cash', title: 'Cash & Equivalents', kind: 'step', color: COLOR.green },
  ],
  setup({ inputs, env }) {
    const debt = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.totalDebt, 'total debt');
    const cash = requireSeries(env.fundamentals, inputs.period, 'balance', ROW.cash, 'cash');
    return (c) => {
      c.set('debt', valueAt(debt, c.time[c.i]!));
      c.set('cash', valueAt(cash, c.time[c.i]!));
    };
  },
});
