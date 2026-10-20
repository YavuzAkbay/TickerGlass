import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Balance of Power: (close - open) / (high - low); NaN for a zero range. */
export const BOP = defineIndicator({
  id: 'bop',
  name: 'Balance of Power',
  shortName: 'BOP',
  category: 'momentum',
  keywords: ['bop', 'balance of power', 'oscillator'],
  overlay: false,
  precision: 4,
  inputs: {},
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.level },
    { type: 'plot', id: 'bop', title: 'BOP', kind: 'line', color: '#e5484d' },
  ],
  setup() {
    return (c) => {
      const i = c.i;
      const range = c.high[i]! - c.low[i]!;
      c.set('bop', range === 0 ? NaN : (c.close[i]! - c.open[i]!) / range);
    };
  },
});
