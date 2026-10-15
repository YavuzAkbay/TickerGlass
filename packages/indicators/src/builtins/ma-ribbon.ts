import { defineIndicator } from '../registry';
import { MA_TYPES, movingAverage } from './common';

const group = (k: number) => `MA #${k}`;

/** Moving Average Ribbon: four independently configured moving averages. */
export const MA_RIBBON = defineIndicator({
  id: 'ma-ribbon',
  name: 'Moving Average Ribbon',
  shortName: 'MA Ribbon',
  category: 'movingAverage',
  keywords: ['ma', 'ribbon', 'moving averages', 'average'],
  overlay: true,
  inputs: {
    type1: {
      kind: 'enum',
      label: 'Type',
      options: MA_TYPES,
      default: 'SMA',
      group: group(1),
      inline: 'ma1',
    },
    source1: { kind: 'source', label: 'Source', default: 'close', group: group(1), inline: 'ma1' },
    length1: {
      kind: 'int',
      label: 'Length',
      default: 20,
      min: 1,
      max: 5000,
      group: group(1),
      inline: 'ma1',
    },
    type2: {
      kind: 'enum',
      label: 'Type',
      options: MA_TYPES,
      default: 'SMA',
      group: group(2),
      inline: 'ma2',
    },
    source2: { kind: 'source', label: 'Source', default: 'close', group: group(2), inline: 'ma2' },
    length2: {
      kind: 'int',
      label: 'Length',
      default: 50,
      min: 1,
      max: 5000,
      group: group(2),
      inline: 'ma2',
    },
    type3: {
      kind: 'enum',
      label: 'Type',
      options: MA_TYPES,
      default: 'SMA',
      group: group(3),
      inline: 'ma3',
    },
    source3: { kind: 'source', label: 'Source', default: 'close', group: group(3), inline: 'ma3' },
    length3: {
      kind: 'int',
      label: 'Length',
      default: 100,
      min: 1,
      max: 5000,
      group: group(3),
      inline: 'ma3',
    },
    type4: {
      kind: 'enum',
      label: 'Type',
      options: MA_TYPES,
      default: 'SMA',
      group: group(4),
      inline: 'ma4',
    },
    source4: { kind: 'source', label: 'Source', default: 'close', group: group(4), inline: 'ma4' },
    length4: {
      kind: 'int',
      label: 'Length',
      default: 200,
      min: 1,
      max: 5000,
      group: group(4),
      inline: 'ma4',
    },
  },
  outputs: [
    { type: 'plot', id: 'ma1', title: 'MA #1', kind: 'line', color: '#f6c309' },
    { type: 'plot', id: 'ma2', title: 'MA #2', kind: 'line', color: '#fb9800' },
    { type: 'plot', id: 'ma3', title: 'MA #3', kind: 'line', color: '#fb6500' },
    { type: 'plot', id: 'ma4', title: 'MA #4', kind: 'line', color: '#f60c0c' },
  ],
  setup({ inputs, ta }) {
    const ma1 = movingAverage(ta, inputs.type1, inputs.length1);
    const ma2 = movingAverage(ta, inputs.type2, inputs.length2);
    const ma3 = movingAverage(ta, inputs.type3, inputs.length3);
    const ma4 = movingAverage(ta, inputs.type4, inputs.length4);
    return (c) => {
      const v = c.volume[c.i]!;
      c.set('ma1', ma1.update(c.src.source1[c.i]!, v));
      c.set('ma2', ma2.update(c.src.source2[c.i]!, v));
      c.set('ma3', ma3.update(c.src.source3[c.i]!, v));
      c.set('ma4', ma4.update(c.src.source4[c.i]!, v));
    };
  },
});
