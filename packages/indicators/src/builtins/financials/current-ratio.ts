import { defineIndicator } from '../../registry';
import { COLOR } from '../common';
import { PERIOD_INPUT, ROW, divideBy, requireSeries, valueAt } from './common';

/** Current assets over current liabilities per fiscal period (liquidity). */
export const CURRENT_RATIO = defineIndicator({
  id: 'fin-current-ratio',
  name: 'Current Ratio',
  shortName: 'Current Ratio',
  category: 'financials',
  keywords: ['current ratio', 'liquidity', 'working capital', 'balance sheet', 'financials'],
  overlay: false,
  format: 'price',
  precision: 2,
  usesFundamentals: true,
  inputs: { period: PERIOD_INPUT },
  outputs: [
    { type: 'plot', id: 'ratio', title: 'Current Ratio', kind: 'step', color: COLOR.blue },
  ],
  setup({ inputs, env }) {
    const assets = requireSeries(
      env.fundamentals,
      inputs.period,
      'balance',
      ROW.currentAssets,
      'current assets',
    );
    const liabilities = requireSeries(
      env.fundamentals,
      inputs.period,
      'balance',
      ROW.currentLiabilities,
      'current liabilities',
    );
    const ratio = divideBy(assets, liabilities);
    return (c) => {
      c.set('ratio', valueAt(ratio, c.time[c.i]!));
    };
  },
});
