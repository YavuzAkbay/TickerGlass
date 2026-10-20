import { defineIndicator } from '../registry';
import { COLOR, MA_TYPES, movingAverage } from './common';

/** Commodity Channel Index: (src - sma) / (0.015 * mean deviation), plus a smoothing line. */
export const CCI = defineIndicator({
  id: 'cci',
  name: 'Commodity Channel Index',
  shortName: 'CCI',
  category: 'momentum',
  keywords: ['cci', 'commodity channel', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'hlc3' },
    maType: {
      kind: 'enum',
      label: 'Method',
      options: MA_TYPES,
      default: 'SMA',
      group: 'Smoothing',
      hideInTitle: true,
    },
    maLength: {
      kind: 'int',
      label: 'Length',
      default: 14,
      min: 1,
      max: 5000,
      group: 'Smoothing',
      hideInTitle: true,
    },
    upperLevel: {
      kind: 'float',
      label: 'Upper Band',
      default: 100,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Lower Band',
      default: -100,
      group: 'Levels',
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'hline',
      id: 'upperBand',
      title: 'Upper Band',
      value: (inputs) => inputs.upperLevel,
      color: COLOR.level,
    },
    { type: 'hline', id: 'middleBand', title: 'Middle Band', value: 0, color: COLOR.levelMiddle },
    {
      type: 'hline',
      id: 'lowerBand',
      title: 'Lower Band',
      value: (inputs) => inputs.lowerLevel,
      color: COLOR.level,
    },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upperBand', 'lowerBand'],
      color: COLOR.blueFill,
    },
    { type: 'plot', id: 'cci', title: 'CCI', kind: 'line', color: COLOR.blue },
    {
      type: 'plot',
      id: 'ma',
      title: 'Smoothing Line',
      kind: 'line',
      color: '#f2a93b',
      visible: false,
    },
  ],
  setup({ inputs, ta }) {
    const sma = ta.sma(inputs.length);
    const dev = ta.dev(inputs.length);
    const ma = movingAverage(ta, inputs.maType, inputs.maLength);
    return (c) => {
      const x = c.src.source[c.i]!;
      const cci = (x - sma.update(x)) / (0.015 * dev.update(x));
      c.set('cci', cci);
      c.set('ma', ma.update(cci, c.volume[c.i]!));
    };
  },
});
