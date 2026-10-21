import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Momentum: src - src[length]. */
export const MOMENTUM_INDICATOR = defineIndicator({
  id: 'momentum',
  name: 'Momentum',
  shortName: 'Mom',
  category: 'momentum',
  keywords: ['momentum', 'mom', 'oscillator'],
  overlay: false,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.levelMiddle },
    { type: 'plot', id: 'mom', title: 'Momentum', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs }) {
    const n = inputs.length;
    return (c) => {
      const s = c.src.source;
      c.set('mom', c.i >= n ? s[c.i]! - s[c.i - n]! : NaN);
    };
  },
});
