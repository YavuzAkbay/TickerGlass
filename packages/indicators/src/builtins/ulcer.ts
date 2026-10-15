import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Ulcer Index: root mean square of the percent drawdown from the rolling high. */
export const ULCER = defineIndicator({
  id: 'ulcer',
  name: 'Ulcer Index',
  shortName: 'Ulcer Index',
  category: 'volatility',
  keywords: ['ulcer', 'drawdown', 'volatility', 'risk'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'ulcer', title: 'Ulcer Index', kind: 'line', color: COLOR.blue }],
  setup({ inputs, ta }) {
    const hh = ta.highest(inputs.length);
    const meanSq = ta.sma(inputs.length);
    return (c) => {
      const x = c.src.source[c.i]!;
      const h = hh.update(x);
      const dd = h === 0 ? NaN : (100 * (x - h)) / h;
      c.set('ulcer', Math.sqrt(meanSq.update(dd * dd)));
    };
  },
});
