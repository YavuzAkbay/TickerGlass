import { defineIndicator } from '../registry';

/** Exponential moving average, seeded with the SMA of the first `length` values. */
export const EMA = defineIndicator({
  id: 'ema',
  name: 'Moving Average Exponential',
  shortName: 'EMA',
  category: 'movingAverage',
  keywords: ['ma', 'exponential', 'average'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'ema',
      title: 'EMA',
      kind: 'line',
      color: '#2962ff',
      offset: (inputs) => inputs.offset,
    },
  ],
  setup({ inputs, ta }) {
    const ema = ta.ema(inputs.length);
    return (c) => c.set('ema', ema.update(c.src.source[c.i]!));
  },
});
