import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, requireSeries, valueAt, yearOverYear } from './common';

/**
 * Net income growth over the previous year (the same quarter last year on the
 * quarterly basis, the previous year on the annual basis), in percent.
 */
export const NET_INCOME_GROWTH = defineIndicator({
  id: 'fin-net-income-growth',
  name: 'Net Income Growth',
  shortName: 'NI Growth',
  category: 'financials',
  keywords: ['net income growth', 'earnings growth', 'growth', 'yoy', 'financials'],
  overlay: false,
  format: 'percent',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    {
      type: 'plot',
      id: 'growth',
      title: 'Growth',
      kind: 'histogram',
      color: [COLOR.red, COLOR.green],
    },
  ],
  setup({ inputs, env }) {
    const netIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.netIncome,
      'net income',
    );
    const growth = yearOverYear(netIncome, inputs.period);
    return (c) => {
      const v = valueAt(growth, c.time[c.i]!);
      c.set('growth', v, v >= 0 ? 1 : 0);
    };
  },
});
