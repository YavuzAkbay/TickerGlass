import { defineIndicator } from '../registry';
import { COLOR, change, movingAverage, rsiOf } from './common';

export const RSI_MA_TYPES = ['SMA', 'Bollinger Bands', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA'] as const;

/** Relative Strength Index with an RSI-based MA (optionally Bollinger Bands). */
export const RSI = defineIndicator({
  id: 'rsi',
  name: 'Relative Strength Index',
  shortName: 'RSI',
  category: 'momentum',
  keywords: ['rsi', 'relative strength', 'oscillator', 'overbought', 'oversold'],
  overlay: false,
  precision: 2,
  scaleRange: { min: 0, max: 100 },
  inputs: {
    length: {
      kind: 'int',
      label: 'RSI Length',
      default: 14,
      min: 1,
      max: 5000,
      group: 'RSI Settings',
    },
    source: { kind: 'source', label: 'Source', default: 'close', group: 'RSI Settings' },
    maType: {
      kind: 'enum',
      label: 'MA Type',
      options: RSI_MA_TYPES,
      default: 'SMA',
      group: 'MA Settings',
      hideInTitle: true,
    },
    maLength: {
      kind: 'int',
      label: 'MA Length',
      default: 14,
      min: 1,
      max: 5000,
      group: 'MA Settings',
      hideInTitle: true,
    },
    bbMult: {
      kind: 'float',
      label: 'BB StdDev',
      default: 2,
      min: 0.001,
      max: 50,
      step: 0.5,
      group: 'MA Settings',
      hideInTitle: true,
    },
    upperLevel: {
      kind: 'float',
      label: 'Upper Band',
      default: 70,
      group: 'Levels',
      hideInTitle: true,
    },
    lowerLevel: {
      kind: 'float',
      label: 'Lower Band',
      default: 30,
      group: 'Levels',
      hideInTitle: true,
    },
  },
  outputs: [
    {
      type: 'hline',
      id: 'upperBand',
      title: 'RSI Upper Band',
      value: (inputs) => inputs.upperLevel,
      color: COLOR.level,
    },
    {
      type: 'hline',
      id: 'middleBand',
      title: 'RSI Middle Band',
      value: 50,
      color: COLOR.levelMiddle,
    },
    {
      type: 'hline',
      id: 'lowerBand',
      title: 'RSI Lower Band',
      value: (inputs) => inputs.lowerLevel,
      color: COLOR.level,
    },
    {
      type: 'fill',
      id: 'background',
      title: 'RSI Background Fill',
      between: ['upperBand', 'lowerBand'],
      color: COLOR.purpleFill,
    },
    { type: 'plot', id: 'rsi', title: 'RSI', kind: 'line', color: COLOR.purple },
    { type: 'plot', id: 'ma', title: 'RSI-based MA', kind: 'line', color: COLOR.yellow },
    {
      type: 'plot',
      id: 'bbUpper',
      title: 'Upper Bollinger Band',
      kind: 'line',
      color: COLOR.green,
    },
    {
      type: 'plot',
      id: 'bbLower',
      title: 'Lower Bollinger Band',
      kind: 'line',
      color: COLOR.green,
    },
    {
      type: 'fill',
      id: 'bbBackground',
      title: 'Bollinger Bands Background Fill',
      between: ['bbUpper', 'bbLower'],
      color: 'rgba(76, 175, 80, 0.1)',
    },
  ],
  setup({ inputs, ta }) {
    const rsi = rsiOf(ta, inputs.length);
    const isBB = inputs.maType === 'Bollinger Bands';
    const maType = inputs.maType === 'Bollinger Bands' ? 'SMA' : inputs.maType;
    const ma = movingAverage(ta, maType, inputs.maLength);
    const sd = isBB ? ta.stdev(inputs.maLength) : null;
    return (c) => {
      const r = rsi.update(change(c.src.source, c.i));
      const m = ma.update(r, c.volume[c.i]!);
      c.set('rsi', r);
      c.set('ma', m);
      if (sd) {
        const dev = sd.update(r) * inputs.bbMult;
        c.set('bbUpper', m + dev);
        c.set('bbLower', m - dev);
      }
    };
  },
});
