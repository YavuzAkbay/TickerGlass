import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Arnaud Legoux moving average: gaussian-weighted window
 * centred at offset * (length - 1) from the oldest value, width length / sigma.
 */
export const ALMA = defineIndicator({
  id: 'alma',
  name: 'Arnaud Legoux Moving Average',
  shortName: 'ALMA',
  category: 'movingAverage',
  keywords: ['ma', 'arnaud', 'legoux', 'gaussian', 'average', 'alma'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Window Size', default: 9, min: 1, max: 5000 },
    offset: { kind: 'float', label: 'Offset', default: 0.85, min: 0, max: 1, step: 0.05 },
    sigma: { kind: 'float', label: 'Sigma', default: 6, min: 0.1, max: 100, step: 0.5 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'alma', title: 'ALMA', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const alma = ta.alma(inputs.length, inputs.offset, inputs.sigma);
    return (c) => c.set('alma', alma.update(c.src.source[c.i]!));
  },
});
