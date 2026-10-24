import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, requireSeries, trailingTwelveMonths, valueAt } from './common';

/** Net income of the income statement, plus the trailing twelve months (quarterly). */
export const NET_INCOME = defineIndicator({
  id: 'fin-net-income',
  name: 'Net Income',
  shortName: 'Net Inc',
  category: 'financials',
  keywords: ['net income', 'profit', 'earnings', 'bottom line', 'income statement', 'financials'],
  overlay: false,
  format: 'volume',
  usesFundamentals: true,
  inputs: {
    period: PERIOD_INPUT,
    ttm: { kind: 'bool', label: 'TTM', default: true, hideInTitle: true },
  },
  outputs: [
    { type: 'plot', id: 'netIncome', title: 'Net Income', kind: 'step', color: COLOR.blue },
    { type: 'plot', id: 'ttm', title: 'TTM', kind: 'step', color: COLOR.orange },
  ],
  setup({ inputs, env }) {
    const netIncome = requireSeries(
      env.fundamentals,
      inputs.period,
      'income',
      ROW.netIncome,
      'net income',
    );
    const ttm = trailingTwelveMonths(netIncome, inputs.period);
    return (c) => {
      c.set('netIncome', valueAt(netIncome, c.time[c.i]!));
      if (inputs.ttm) c.set('ttm', valueAt(ttm, c.time[c.i]!));
    };
  },
});
