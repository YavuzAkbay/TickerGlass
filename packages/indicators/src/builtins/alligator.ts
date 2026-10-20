import { defineIndicator } from '../registry';

/**
 * Williams Alligator: smoothed MAs (RMA) of the source drawn shifted forward
 * by their offsets (jaw, teeth, lips).
 */
export const ALLIGATOR = defineIndicator({
  id: 'alligator',
  name: 'Williams Alligator',
  shortName: 'Alligator',
  category: 'trend',
  keywords: ['alligator', 'williams', 'jaw', 'teeth', 'lips', 'smma'],
  overlay: true,
  inputs: {
    jawLength: { kind: 'int', label: 'Jaw Length', default: 13, min: 1, max: 5000 },
    teethLength: { kind: 'int', label: 'Teeth Length', default: 8, min: 1, max: 5000 },
    lipsLength: { kind: 'int', label: 'Lips Length', default: 5, min: 1, max: 5000 },
    jawOffset: { kind: 'int', label: 'Jaw Offset', default: 8, min: -500, max: 500 },
    teethOffset: { kind: 'int', label: 'Teeth Offset', default: 5, min: -500, max: 500 },
    lipsOffset: { kind: 'int', label: 'Lips Offset', default: 3, min: -500, max: 500 },
    source: { kind: 'source', label: 'Source', default: 'hl2' },
  },
  outputs: [
    {
      type: 'plot',
      id: 'jaw',
      title: 'Jaw',
      kind: 'line',
      color: '#4f6bed',
      offset: (inputs) => inputs.jawOffset,
    },
    {
      type: 'plot',
      id: 'teeth',
      title: 'Teeth',
      kind: 'line',
      color: '#e8618c',
      offset: (inputs) => inputs.teethOffset,
    },
    {
      type: 'plot',
      id: 'lips',
      title: 'Lips',
      kind: 'line',
      color: '#8bc34a',
      offset: (inputs) => inputs.lipsOffset,
    },
  ],
  setup({ inputs, ta }) {
    const jaw = ta.rma(inputs.jawLength);
    const teeth = ta.rma(inputs.teethLength);
    const lips = ta.rma(inputs.lipsLength);
    return (c) => {
      const x = c.src.source[c.i]!;
      c.set('jaw', jaw.update(x));
      c.set('teeth', teeth.update(x));
      c.set('lips', lips.update(x));
    };
  },
});
