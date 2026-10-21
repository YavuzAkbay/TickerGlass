import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Mass Index: sum over `length` of ema(high - low, 9) / ema(ema(high - low, 9), 9). */
export const MASS_INDEX = defineIndicator({
  id: 'mass-index',
  name: 'Mass Index',
  shortName: 'Mass Index',
  category: 'volatility',
  keywords: ['mass index', 'mass', 'reversal', 'range', 'volatility'],
  overlay: false,
  precision: 4,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 5000 },
  },
  outputs: [{ type: 'plot', id: 'mi', title: 'Mass Index', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const e1 = ta.ema(9);
    const e2 = ta.ema(9);
    const sum = ta.sum(inputs.length);
    return (c) => {
      const a = e1.update(c.high[c.i]! - c.low[c.i]!);
      const b = e2.update(a);
      c.set('mi', sum.update(b === 0 ? NaN : a / b));
    };
  },
});
