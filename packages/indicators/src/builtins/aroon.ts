import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Aroon: how recently (in percent of `length`) the highest high / lowest low
 * of the last length + 1 bars occurred. Ties pick the most recent bar.
 */
export const AROON = defineIndicator({
  id: 'aroon',
  name: 'Aroon',
  shortName: 'Aroon',
  category: 'momentum',
  keywords: ['aroon', 'up', 'down', 'trend'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'plot', id: 'up', title: 'Aroon Up', kind: 'line', color: COLOR.orange },
    { type: 'plot', id: 'down', title: 'Aroon Down', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs, ta }) {
    const n = inputs.length;
    const hiBars = ta.highestBars(n + 1);
    const loBars = ta.lowestBars(n + 1);
    return (c) => {
      c.set('up', (100 * (hiBars.update(c.high[c.i]!) + n)) / n);
      c.set('down', (100 * (loBars.update(c.low[c.i]!) + n)) / n);
    };
  },
});
