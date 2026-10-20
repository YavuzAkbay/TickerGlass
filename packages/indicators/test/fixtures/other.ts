import { randomBars } from '../../src/test-utils';
import type { GroupFixtures } from './types';

/**
 * incremental.test.ts overrides for the other group (batch B6), keyed by
 * indicator id; ids without an entry use the defaults (see ./types).
 */
export const OTHER_FIXTURES: GroupFixtures = {
  // Pivot labels sit on the confirming bar only; the last bar is usually NaN.
  'pivots-hl': { sparse: true },
  // Price labels only at pivots (the line itself reaches the last bar).
  zigzag: { sparse: true },
  // Daily and longer bars only; ~4 years so the multi-year average exists.
  seasonality: {
    bars: randomBars(1500, 3, 1_546_387_200, 86_400),
    context: { intervalSeconds: 86_400 },
  },
  // Engine-side profile: the values array is unused.
  'vp-visible': { noValues: true },
  // Session starts only.
  'vp-session': { sparse: true },
};
