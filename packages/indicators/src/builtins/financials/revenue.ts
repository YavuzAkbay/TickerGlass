import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, requireSeries, trailingTwelveMonths, valueAt } from './common';

/**
 * Revenue as reported in the income statement of the chart symbol: the value
 * of the last fiscal period that ended at or before each bar, plus the
 * trailing twelve months while on the quarterly basis.
 */
export const REVENUE = defineIndicator({
  id: 'fin-revenue',
  name: 'Revenue',
  shortName: 'Revenue',
  category: 'financials',
  keywords: ['revenue', 'sales', 'top line', 'income statement', 'financials', 'fundamental'],
  overlay: false,
  format: 'volume',
  usesFundamentals: true,
  inputs: {
    period: PERIOD_INPUT,
    ttm: { kind: 'bool', label: 'TTM', default: true, hideInTitle: true },
  },
  outputs: [
    { type: 'plot', id: 'revenue', title: 'Revenue', kind: 'step', color: COLOR.blue },
    { type: 'plot', id: 'ttm', title: 'TTM', kind: 'step', color: COLOR.orange },
  ],
  setup({ inputs, env }) {
    const revenue = requireSeries(env.fundamentals, inputs.period, 'income', ROW.revenue, 'revenue');
    const ttm = trailingTwelveMonths(revenue, inputs.period);
    return (c) => {
      c.set('revenue', valueAt(revenue, c.time[c.i]!));
      if (inputs.ttm) c.set('ttm', valueAt(ttm, c.time[c.i]!));
    };
  },
});
