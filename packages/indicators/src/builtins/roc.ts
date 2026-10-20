import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * ROC at bar i: 100 * (src - src[length]) / src[length]
 * (NaN before `length` bars or for a zero base). Used by Coppock and KST too.
 */
export function rocAt(src: Float64Array, i: number, length: number): number {
  if (i < length) return NaN;
  const base = src[i - length]!;
  return base === 0 ? NaN : (100 * (src[i]! - base)) / base;
}

/** Rate of Change in percent. */
export const ROC = defineIndicator({
  id: 'roc',
  name: 'Rate Of Change',
  shortName: 'ROC',
  category: 'momentum',
  keywords: ['roc', 'rate of change', 'momentum', 'oscillator'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 9, min: 1, max: 5000 },
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero Line', value: 0, color: COLOR.levelMiddle },
    { type: 'plot', id: 'roc', title: 'ROC', kind: 'line', color: COLOR.blue },
  ],
  setup({ inputs }) {
    return (c) => {
      c.set('roc', rocAt(c.src.source, c.i, inputs.length));
    };
  },
});
