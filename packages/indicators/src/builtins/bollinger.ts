import { defineIndicator } from '../registry';
import { COLOR, MA_TYPES, movingAverage } from './common';

/** Bollinger Bands: MA basis +- mult * population stdev of the source. */
export const BOLLINGER = defineIndicator({
  id: 'bollinger',
  name: 'Bollinger Bands',
  shortName: 'BB',
  category: 'bands',
  keywords: ['bb', 'bollinger', 'bands', 'volatility', 'stdev'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    maType: { kind: 'enum', label: 'Basis MA Type', options: MA_TYPES, default: 'SMA' },
    source: { kind: 'source', label: 'Source', default: 'close' },
    mult: { kind: 'float', label: 'StdDev', default: 2, min: 0.001, max: 50, step: 0.1 },
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
    const ma = movingAverage(ta, inputs.maType, inputs.length);
    const sd = ta.stdev(inputs.length);
    return (c) => {
      const x = c.src.source[c.i]!;
      const basis = ma.update(x, c.volume[c.i]!);
      const dev = inputs.mult * sd.update(x);
      c.set('basis', basis);
      c.set('upper', basis + dev);
      c.set('lower', basis - dev);
    };
  },
});
