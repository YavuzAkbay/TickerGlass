import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, requireSeries, valueAt, yearOverYear } from './common';

/**
 * Revenue growth over the previous year (the same quarter last year on the
 * quarterly basis, the previous year on the annual basis), in percent.
 */
export const REVENUE_GROWTH = defineIndicator({
  id: 'fin-revenue-growth',
  name: 'Revenue Growth',
  shortName: 'Rev Growth',
  category: 'financials',
  keywords: ['revenue growth', 'growth', 'yoy', 'year over year', 'financials'],
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
    const revenue = requireSeries(env.fundamentals, inputs.period, 'income', ROW.revenue, 'revenue');
    const growth = yearOverYear(revenue, inputs.period);
    return (c) => {
      const v = valueAt(growth, c.time[c.i]!);
      c.set('growth', v, v >= 0 ? 1 : 0);
    };
  },
});
