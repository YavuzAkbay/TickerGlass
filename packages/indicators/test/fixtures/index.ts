import { EXTERNAL_FIXTURES } from './external';
import { MOMENTUM_FIXTURES } from './momentum';
import { OTHER_FIXTURES } from './other';
import { TREND_MA_FIXTURES } from './trend-ma';
import type { GroupFixtures, IncrementalFixture } from './types';
import { VOLATILITY_FIXTURES } from './volatility';
import { VOLUME_GROUP_FIXTURES } from './volume';

export type { GroupFixtures, IncrementalFixture } from './types';

const GROUPS: readonly GroupFixtures[] = [
  TREND_MA_FIXTURES,
  MOMENTUM_FIXTURES,
  VOLATILITY_FIXTURES,
  VOLUME_GROUP_FIXTURES,
  OTHER_FIXTURES,
  EXTERNAL_FIXTURES,
];

/** Every group's fixtures by indicator id (an id may appear in one group only). */
export const FIXTURES: Readonly<Record<string, IncrementalFixture>> = (() => {
  const all: Record<string, IncrementalFixture> = {};
  for (const g of GROUPS)
    for (const [id, fx] of Object.entries(g)) {
      if (all[id]) throw new Error(`fixture for "${id}" is defined twice`);
      all[id] = fx;
    }
  return all;
})();
