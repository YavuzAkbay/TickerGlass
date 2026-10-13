import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Williams %R: 100 * (src - highest high) / (highest high - lowest low). */
export const WILLIAMS_R = defineIndicator({
  id: 'williams-r',
  name: 'Williams %R',
  shortName: '%R',
  category: 'momentum',
  keywords: ['williams', '%r', 'percent range', 'oscillator'],
  overlay: false,
  precision: 2,
  scaleRange: { min: -100, max: 0 },
  inputs: {
    length: { kind: 'int', label: 'Length', default: 14, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    upperLevel: {
      kind: 'float',
      label: 'Upper Band',
      default: -20,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Lower Band',
      default: -80,
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
    {
      type: 'hline',
      id: 'middleBand',
      title: 'Middle Level',
      value: -50,
      color: COLOR.levelMiddle,
    },
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
      color: COLOR.purpleFill,
    },
    { type: 'plot', id: 'r', title: '%R', kind: 'line', color: COLOR.purple },
  ],
  setup({ inputs, ta }) {
    const hi = ta.highest(inputs.length);
    const lo = ta.lowest(inputs.length);
    return (c) => {
      const max = hi.update(c.high[c.i]!);
      const min = lo.update(c.low[c.i]!);
      c.set('r', (100 * (c.src.source[c.i]! - max)) / (max - min));
    };
  },
});
