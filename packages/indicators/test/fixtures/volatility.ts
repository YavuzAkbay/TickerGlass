import { randomBars } from '../../src/test-utils';
import type { GroupFixtures } from './types';

/**
 * incremental.test.ts overrides for the volatility group (batch B4), keyed by
 * indicator id; ids without an entry use the defaults (see ./types).
 */
export const VOLATILITY_FIXTURES: GroupFixtures = {
  // The annualisation factor depends on the bar interval: run it on daily bars.
  hv: { bars: randomBars(400, 3, 1_546_387_200, 86_400), context: { intervalSeconds: 86_400 } },
};
