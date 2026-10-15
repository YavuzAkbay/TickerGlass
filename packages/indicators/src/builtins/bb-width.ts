import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Bollinger BandWidth: 100 * (upper - lower) / basis (SMA basis, population
 * stdev), with its highest (expansion) and lowest (contraction) values.
 */
export const BB_WIDTH = defineIndicator({
  id: 'bb-width',
  name: 'Bollinger BandWidth',
  shortName: 'BBW',
  category: 'volatility',
  keywords: ['bb', 'bollinger', 'bandwidth', 'width', 'squeeze', 'bands'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    mult: { kind: 'float', label: 'StdDev', default: 2, min: 0.001, max: 50, step: 0.1 },
    expansionLength: {
      kind: 'int',
      label: 'Highest Expansion Length',
      default: 125,
      min: 1,
      max: 5000,
      hideInTitle: true,
    },
    contractionLength: {
      kind: 'int',
      label: 'Lowest Contraction Length',
      default: 125,
      min: 1,
      max: 5000,
      hideInTitle: true,
    },
  },
  outputs: [
    { type: 'plot', id: 'bbw', title: 'Bollinger BandWidth', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'exp', title: 'Highest Expansion', kind: 'line', color: '#f23645' },
    { type: 'plot', id: 'con', title: 'Lowest Contraction', kind: 'line', color: '#089981' },
  ],
  setup({ inputs, ta }) {
    const ma = ta.sma(inputs.length);
    const sd = ta.stdev(inputs.length);
    const hi = ta.highest(inputs.expansionLength);
    const lo = ta.lowest(inputs.contractionLength);
    return (c) => {
      const x = c.src.source[c.i]!;
      const basis = ma.update(x);
      const dev = inputs.mult * sd.update(x);
      const bbw = basis === 0 ? NaN : (100 * (basis + dev - (basis - dev))) / basis;
      c.set('bbw', bbw);
      c.set('exp', hi.update(bbw));
      c.set('con', lo.update(bbw));
    };
  },
});
