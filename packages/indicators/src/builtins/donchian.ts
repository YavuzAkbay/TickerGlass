import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Donchian Channels: highest high / lowest low over `length` bars and their mean. */
export const DONCHIAN = defineIndicator({
  id: 'donchian',
  name: 'Donchian Channels',
  shortName: 'DC',
  category: 'bands',
  keywords: ['dc', 'donchian', 'channels', 'breakout', 'highest', 'lowest'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    offset: { kind: 'int', label: 'Offset', default: 0, min: -500, max: 500, hideInTitle: true },
  },
  outputs: [
    {
      type: 'plot',
      id: 'basis',
      title: 'Basis',
      kind: 'line',
      color: COLOR.orange,
      offset: (inputs) => inputs.offset,
    },
    {
      type: 'plot',
      id: 'upper',
      title: 'Upper',
      kind: 'line',
      color: COLOR.blue,
      offset: (inputs) => inputs.offset,
    },
    {
      type: 'plot',
      id: 'lower',
      title: 'Lower',
      kind: 'line',
      color: COLOR.blue,
      offset: (inputs) => inputs.offset,
    },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upper', 'lower'],
      color: COLOR.blueFillLight,
    },
  ],
  setup({ inputs, ta }) {
    const hi = ta.highest(inputs.length);
    const lo = ta.lowest(inputs.length);
    return (c) => {
      const upper = hi.update(c.high[c.i]!);
      const lower = lo.update(c.low[c.i]!);
      c.set('basis', (upper + lower) / 2);
      c.set('upper', upper);
      c.set('lower', lower);
    };
  },
});
