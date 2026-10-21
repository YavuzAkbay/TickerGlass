import { randomBars } from '../../src/test-utils';
import type { GroupFixtures } from './types';

/**
 * incremental.test.ts overrides for the external group (batch B7), keyed by
 * indicator id; ids without an entry use the defaults (see ./types).
 */
export const EXTERNAL_FIXTURES: GroupFixtures = {
  // The default 15m series (seed 7) against another random walk on the same times.
  correlation: { external: { GOOG: randomBars(400, 9, 1_700_000_000, 900) } },
};
