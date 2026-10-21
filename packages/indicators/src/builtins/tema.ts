import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Triple exponential moving average: 3 * e1 - 3 * e2 + e3 with e(k+1) = ema(ek). */
export const TEMA = defineIndicator({
  id: 'tema',
  name: 'Triple EMA',
  shortName: 'TEMA',
  category: 'movingAverage',
  keywords: ['ma', 'triple', 'exponential', 'average', 'tema'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'tema', title: 'TEMA', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const e1 = ta.ema(inputs.length);
    const e2 = ta.ema(inputs.length);
    const e3 = ta.ema(inputs.length);
    return (c) => {
      const a = e1.update(c.src.source[c.i]!);
      const b = e2.update(a);
      c.set('tema', 3 * a - 3 * b + e3.update(b));
    };
  },
});
