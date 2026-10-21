import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/** Elder's Force Index: EMA of (close - close[1]) * volume. */
export const EFI = defineIndicator({
  id: 'efi',
  name: 'Elder Force Index',
  shortName: 'EFI',
  category: 'momentum',
  keywords: ['efi', 'elder', 'force index', 'volume'],
  overlay: false,
  format: 'volume',
  inputs: {
    length: { kind: 'int', label: 'Length', default: 13, min: 1, max: 5000 },
  },
  outputs: [
    { type: 'hline', id: 'zero', title: 'Zero', value: 0, color: COLOR.level },
    { type: 'plot', id: 'efi', title: 'Elder Force Index', kind: 'line', color: '#DE6A4F' },
  ],
  setup({ inputs, ta }) {
    const ema = ta.ema(inputs.length);
    return (c) => c.set('efi', ema.update(change(c.close, c.i) * c.volume[c.i]!));
  },
});
