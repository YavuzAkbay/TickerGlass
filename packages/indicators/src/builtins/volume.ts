import { defineIndicator } from '../registry';

/** Volume columns coloured by bar direction, with an optional moving average. */
export const VOLUME = defineIndicator({
  id: 'volume',
  name: 'Volume',
  shortName: 'Vol',
  category: 'volume',
  keywords: ['volume', 'vol', 'histogram'],
  overlay: false,
  format: 'volume',
  inputs: {
    maLength: { kind: 'int', label: 'MA Length', default: 20, min: 1, max: 5000 },
    prevClose: {
      kind: 'bool',
      label: 'Color based on previous close',
      default: false,
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'plot',
      id: 'volume',
      title: 'Volume',
      kind: 'columns',
      // 0: up (growing), 1: down (falling)
      color: ['rgba(38, 166, 154, 0.5)', 'rgba(239, 83, 80, 0.5)'],
    },
    {
      type: 'plot',
      id: 'ma',
      title: 'Volume MA',
      kind: 'line',
      color: '#2196f3',
      visible: false,
    },
  ],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.maLength);
    return (c) => {
      const i = c.i;
      const v = c.volume[i]!;
      const down = inputs.prevClose
        ? i > 0 && c.close[i - 1]! > c.close[i]!
        : c.open[i]! > c.close[i]!;
      c.set('volume', v, down ? 1 : 0);
      c.set('ma', ma.update(v));
    };
  },
});
