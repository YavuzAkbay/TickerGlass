import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Linearly weighted moving average. */
export const WMA = defineIndicator({
  id: 'wma',
  name: 'Moving Average Weighted',
  shortName: 'WMA',
  category: 'movingAverage',
  keywords: ['ma', 'weighted', 'average', 'lwma'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'wma',
      title: 'WMA',
      kind: 'line',
      color: COLOR.blue,
      offset: (inputs) => inputs.offset,
    },
  ],
  setup({ inputs, ta }) {
    const wma = ta.wma(inputs.length);
    return (c) => c.set('wma', wma.update(c.src.source[c.i]!));
  },
});
