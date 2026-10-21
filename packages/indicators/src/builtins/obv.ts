import { defineIndicator } from '../registry';
import { COLOR, MA_TYPES, change, movingAverage } from './common';

/** Smoothing types of OBV (and other volume built-ins). */
export const OBV_SMOOTHING = [
  'None',
  'SMA',
  'SMA + Bollinger Bands',
  ...MA_TYPES.slice(1),
] as const;

const GROUP = 'Smoothing';

/**
 * On Balance Volume: cumulative sign(change(src)) * volume. Starts at 0 on the
 * first bar (running total of NaN); TA-Lib starts at the first bar's volume.
 * Optional smoothing MA of OBV (with Bollinger Bands around an SMA), as is common.
 */
export const OBV = defineIndicator({
  id: 'obv',
  name: 'On Balance Volume',
  shortName: 'OBV',
  category: 'volume',
  keywords: ['obv', 'on balance volume', 'volume', 'accumulation'],
  overlay: false,
  format: 'volume',
  inputs: {
    source: { kind: 'source', label: 'Source', default: 'close' },
    maType: {
      kind: 'enum',
      label: 'Type',
      options: OBV_SMOOTHING,
      default: 'None',
      group: GROUP,
      hideInTitle: true,
    },
    maLength: {
      kind: 'int',
      label: 'Length',
      default: 14,
      min: 1,
      max: 5000,
      group: GROUP,
      hideInTitle: true,
    },
    bbMult: {
      kind: 'float',
      label: 'BB StdDev',
      default: 2,
      min: 0.001,
      max: 50,
      step: 0.5,
      group: GROUP,
      hideInTitle: true,
    },
  },
  outputs: [
    { type: 'plot', id: 'obv', title: 'OnBalanceVolume', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'ma', title: 'Smoothing', kind: 'line', color: COLOR.yellow },
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
      color: 'rgba(139, 195, 74, 0.1)',
    },
  ],
  setup({ inputs, ta }) {
    const st = ta.vars({ total: 0 });
    const type = inputs.maType;
    const ma =
      type === 'None'
        ? null
        : movingAverage(ta, type === 'SMA + Bollinger Bands' ? 'SMA' : type, inputs.maLength);
    const sd = type === 'SMA + Bollinger Bands' ? ta.stdev(inputs.maLength) : null;
    return (c) => {
      const ch = change(c.src.source, c.i);
      const v = Math.sign(ch) * c.volume[c.i]!;
      if (!Number.isNaN(v)) st.total += v;
      c.set('obv', st.total);
      if (!ma) return;
      const m = ma.update(st.total, c.volume[c.i]!);
      c.set('ma', m);
      if (sd) {
        const dev = sd.update(st.total) * inputs.bbMult;
        c.set('bbUpper', m + dev);
        c.set('bbLower', m - dev);
      }
    };
  },
});
