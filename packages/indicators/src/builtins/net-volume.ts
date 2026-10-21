import { defineIndicator } from '../registry';
import { COLOR, change } from './common';

/** Net Volume: +volume on an up bar of the source, -volume on a down bar, 0 otherwise (and on the first bar). */
export const NET_VOLUME = defineIndicator({
  id: 'net-volume',
  name: 'Net Volume',
  shortName: 'Net Volume',
  category: 'volume',
  keywords: ['net volume', 'volume', 'signed volume'],
  overlay: false,
  format: 'volume',
  inputs: {
    source: { kind: 'source', label: 'Source', default: 'close' },
  },
  outputs: [{ type: 'plot', id: 'nv', title: 'Net Volume', kind: 'line', color: COLOR.blue }],
  setup() {
    return (c) => {
      const ch = change(c.src.source, c.i);
      const v = c.volume[c.i]!;
      c.set('nv', ch > 0 ? v : ch < 0 ? -v : 0 * v);
    };
  },
});
