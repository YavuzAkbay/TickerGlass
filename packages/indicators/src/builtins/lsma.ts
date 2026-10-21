import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Least squares moving average. */
export const LSMA = defineIndicator({
  id: 'lsma',
  name: 'Least Squares Moving Average',
  shortName: 'LSMA',
  category: 'movingAverage',
  keywords: ['ma', 'least squares', 'linear regression', 'linreg', 'average', 'lsma'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 25, min: 1, max: 5000 },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'lsma', title: 'LSMA', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const lr = ta.linreg(inputs.length, inputs.offset);
    return (c) => c.set('lsma', lr.update(c.src.source[c.i]!));
  },
});
