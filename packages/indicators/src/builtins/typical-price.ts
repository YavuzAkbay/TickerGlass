import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Typical price: (high + low + close) / 3. */
export const TYPICAL_PRICE = defineIndicator({
  id: 'typical-price',
  name: 'Typical Price',
  shortName: 'Typical Price',
  category: 'other',
  keywords: ['typical', 'hlc3', 'price'],
  overlay: true,
  inputs: {},
  outputs: [{ type: 'plot', id: 'tp', title: 'Typical Price', kind: 'line', color: COLOR.blue }],
  setup() {
    return (c) => c.set('tp', (c.high[c.i]! + c.low[c.i]! + c.close[c.i]!) / 3);
  },
});
