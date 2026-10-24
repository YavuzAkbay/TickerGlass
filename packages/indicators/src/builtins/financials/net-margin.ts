import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, scaled, valueAt } from './common';

/** Net income as a percent of revenue, per fiscal period. */
export const NET_MARGIN = defineIndicator({
  id: 'fin-net-margin',
  name: 'Net Margin',
  shortName: 'Net Margin',
  category: 'financials',
  keywords: ['net margin', 'profit margin', 'margin', 'profitability', 'financials'],
  overlay: false,
  format: 'percent',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'margin', title: 'Net Margin', kind: 'step', color: COLOR.blue },
  ],
  setup({ inputs, env }) {
    const netIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.netIncome,
      'net income',
    );
    const revenue = requireSeries(env.fundamentals, inputs.period, 'income', ROW.revenue, 'revenue');
    const margin = scaled(divideBy(netIncome, revenue), 100);
    return (c) => {
      c.set('margin', valueAt(margin, c.time[c.i]!));
    };
  },
});
