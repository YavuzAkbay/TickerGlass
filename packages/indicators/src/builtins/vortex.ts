import { defineIndicator } from '../registry';
import { trueRange } from './common';

/** Vortex Indicator: sums of |high - low[1]| and |low - high[1]| over the sum of true range. */
export const VORTEX = defineIndicator({
  id: 'vortex',
  name: 'Vortex Indicator',
  shortName: 'VI',
  category: 'momentum',
  keywords: ['vortex', 'vi', 'trend'],
  overlay: false,
  precision: 4,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 2, max: 5000 },
  },
  outputs: [
    { type: 'plot', id: 'plus', title: 'VI +', kind: 'line', color: '#2962ff' },
    { type: 'plot', id: 'minus', title: 'VI -', kind: 'line', color: '#e91e63' },
  ],
  setup({ inputs, ta }) {
    const vmp = ta.sum(inputs.length);
    const vmm = ta.sum(inputs.length);
    const str = ta.sum(inputs.length);
    return (c) => {
      const i = c.i;
      const ph = i > 0 ? c.high[i - 1]! : NaN;
      const pl = i > 0 ? c.low[i - 1]! : NaN;
      const p = vmp.update(Math.abs(c.high[i]! - pl));
      const m = vmm.update(Math.abs(c.low[i]! - ph));
      // standard `ta.atr(1)`: true range with high - low on the first bar.
      const s = str.update(trueRange(c, true));
      c.set('plus', s === 0 ? NaN : p / s);
      c.set('minus', s === 0 ? NaN : m / s);
    };
  },
});
