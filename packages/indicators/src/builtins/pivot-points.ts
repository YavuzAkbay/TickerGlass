import { defineIndicator } from '../registry';

const PIVOT_TYPES = ['Traditional'] as const;
const PIVOT_COLOR = '#fb8c00';

const LEVELS = ['p', 'r1', 's1', 'r2', 's2', 'r3', 's3', 'r4', 's4', 'r5', 's5'] as const;
type Level = (typeof LEVELS)[number];

const level = (id: Level) =>
  ({
    type: 'plot',
    id,
    title: id.toUpperCase(),
    kind: 'step',
    color: PIVOT_COLOR,
    showLastValue: false,
  }) as const;

/**
 * Pivot Points Standard (Traditional). Runs on the `timeframe` series (the
 * host resolves 'auto': intraday -> 1D, 1D -> 1W, above -> 12M): each
 * timeframe bar gets the levels of the previous one, so every chart bar shows
 * the pivots of the period before the one containing it.
 */
export const PIVOT_POINTS = defineIndicator({
  id: 'pivot-points',
  name: 'Pivot Points Standard',
  shortName: 'Pivots',
  category: 'other',
  keywords: ['pivot', 'pivots', 'support', 'resistance', 'traditional', 'floor'],
  overlay: true,
  inputs: {
    type: { kind: 'enum', label: 'Type', options: PIVOT_TYPES, default: 'Traditional' },
    timeframe: { kind: 'timeframe', label: 'Pivots Timeframe', default: 'auto' },
  },
  outputs: LEVELS.map(level),
  setup() {
    return (c) => {
      const i = c.i;
      if (i === 0) return;
      const h = c.high[i - 1]!;
      const l = c.low[i - 1]!;
      const p = (h + l + c.close[i - 1]!) / 3;
      const r = h - l;
      c.set('p', p);
      c.set('r1', 2 * p - l);
      c.set('s1', 2 * p - h);
      c.set('r2', p + r);
      c.set('s2', p - r);
      c.set('r3', 2 * p + (h - 2 * l));
      c.set('s3', 2 * p - (2 * h - l));
      c.set('r4', 3 * p + (h - 3 * l));
      c.set('s4', 3 * p - (3 * h - l));
      c.set('r5', 4 * p + (h - 4 * l));
      c.set('s5', 4 * p - (4 * h - l));
    };
  },
});
