import type { GroupFixtures } from './types';

/**
 * incremental.test.ts overrides for the volume group (batch B5), keyed by
 * indicator id; ids without an entry use the defaults (see ./types).
 */
export const VOLUME_GROUP_FIXTURES: GroupFixtures = {
  // The default 400 15m bars span ~4 sessions: compare with the previous 2.
  'tod-relative-volume': { context: { intervalSeconds: 900 }, inputs: { length: 2 } },
};
