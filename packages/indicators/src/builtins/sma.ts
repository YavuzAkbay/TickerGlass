import { defineIndicator } from '../registry';

/** Simple moving average. Reference example for the definition API. */
export const SMA = defineIndicator({
  id: 'sma',
  name: 'Simple Moving Average',
  shortName: 'SMA',
  category: 'movingAverage',
  keywords: ['ma', 'simple', 'average'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'ma',
      title: 'MA',
      kind: 'line',
      color: '#6E9BD6',
      offset: (inputs) => inputs.offset,
    },
  ],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.length);
    return (c) => c.set('ma', ma.update(c.src.source[c.i]!));
  },
});
