import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, scaled, valueAt } from './common';

/** Gross profit as a percent of revenue, per fiscal period. */
export const GROSS_MARGIN = defineIndicator({
  id: 'fin-gross-margin',
  name: 'Gross Margin',
  shortName: 'Gross Margin',
  category: 'financials',
  keywords: ['gross margin', 'gross profit', 'margin', 'profitability', 'financials'],
  overlay: false,
  format: 'percent',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'margin', title: 'Gross Margin', kind: 'step', color: COLOR.green },
  ],
  setup({ inputs, env }) {
    const grossProfit = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.grossProfit,
      'gross profit',
    );
    const revenue = requireSeries(env.fundamentals, inputs.period, 'income', ROW.revenue, 'revenue');
    const margin = scaled(divideBy(grossProfit, revenue), 100);
    return (c) => {
      c.set('margin', valueAt(margin, c.time[c.i]!));
    };
  },
});
