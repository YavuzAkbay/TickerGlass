import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, scaled, valueAt } from './common';

/** Operating income as a percent of revenue, per fiscal period. */
export const OPERATING_MARGIN = defineIndicator({
  id: 'fin-operating-margin',
  name: 'Operating Margin',
  shortName: 'Oper Margin',
  category: 'financials',
  keywords: ['operating margin', 'operating income', 'margin', 'profitability', 'financials'],
  overlay: false,
  format: 'percent',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'margin', title: 'Operating Margin', kind: 'step', color: COLOR.purple },
  ],
  setup({ inputs, env }) {
    const operatingIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.operatingIncome,
      'operating income',
    );
    const revenue = requireSeries(env.fundamentals, inputs.period, 'income', ROW.revenue, 'revenue');
    const margin = scaled(divideBy(operatingIncome, revenue), 100);
    return (c) => {
      c.set('margin', valueAt(margin, c.time[c.i]!));
    };
  },
});
