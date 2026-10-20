import { defineIndicator } from '../registry';
import { COLOR } from './common';

/** Bars back of the DPO comparison: floor(period / 2) + 1. */
function barsBack(period: number): number {
  return Math.floor(period / 2) + 1;
}

/**
 * Detrended Price Oscillator. Not centered: close - sma[barsBack]. Centered:
 * close[barsBack] - sma, drawn barsBack bars to the left.
 */
export const DPO = defineIndicator({
  id: 'dpo',
  name: 'Detrended Price Oscillator',
  shortName: 'DPO',
  category: 'momentum',
  keywords: ['dpo', 'detrended', 'price oscillator', 'cycle'],
  overlay: false,
  inputs: {
    length: { kind: 'int', label: 'Period', default: 21, min: 1, max: 5000 },
    centered: { kind: 'bool', label: 'Centered', default: false },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.level },
    {
      type: 'plot',
      id: 'dpo',
      title: 'Detrended Price Oscillator',
      kind: 'line',
      color: '#18a383',
      offset: (inputs) => (inputs.centered ? -barsBack(inputs.length) : 0),
    },
  ],
  setup({ inputs, ta }) {
    const back = barsBack(inputs.length);
    const ma = ta.sma(inputs.length);
    const pastMa = ta.history(back + 1);
    return (c) => {
      const i = c.i;
      const m = ma.update(c.close[i]!);
      pastMa.push(m);
      const v = inputs.centered
        ? (i >= back ? c.close[i - back]! : NaN) - m
        : c.close[i]! - pastMa.get(back);
      c.set('dpo', v);
    };
  },
});
