import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Standard Deviation (population) of the source over `length` bars. */
export const STDEV = defineIndicator({
  id: 'stdev',
  name: 'Standard Deviation',
  shortName: 'StdDev',
  category: 'volatility',
  keywords: ['stdev', 'standard deviation', 'sd', 'volatility'],
  overlay: false,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'sd', title: 'StdDev', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const sd = ta.stdev(inputs.length);
    return (c) => c.set('sd', sd.update(c.src.source[c.i]!));
  },
});
