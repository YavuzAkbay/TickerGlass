import { defineIndicator } from '../registry';
import { COLOR } from './common';

/**
 * Pivots High/Low: a high strictly above the `left` highs before it and the
 * `right` highs after it (standard `ta.pivothigh`), labelled with its price; lows
 * mirror. The value is written on the bar that confirms the pivot (`right`
 * bars later) and drawn back on the pivot bar through the shape offset, so
 * nothing repaints.
 */
export const PIVOTS_HL = defineIndicator({
  id: 'pivots-hl',
  name: 'Pivots High Low',
  shortName: 'Pivots HL',
  category: 'other',
  keywords: ['pivot', 'pivots', 'high', 'low', 'swing', 'fractal'],
  overlay: true,
  inputs: {
    leftHigh: { kind: 'int', label: 'Pivot High Left', default: 10, min: 1, max: 500, group: 'Pivot High', inline: 'h' },
    rightHigh: { kind: 'int', label: 'Right', default: 10, min: 1, max: 500, group: 'Pivot High', inline: 'h' },
    leftLow: { kind: 'int', label: 'Pivot Low Left', default: 10, min: 1, max: 500, group: 'Pivot Low', inline: 'l' },
    rightLow: { kind: 'int', label: 'Right', default: 10, min: 1, max: 500, group: 'Pivot Low', inline: 'l' },
  },
  outputs: [
    {
      type: 'shape',
      id: 'ph',
      title: 'Pivot High',
      shape: 'labelDown',
      location: 'aboveBar',
      color: COLOR.brightRed,
      textColor: '#ffffff',
      textFromValue: true,
      offset: (inputs) => -inputs.rightHigh,
    },
    {
      type: 'shape',
      id: 'pl',
      title: 'Pivot Low',
      shape: 'labelUp',
      location: 'belowBar',
      color: COLOR.green,
      textColor: '#ffffff',
      textFromValue: true,
      offset: (inputs) => -inputs.rightLow,
    },
  ],
  setup({ inputs, ta }) {
    const ph = ta.pivotHigh(inputs.leftHigh, inputs.rightHigh);
    const pl = ta.pivotLow(inputs.leftLow, inputs.rightLow);
    return (c) => {
      c.set('ph', ph.update(c.high[c.i]!));
      c.set('pl', pl.update(c.low[c.i]!));
    };
  },
});
