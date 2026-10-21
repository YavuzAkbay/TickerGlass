import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Chaikin Volatility: rate of change (percent) of the EMA of high - low. */
export const CHAIKIN_VOLATILITY = defineIndicator({
  id: 'chaikin-volatility',
  name: 'Chaikin Volatility',
  shortName: 'CV',
  category: 'volatility',
  keywords: ['chaikin', 'volatility', 'cv', 'range'],
  overlay: false,
  precision: 2,
  inputs: {
    emaLength: { kind: 'int', label: 'EMA Length', default: 10, min: 1, max: 5000 },
    rocLength: { kind: 'int', label: 'ROC Length', default: 10, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.level },
    { type: 'plot', id: 'cv', title: 'CV', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const ema = ta.ema(inputs.emaLength);
    const past = ta.history(inputs.rocLength + 1);
    return (c) => {
      const e = ema.update(c.high[c.i]! - c.low[c.i]!);
      if (!Number.isNaN(e)) past.push(e);
      const old = past.get(inputs.rocLength);
      c.set('cv', old === 0 ? NaN : (100 * (e - old)) / old);
    };
  },
});
