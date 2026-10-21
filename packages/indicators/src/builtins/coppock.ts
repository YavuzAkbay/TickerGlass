import { defineIndicator } from '../registry';
import { COLOR } from './common';
import { rocAt } from './roc';

/** Coppock Curve: wma(roc(close, long) + roc(close, short), wmaLength). */
export const COPPOCK = defineIndicator({
  id: 'coppock',
  name: 'Coppock Curve',
  shortName: 'Coppock',
  category: 'momentum',
  keywords: ['coppock', 'curve', 'roc', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    wmaLength: { kind: 'int', label: 'WMA Length', default: 10, min: 1, max: 5000 },
    longRoc: { kind: 'int', label: 'Long RoC Length', default: 14, min: 1, max: 4999 },
    shortRoc: { kind: 'int', label: 'Short RoC Length', default: 11, min: 1, max: 4999 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.levelMiddle },
    { type: 'plot', id: 'coppock', title: 'Coppock Curve', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const wma = ta.wma(inputs.wmaLength);
    return (c) => {
      const r = rocAt(c.close, c.i, inputs.longRoc) + rocAt(c.close, c.i, inputs.shortRoc);
      c.set('coppock', wma.update(r));
    };
  },
});
