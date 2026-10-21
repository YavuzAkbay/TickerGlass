import { defineIndicator } from '../registry';
import { COLOR, change, trueRange } from './common';

/** Directional Movement Index: +DI, -DI and ADX (Wilder smoothing). */
export const DMI = defineIndicator({
  id: 'dmi',
  name: 'Directional Movement Index',
  shortName: 'DMI',
  category: 'trend',
  keywords: ['dmi', 'adx', 'average directional index', 'di', 'directional movement'],
  overlay: false,
  precision: 4,
  inputs: {
    adxSmoothing: { kind: 'int', label: 'ADX Smoothing', default: 14, min: 1, max: 50 },
    diLength: { kind: 'int', label: 'DI Length', default: 14, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'plot', id: 'adx', title: 'ADX', kind: 'line', color: COLOR.pink },
    { type: 'plot', id: 'plusDi', title: '+DI', kind: 'line', color: COLOR.blue },
    { type: 'plot', id: 'minusDi', title: '-DI', kind: 'line', color: COLOR.orange },
  ],
  setup({ inputs, ta }) {
    const n = inputs.diLength;
    const tr = ta.rma(n);
    const plusRma = ta.rma(n);
    const minusRma = ta.rma(n);
    const adx = ta.rma(inputs.adxSmoothing);
    // Carry forward the last non-NaN DI values.
    const last = ta.vars({ plus: NaN, minus: NaN });
    return (c) => {
      const up = change(c.high, c.i);
      const down = -change(c.low, c.i);
      const plusDm = Number.isNaN(up) ? NaN : up > down && up > 0 ? up : 0;
      const minusDm = Number.isNaN(down) ? NaN : down > up && down > 0 ? down : 0;
      const trur = tr.update(trueRange(c, false));
      let plus = (100 * plusRma.update(plusDm)) / trur;
      let minus = (100 * minusRma.update(minusDm)) / trur;
      if (Number.isNaN(plus)) plus = last.plus;
      else last.plus = plus;
      if (Number.isNaN(minus)) minus = last.minus;
      else last.minus = minus;
      const sum = plus + minus;
      c.set('adx', 100 * adx.update(Math.abs(plus - minus) / (sum === 0 ? 1 : sum)));
      c.set('plusDi', plus);
      c.set('minusDi', minus);
    };
  },
});
