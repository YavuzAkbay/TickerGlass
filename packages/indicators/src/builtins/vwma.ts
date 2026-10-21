import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Volume-weighted moving average. */
export const VWMA = defineIndicator({
  id: 'vwma',
  name: 'Volume Weighted Moving Average',
  shortName: 'VWMA',
  category: 'movingAverage',
  keywords: ['ma', 'volume', 'weighted', 'average'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'vwma',
      title: 'VWMA',
      kind: 'line',
      color: COLOR.blue,
      offset: (inputs) => inputs.offset,
    },
  ],
  setup({ inputs, ta }) {
    const vwma = ta.vwma(inputs.length);
    return (c) => c.set('vwma', vwma.update(c.src.source[c.i]!, c.volume[c.i]!));
  },
});
