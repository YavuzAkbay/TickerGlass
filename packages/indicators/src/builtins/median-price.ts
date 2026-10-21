import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Median price: (high + low) / 2. */
export const MEDIAN_PRICE = defineIndicator({
  id: 'median-price',
  name: 'Median Price',
  shortName: 'Median Price',
  category: 'other',
  keywords: ['median', 'hl2', 'price'],
  overlay: true,
  inputs: {},
  outputs: [{ type: 'plot', id: 'mp', title: 'Median Price', kind: 'line', color: COLOR.blue }],
  setup() {
    return (c) => c.set('mp', (c.high[c.i]! + c.low[c.i]!) / 2);
  },
});
