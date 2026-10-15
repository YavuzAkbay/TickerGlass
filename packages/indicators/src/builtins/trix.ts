import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** TRIX : 10000 * change(ema(ema(ema(ln close)))). */
export const TRIX = defineIndicator({
  id: 'trix',
  name: 'TRIX',
  shortName: 'TRIX',
  category: 'momentum',
  keywords: ['trix', 'triple exponential', 'oscillator'],
  overlay: false,
  precision: 3,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 18, min: 1, max: 2000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.levelMiddle },
    { type: 'plot', id: 'trix', title: 'TRIX', kind: 'line', color: COLOR.brightRed },
  ],
  setup({ inputs, ta }) {
    const e1 = ta.ema(inputs.length);
    const e2 = ta.ema(inputs.length);
    const e3 = ta.ema(inputs.length);
    const ch = ta.change();
    return (c) => {
      const e = e3.update(e2.update(e1.update(Math.log(c.close[c.i]!))));
      c.set('trix', 10000 * ch.update(e));
    };
  },
});
