import { defineIndicator } from '../registry';
import { COLOR, trueRange } from './common';

/**
 * Choppiness Index: 100 * log10(sum of true range / (highest high - lowest
 * low)) / log10(length), over the last `length` bars.
 */
export const CHOP = defineIndicator({
  id: 'chop',
  name: 'Choppiness Index',
  shortName: 'CHOP',
  category: 'momentum',
  keywords: ['chop', 'choppiness', 'trend', 'range'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 2, max: 5000 },
    upperLevel: {
      kind: 'float',
      label: 'Upper Band',
      default: 61.8,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Lower Band',
      default: 38.2,
      group: 'Levels',
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'hline',
      id: 'upperBand',
      title: 'Upper Band',
      value: (inputs) => inputs.upperLevel,
      color: COLOR.level,
    },
    {
      type: 'hline',
      id: 'lowerBand',
      title: 'Lower Band',
      value: (inputs) => inputs.lowerLevel,
      color: COLOR.level,
    },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upperBand', 'lowerBand'],
      color: COLOR.blueFill,
    },
    { type: 'plot', id: 'chop', title: 'CHOP', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const n = inputs.length;
    const trSum = ta.sum(n);
    const hh = ta.highest(n);
    const ll = ta.lowest(n);
    const norm = Math.log10(n);
    return (c) => {
      const s = trSum.update(trueRange(c, true));
      const range = hh.update(c.high[c.i]!) - ll.update(c.low[c.i]!);
      c.set('chop', range === 0 ? NaN : (100 * Math.log10(s / range)) / norm);
    };
  },
});
