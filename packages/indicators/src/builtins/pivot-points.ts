import { defineIndicator } from '../registry';

/** Order of the "Type" options. */
const PIVOT_TYPES = ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'DM', 'Camarilla'] as const;
type PivotType = (typeof PIVOT_TYPES)[number];
const PIVOT_COLOR = '#E0A93B';

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

/** Previous period's open/high/low/close and the current period's open. */
interface PeriodPrices {
  o: number;
  h: number;
  l: number;
  c: number;
  oCur: number;
}

/** Levels a type defines; the others stay NaN. */
type Levels = Partial<Record<Level, number>>;

function pivotLevels(type: PivotType, { o, h, l, c, oCur }: PeriodPrices): Levels {
  const r = h - l;
  switch (type) {
    case 'Traditional': {
      const p = (h + l + c) / 3;
      return {
        p,
        r1: 2 * p - l,
        s1: 2 * p - h,
        r2: p + r,
        s2: p - r,
        r3: 2 * p + (h - 2 * l),
        s3: 2 * p - (2 * h - l),
        r4: 3 * p + (h - 3 * l),
        s4: 3 * p - (3 * h - l),
        r5: 4 * p + (h - 4 * l),
        s5: 4 * p - (4 * h - l),
      };
    }
    case 'Fibonacci': {
      const p = (h + l + c) / 3;
      return {
        p,
        r1: p + 0.382 * r,
        s1: p - 0.382 * r,
        r2: p + 0.618 * r,
        s2: p - 0.618 * r,
        r3: p + r,
        s3: p - r,
      };
    }
    case 'Woodie': {
      // The open used is that of the period the levels are drawn in.
      const p = (h + l + 2 * oCur) / 4;
      const r3 = h + 2 * (p - l);
      const s3 = l - 2 * (h - p);
      return {
        p,
        r1: 2 * p - l,
        s1: 2 * p - h,
        r2: p + r,
        s2: p - r,
        r3,
        s3,
        r4: r3 + r,
        s4: s3 - r,
      };
    }
    case 'Classic': {
      const p = (h + l + c) / 3;
      return {
        p,
        r1: 2 * p - l,
        s1: 2 * p - h,
        r2: p + r,
        s2: p - r,
        r3: p + 2 * r,
        s3: p - 2 * r,
        r4: p + 3 * r,
        s4: p - 3 * r,
      };
    }
    case 'DM': {
      const x = c < o ? h + 2 * l + c : c > o ? 2 * h + l + c : h + l + 2 * c;
      return { p: x / 4, r1: x / 2 - l, s1: x / 2 - h };
    }
    case 'Camarilla': {
      const r5 = (h / l) * c;
      return {
        p: (h + l + c) / 3,
        r1: c + (1.1 * r) / 12,
        s1: c - (1.1 * r) / 12,
        r2: c + (1.1 * r) / 6,
        s2: c - (1.1 * r) / 6,
        r3: c + (1.1 * r) / 4,
        s3: c - (1.1 * r) / 4,
        r4: c + (1.1 * r) / 2,
        s4: c - (1.1 * r) / 2,
        r5,
        s5: c - (r5 - c),
      };
    }
  }
}

/**
 * Pivot Points (Traditional, Fibonacci, Woodie, Classic, DM,
 * Camarilla). Runs on the `timeframe` series (the host resolves 'auto':
 * intraday -> 1D, 1D -> 1W, above -> 12M): each timeframe bar gets the levels
 * of the previous one, so every chart bar shows the pivots of the period
 * before the one containing it (Woodie also uses the current period's open).
 * Levels a type does not define are NaN.
 */
export const PIVOT_POINTS = defineIndicator({
  id: 'pivot-points',
  name: 'Pivot Points',
  shortName: 'Pivots',
  category: 'other',
  keywords: [
    'pivot',
    'pivots',
    'support',
    'resistance',
    'traditional',
    'floor',
    'fibonacci',
    'woodie',
    'classic',
    'dm',
    'demark',
    'camarilla',
  ],
  overlay: true,
  inputs: {
    type: { kind: 'enum', label: 'Type', options: PIVOT_TYPES, default: 'Traditional' },
    timeframe: { kind: 'timeframe', label: 'Pivots Timeframe', default: 'auto' },
  },
  outputs: LEVELS.map(level),
  setup({ inputs }) {
    const type = inputs.type;
    return (c) => {
      const i = c.i;
      if (i === 0) return;
      const lv = pivotLevels(type, {
        o: c.open[i - 1]!,
        h: c.high[i - 1]!,
        l: c.low[i - 1]!,
        c: c.close[i - 1]!,
        oCur: c.open[i]!,
      });
      for (const id of LEVELS) {
        const v = lv[id];
        if (v !== undefined) c.set(id, v);
      }
    };
  },
});
