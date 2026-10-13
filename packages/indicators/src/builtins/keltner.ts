import { defineIndicator } from '../registry';
import { COLOR, trueRange } from './common';

export const KELTNER_BAND_STYLES = ['Average True Range', 'True Range', 'Range'] as const;

/** Keltner Channels: EMA/SMA basis +- mult * (ATR | TR | RMA of high-low). */
export const KELTNER = defineIndicator({
  id: 'keltner',
  name: 'Keltner Channels',
  shortName: 'KC',
  category: 'bands',
  keywords: ['kc', 'keltner', 'channels', 'atr', 'volatility'],
  overlay: true,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 20, min: 1, max: 5000 },
    mult: { kind: 'float', label: 'Multiplier', default: 2, min: 0, step: 0.1 },
    source: { kind: 'source', label: 'Source', default: 'close' },
    useEma: { kind: 'bool', label: 'Use Exponential MA', default: true, hideInTitle: true },
    bandStyle: {
      kind: 'enum',
      label: 'Bands Style',
      options: KELTNER_BAND_STYLES,
      default: 'Average True Range',
    },
    atrLength: { kind: 'int', label: 'ATR Length', default: 10, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'plot', id: 'upper', title: 'Upper', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'basis', title: 'Basis', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'lower', title: 'Lower', kind: 'line', color: COLOR.blue },
    {
      type: 'fill',
      id: 'background',
      title: 'Background',
      between: ['upper', 'lower'],
      color: COLOR.blueFillLight,
    },
  ],
  setup({ inputs, ta }) {
    const ma = inputs.useEma ? ta.ema(inputs.length) : ta.sma(inputs.length);
    const style = inputs.bandStyle;
    // ATR (rma of TR) or rma of high - low; unused for 'True Range'.
    const range = ta.rma(style === 'Range' ? inputs.length : inputs.atrLength);
    return (c) => {
      const basis = ma.update(c.src.source[c.i]!);
      const width =
        style === 'Range'
          ? range.update(c.high[c.i]! - c.low[c.i]!)
          : style === 'True Range'
            ? trueRange(c, true)
            : range.update(trueRange(c, true));
      c.set('upper', basis + width * inputs.mult);
      c.set('basis', basis);
      c.set('lower', basis - width * inputs.mult);
    };
  },
});
